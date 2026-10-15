// Slice views: three 2D panes (xy / xz / yz) next to the kiln 3D view.
//
//   server (planes) -> PlaneClient -> SliceRenderer (WebGPU, one texture per pane)
//                         ^                 ^
//                         |                 +-- drawn on demand, never in a free-running loop
//   SliceState (cursor, views, window, layout) <-- pointer / wheel / keyboard input
//
// Every pane reads the same SliceState: clicking in one pane moves the cursor, and the
// others re-request their plane and move their crosshair lines.

import { PlaneClient, prefetchIndices } from "./plane-client.js";
import { SliceRenderer, requestSliceDevice } from "./slice-renderer.js";
import { SliceState } from "./cursor.js";
import { buildLut, isGrayRamp } from "./transfer-function.js";
import { Overlay3D } from "./overlay-3d.js";
import {
  AXES, AXIS_INFO, AXIS_COLORS, clamp, cursorInPlane, dragWindow, panePpv, planeExtents,
  planeIndex, planeToPixel, pixelToPlane, textureFormatFor, zoomAt,
} from "./geometry.js";

const NS = "http://www.w3.org/2000/svg";
const UNIT_LABEL = { micrometer: "\u00b5m", millimeter: "mm", nanometer: "nm", centimeter: "cm", meter: "m" };
const PREVIEW_MIN_PIXELS = 512 * 512; // smaller planes are cheap enough to always fetch in full

function fmtPos(mm, unit) {
  const label = UNIT_LABEL[unit] ?? unit ?? "";
  return `${+mm.toPrecision(4)}${label ? ` ${label}` : ""}`;
}

// ------------------------------------------------------------------------- pane

class Pane {
  constructor(views, axis, el) {
    this.views = views;
    this.axis = axis;
    this.el = el;
    this.visible = false;
    this.shownKey = null;
    this.pendingKey = null;
    this.abort = null;
    this.plane = null; // last uploaded plane (for the value read-out)
    this.size = { width: 1, height: 1, dpr: 1 };
    this.drag = null;
    this.wheelAcc = 0;
    this.lastDir = 1;
    this.error = null;
    this.busyTimer = null;
    this.lastStats = { fetchMs: 0, source: "" };

    const info = AXIS_INFO[axis];
    el.classList.add("slice-pane", "slice-pane-2d");
    el.dataset.visible = "0";
    el.tabIndex = 0;
    el.innerHTML = `
      <canvas class="slice-canvas"></canvas>
      <svg class="slice-svg" xmlns="${NS}"></svg>
      <div class="slice-head">
        <span class="slice-title" style="color:${AXIS_COLORS[info.normal]}" title="${info.label} plane: slices along ${info.normal.toUpperCase()}">${info.label}</span>
        <span class="slice-sub"></span>
        <span class="slice-btns">
          <button type="button" data-act="flip-u" title="Flip horizontally">\u21c6</button>
          <button type="button" data-act="flip-v" title="Flip vertically">\u21c5</button>
          <button type="button" data-act="reset" title="Reset zoom and pan (double-click)">\u21ba</button>
          <button type="button" data-act="max" title="Maximize / restore">\u2922</button>
        </span>
      </div>
      <div class="slice-hud"></div>
      <div class="slice-busy" hidden></div>`;
    this.canvas = el.querySelector("canvas");
    this.svg = el.querySelector("svg");
    this.subEl = el.querySelector(".slice-sub");
    this.hudEl = el.querySelector(".slice-hud");
    this.busyEl = el.querySelector(".slice-busy");

    this.ctx = this.canvas.getContext("webgpu");
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: views.device, format: this.format, alphaMode: "opaque" });
    this.gpu = views.renderer.createPane();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.bindInput();
    this.resize();
  }

  get state() {
    return this.views.state;
  }

  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    this.el.dataset.visible = v ? "1" : "0";
    if (!v) this.cancelPending();
    else {
      this.resize();
      this.sync();
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const max = this.views.device.limits.maxTextureDimension2D;
    const width = Math.max(1, this.el.clientWidth);
    const height = Math.max(1, this.el.clientHeight);
    this.size = { width, height, dpr };
    const cw = clamp(Math.round(width * dpr), 1, max);
    const ch = clamp(Math.round(height * dpr), 1, max);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.views.requestRender();
  }

  // ------------------------------------------------------------ data

  cancelPending() {
    this.abort?.abort();
    this.abort = null;
    this.pendingKey = null;
    this.setBusy(false);
  }

  /** Makes sure the plane for the current cursor is (being) loaded. */
  sync() {
    if (!this.visible) return;
    const st = this.state;
    const idx = planeIndex(this.axis, st.cursor);
    const ext = planeExtents(this.axis, st.dims);
    const preview = st.interacting && ext.u * ext.v >= PREVIEW_MIN_PIXELS;
    const stride = preview ? 2 : 1;
    const key = `${idx}/${stride}/${st.channel}`;
    if (key === this.shownKey || key === this.pendingKey) return;

    const client = this.views.client;
    const hit = client.peek(this.axis, idx, st.channel, stride);
    if (hit) {
      this.cancelPending();
      this.show(hit, key);
      return;
    }
    this.cancelPending(); // latest wins
    const ac = new AbortController();
    this.abort = ac;
    this.pendingKey = key;
    this.busyTimer = setTimeout(() => { if (this.pendingKey === key) this.setBusy(true); }, 120);
    client
      .get(this.axis, idx, { channel: st.channel, stride, signal: ac.signal, priority: 2 })
      .then((plane) => {
        if (this.pendingKey !== key) return;
        this.pendingKey = null;
        this.setBusy(false);
        this.show(plane, key);
      })
      .catch((err) => {
        if (err?.name === "AbortError" || this.pendingKey !== key) return;
        this.pendingKey = null;
        this.setBusy(false);
        this.error = err.message || String(err);
        this.updateHud();
        this.views.requestRender();
      });
  }

  show(plane, key) {
    try {
      this.views.renderer.upload(this.gpu, plane);
    } catch (err) {
      this.error = err.message;
      this.updateHud();
      return;
    }
    this.error = null;
    this.plane = plane;
    this.shownKey = key;
    this.lastStats = { fetchMs: this.views.client.counters.lastMs, source: plane.source };
    this.views.requestRender();
    this.prefetch(plane);
  }

  prefetch(plane) {
    const st = this.state;
    const n = AXIS_INFO[this.axis].normal;
    const list = prefetchIndices(plane.index, this.lastDir, st.dims[n], this.views.info.chunk[n]);
    this.views.client.prefetch(this.axis, list, { channel: st.channel, stride: 1 });
  }

  setBusy(on) {
    clearTimeout(this.busyTimer);
    this.busyEl.hidden = !on;
  }

  // ------------------------------------------------------------ drawing

  ppv() {
    const st = this.state;
    return panePpv(this.axis, st.dims, st.spacing, st.views[this.axis], this.size.width, this.size.height);
  }

  draw() {
    if (!this.visible) return;
    const st = this.state;
    const { dpr } = this.size;
    const ppv = this.ppv();
    this.views.renderer.draw(this.gpu, this.ctx.getCurrentTexture().createView(), this.format, {
      width: this.canvas.width,
      height: this.canvas.height,
      extent: planeExtents(this.axis, st.dims),
      view: st.views[this.axis],
      ppv: { u: ppv.u * dpr, v: ppv.v * dpr },
      flip: st.flips[this.axis],
      window: st.window,
      invert: st.invert,
      lut: !isGrayRamp(st.tf.stops), // the plain grey ramp skips the colour table
    });
    this.drawOverlay(ppv);
    this.updateHeader();
  }

  drawOverlay(ppv) {
    const st = this.state;
    const { width, height } = this.size;
    const view = st.views[this.axis];
    const flip = st.flips[this.axis];
    const info = AXIS_INFO[this.axis];
    const ext = planeExtents(this.axis, st.dims);
    const c = cursorInPlane(this.axis, st.cursor);
    const p = planeToPixel(c.u, c.v, width, height, view, ppv, flip);
    const a = planeToPixel(0, 0, width, height, view, ppv, flip);
    const b = planeToPixel(ext.u, ext.v, width, height, view, ppv, flip);
    const parts = [
      `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" fill="none" stroke="#ffffff" stroke-opacity="0.18"/>`,
    ];
    if (st.showCrosshair) {
      const cu = AXIS_COLORS[info.u]; // the vertical line is the plane of constant u
      const cv = AXIS_COLORS[info.v];
      const gap = 10;
      const yTop = Math.min(a.y, b.y), yBot = Math.max(a.y, b.y), xL = Math.min(a.x, b.x), xR = Math.max(a.x, b.x);
      const seg = (x1, y1, x2, y2, col) => (x1 === x2 && y1 === y2 ? "" :
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${col}" stroke-opacity="0.85"/>`);
      parts.push(
        seg(p.x, Math.max(yTop, 0), p.x, p.y - gap, cu), seg(p.x, p.y + gap, p.x, Math.min(yBot, height), cu),
        seg(Math.max(xL, 0), p.y, p.x - gap, p.y, cv), seg(p.x + gap, p.y, Math.min(xR, width), p.y, cv),
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="none" stroke="#fff" stroke-opacity="0.9"/>`,
      );
    }
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.innerHTML = parts.join("");
  }

  updateHeader() {
    const st = this.state;
    const n = AXIS_INFO[this.axis].normal;
    const idx = st.cursor[n];
    const pos = (idx + 0.5) * st.spacing[n];
    const phys = this.views.info.unit ? ` \u00b7 ${fmtPos(pos, this.views.info.unit)}` : "";
    const stale = this.shownKey && !this.shownKey.startsWith(`${idx}/`) ? " \u00b7 \u2026" : "";
    const zoom = st.views[this.axis].zoom;
    const text = `${n} ${idx + 1} / ${st.dims[n]}${phys}${zoom !== 1 ? ` \u00b7 ${Math.round(zoom * 100)}%` : ""}${stale}`;
    if (this.subEl.textContent !== text) this.subEl.textContent = text;
  }

  updateHud(text = "") {
    this.hudEl.textContent = this.error ?? text;
    this.hudEl.classList.toggle("error", !!this.error);
  }

  // ------------------------------------------------------------ input

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  planePoint(x, y) {
    const st = this.state;
    return pixelToPlane(x, y, this.size.width, this.size.height, st.views[this.axis], this.ppv(), st.flips[this.axis]);
  }

  moveCursorTo(x, y) {
    const pt = this.planePoint(x, y);
    this.state.setFromPlane(this.axis, pt.u, pt.v, this.axis);
  }

  bindInput() {
    const el = this.el;
    const st = () => this.state;
    let spaceDown = false;

    el.addEventListener("contextmenu", (e) => e.preventDefault());

    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".slice-head")) return;
      el.focus({ preventScroll: true });
      const mode = e.button === 1 || (e.button === 0 && (e.shiftKey || spaceDown)) ? "pan" : e.button === 0 ? "cursor" : e.button === 2 ? "window" : null;
      if (!mode) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const { x, y } = this.local(e);
      this.drag = { mode, id: e.pointerId, x, y };
      st().beginInteraction();
      if (mode === "cursor") this.moveCursorTo(x, y);
    });

    el.addEventListener("pointermove", (e) => {
      const { x, y } = this.local(e);
      if (!this.drag) {
        this.hover(x, y);
        return;
      }
      const dx = x - this.drag.x, dy = y - this.drag.y;
      this.drag.x = x;
      this.drag.y = y;
      const s = st();
      if (this.drag.mode === "cursor") {
        this.moveCursorTo(x, y);
      } else if (this.drag.mode === "pan") {
        const ppv = this.ppv(), flip = s.flips[this.axis], v = s.views[this.axis];
        s.setView(this.axis, { centerU: v.centerU - (flip.u * dx) / ppv.u, centerV: v.centerV - (flip.v * dy) / ppv.v });
      } else {
        s.setWindow(dragWindow(s.window, dx, dy, s.dtype));
      }
    });

    const end = (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.drag = null;
      st().endInteraction();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", () => { if (!this.drag) this.updateHud(); });

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const s = st();
      if (e.ctrlKey || e.metaKey) {
        const { x, y } = this.local(e);
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        s.setView(this.axis, zoomAt(s.views[this.axis], factor, x, y, this.size.width, this.size.height, this.ppv(), s.flips[this.axis]));
        return;
      }
      // one step per mouse-wheel notch / ~40 px of trackpad scroll
      this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const steps = Math.trunc(this.wheelAcc / 40);
      if (!steps) return;
      this.wheelAcc -= steps * 40;
      const dir = steps > 0 ? 1 : -1;
      this.lastDir = dir;
      s.beginInteraction(180);
      s.moveAlong(this.axis, dir * Math.abs(steps) * (e.shiftKey ? 10 : 1), this.axis);
    }, { passive: false });

    el.addEventListener("dblclick", (e) => {
      if (e.target.closest(".slice-head")) return;
      st().resetView(this.axis);
    });

    el.addEventListener("keydown", (e) => {
      const s = st();
      const k = e.key;
      const { u } = AXIS_INFO[this.axis];
      const step = e.shiftKey ? 10 : 1;
      let handled = true;
      if (k === " ") spaceDown = true;
      else if (k === "ArrowUp" || k === "PageUp") { this.lastDir = 1; s.moveAlong(this.axis, k === "PageUp" ? 10 : step, this.axis); }
      else if (k === "ArrowDown" || k === "PageDown") { this.lastDir = -1; s.moveAlong(this.axis, -(k === "PageDown" ? 10 : step), this.axis); }
      else if (k === "ArrowLeft") s.setCursor({ [u]: s.cursor[u] - step }, this.axis);
      else if (k === "ArrowRight") s.setCursor({ [u]: s.cursor[u] + step }, this.axis);
      else if (k === "Home" || k === "r") s.resetView(this.axis);
      else if (k === "i") s.setInvert(!s.invert);
      else if (k === "w") s.resetWindow();
      else handled = false;
      if (handled) e.preventDefault();
    });
    el.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });

    el.querySelector(".slice-btns").addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "reset") st().resetView(this.axis);
      else if (act === "flip-u") st().toggleFlip(this.axis, "u");
      else if (act === "flip-v") st().toggleFlip(this.axis, "v");
      else if (act === "max") st().setLayout(st().layout === this.axis ? "quad" : this.axis);
    });
  }

  hover(x, y) {
    const st = this.state;
    const pt = this.planePoint(x, y);
    const ext = planeExtents(this.axis, st.dims);
    if (pt.u < 0 || pt.v < 0 || pt.u >= ext.u || pt.v >= ext.v) {
      this.updateHud();
      return;
    }
    const { u, v, normal } = AXIS_INFO[this.axis];
    const vox = { [u]: Math.floor(pt.u), [v]: Math.floor(pt.v), [normal]: st.cursor[normal] };
    let value = "";
    const p = this.plane;
    if (p && p.index === st.cursor[normal]) {
      const s = p.stride ?? 1;
      const col = Math.min(p.width - 1, Math.round(vox[u] / s)), row = Math.min(p.height - 1, Math.round(vox[v] / s));
      const val = p.data[row * p.width + col];
      value = ` = ${Number.isInteger(val) ? val : val.toPrecision(5)}`;
    }
    this.updateHud(`x ${vox.x}  y ${vox.y}  z ${vox.z}${value}`);
  }

  dispose() {
    this.cancelPending();
    this.ro.disconnect();
    this.views.renderer.destroyPane(this.gpu);
    try { this.ctx.unconfigure(); } catch { /* already gone */ }
    this.el.replaceChildren();
    this.el.classList.remove("slice-pane", "slice-pane-2d");
  }
}

// ------------------------------------------------------------------ controller

export class SliceViews {
  /**
   * @param {object} o
   * @param {HTMLElement} o.grid       the `.slice-grid` element (holds #pane-3d and the three slice panes)
   * @param {() => Promise<string>} o.getAccessUrl   returns the signed slice base URL
   * @param {URLSearchParams|object} [o.params]      initial state (cursor / layout / win / ch)
   */
  static async create({ grid, getAccessUrl, params = {}, fetchFn }) {
    const baseUrl = await getAccessUrl();
    const client = new PlaneClient({ baseUrl, refreshUrl: getAccessUrl, fetchFn });
    try {
      const info = await client.info();
      if (!textureFormatFor(info.dtype)) throw new Error(`Slice views do not support ${info.dtype} data`);
      const device = await requestSliceDevice();
      if (!device) throw new Error("WebGPU is not available for the slice views");
      const state = new SliceState({ dims: info.dims, spacing: info.spacing, dtype: info.dtype, window: info.window, channels: info.channels });
      state.applyParams(params);
      return new SliceViews({ grid, client, info, device, state });
    } catch (err) {
      client.dispose();
      throw err;
    }
  }

  constructor({ grid, client, info, device, state }) {
    this.grid = grid;
    this.client = client;
    this.info = info;
    this.device = device;
    this.state = state;
    this.renderer = new SliceRenderer(device);
    this.renderer.setLut(buildLut(state.tf.stops));
    this._raf = 0;
    this._disposed = false;
    this.pane3d = grid.querySelector("#pane-3d");
    this.viewer = null;
    this.overlay3d = this.pane3d ? new Overlay3D(this.pane3d, state) : null;

    this.panes = {};
    for (const axis of AXES) this.panes[axis] = new Pane(this, axis, grid.querySelector(`[data-axis="${axis}"]`));

    this._offs = [
      state.on("cursor", ({ changed }) => {
        for (const axis of AXES) {
          if (changed.includes(AXIS_INFO[axis].normal)) {
            const pane = this.panes[axis];
            const idx = state.cursor[AXIS_INFO[axis].normal];
            pane.lastDir = Math.sign(idx - pane.prevIdx) || pane.lastDir; // scroll direction, for prefetching
            pane.prevIdx = idx;
            pane.sync();
          }
        }
        this.requestRender();
      }),
      state.on("channel", () => { for (const p of Object.values(this.panes)) { p.shownKey = null; p.sync(); } }),
      state.on("interaction", ({ active }) => { if (!active) for (const p of Object.values(this.panes)) p.sync(); }),
      state.on("layout", () => this.applyLayout()),
      state.on("view", () => this.requestRender()),
      state.on("window", () => this.requestRender()),
      state.on("tf", () => { this.renderer.setLut(buildLut(state.tf.stops)); this.requestRender(); }),
      state.on("option", () => this.requestRender()),
    ];
    for (const axis of AXES) this.panes[axis].prevIdx = state.cursor[AXIS_INFO[axis].normal];
    device.lost.then((l) => { if (!this._disposed) this.fail(`GPU device lost: ${l.message}`); });
    this.applyLayout();
    this._viewerLoop = this._viewerLoop.bind(this);
  }

  /** Connects the kiln viewer so the 3D plane overlay can follow its camera. */
  attachViewer(viewer) {
    this.viewer = viewer;
    if (!this._loop && !this._disposed) this._loop = requestAnimationFrame(this._viewerLoop);
  }
  detachViewer() {
    this.viewer = null;
    cancelAnimationFrame(this._loop);
    this._loop = 0;
  }
  _viewerLoop() {
    if (this._disposed || !this.viewer) { this._loop = 0; return; }
    this.overlay3d?.update(this.viewer);
    this._loop = requestAnimationFrame(this._viewerLoop);
  }

  fail(message) {
    for (const p of Object.values(this.panes)) { p.error = message; p.updateHud(); }
  }

  // ------------------------------------------------------------------ layout

  /** 3D visible in these layouts */
  static show3d(layout) { return layout === "3d" || layout === "quad"; }

  applyLayout() {
    const layout = this.state.layout;
    this.grid.dataset.layout = layout;
    if (this.pane3d) this.pane3d.dataset.visible = SliceViews.show3d(layout) ? "1" : "0";
    for (const axis of AXES) this.panes[axis].setVisible(layout === "quad" || layout === axis);
    this.requestRender();
    for (const p of Object.values(this.panes)) if (p.visible) p.resize();
    this.onLayout?.(layout);
  }

  // ---------------------------------------------------------------- rendering

  requestRender() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this._disposed) return;
      for (const p of Object.values(this.panes)) p.draw();
      this.onRender?.();
    });
  }

  // ----------------------------------------------------------------- the rest

  toParams() {
    return this.state.toParams();
  }

  debugInfo() {
    const stats = this.client.stats();
    return {
      planes: stats.planes, cacheMB: stats.cacheMB, inflight: stats.inflight, queued: stats.queued,
      fetches: stats.fetches, hits: stats.hits, aborted: stats.aborted,
      lastMs: +stats.lastMs.toFixed(1), lastServerMs: stats.lastServerMs, lastSource: stats.lastSource,
      uploadMB: +(this.renderer.uploadBytes / 1e6).toFixed(1),
      panes: Object.fromEntries(AXES.map((a) => [a, { shown: this.panes[a].shownKey, pending: this.panes[a].pendingKey }])),
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    cancelAnimationFrame(this._loop);
    this._offs.forEach((off) => off());
    this.overlay3d?.dispose();
    for (const p of Object.values(this.panes)) p.dispose();
    this.client.dispose();
    this.renderer.dispose();
    try { this.device.destroy(); } catch { /* already lost */ }
    this.grid.dataset.layout = "3d";
    if (this.pane3d) this.pane3d.dataset.visible = "1";
  }
}
