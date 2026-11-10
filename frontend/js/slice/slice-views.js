// Slice views: three 2D panes (xy / xz / yz) next to the kiln 3D view.
//
//   server (planes) -> PlaneClient -> SliceRenderer (WebGPU, one texture per pane)
//                         ^                 ^
//                         |                 +-- drawn on demand, never in a free-running loop
//   SliceState (cursor, views, window, layout) <-- pointer / wheel / keyboard input
//
// Every pane reads the same SliceState: clicking in one pane moves the cursor, and the
// others re-request their plane and move their crosshair lines.

import { PlaneClient, prefetchIndices } from "./plane-client.js?v=ang1";
import { SliceRenderer, requestSliceDevice } from "./slice-renderer.js?v=org3";
import { SliceState } from "./cursor.js?v=ang1";
import { ObliquePane } from "./oblique-pane.js?v=ang1";
import { bindTouchGestures } from "./touch-gestures.js?v=org6";
import { buildLut, isGrayRamp } from "./transfer-function.js";
import { Overlay3D } from "./overlay-3d.js?v=meas1";
import { hitHandle, paneMeasureSvg, pointFromPlane, roundPoint } from "./measure.js?v=meas1";
import { Measure3D } from "./measure-3d.js?v=meas1";
import { ensureMeasureStyles } from "./measure-ui.js?v=meas1";
import { niceScaleLength } from "../scalebar.js";
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

/**
 * SVG for a scale bar at the bottom-left of a pane (above the read-out line). `umPerPx` is the
 * physical length of one screen pixel along the pane's horizontal axis; the voxel spacing is
 * taken to be micrometres. Returns "" when the pane is too small or the scale is unusable.
 */
export function scaleBarSvg(umPerPx, width, height) {
  if (!(umPerPx > 0) || height < 90 || width < 120) return "";
  const nice = niceScaleLength(umPerPx * clamp(width * 0.25, 60, 150));
  if (!nice) return "";
  const x0 = 14, y = height - 32;
  const len = Math.max(2, Math.round(nice.um / umPerPx));
  const d = `M${x0},${y - 6}V${y}H${x0 + len}V${y - 6}`;
  return `<path d="${d}" fill="none" stroke="#000" stroke-opacity="0.75" stroke-width="4.5" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="none" stroke="#f2f4f8" stroke-width="2"/>` +
    `<text x="${x0}" y="${y - 11}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" ` +
    `fill="#f2f4f8" stroke="#000" stroke-opacity="0.75" stroke-width="3" paint-order="stroke">${nice.text}</text>`;
}

// ------------------------------------------------------------------------- pane

/**
 * Calls `handler(button)` for a click on a button inside `container`. For touch it does not wait for the
 * click: it acts on pointerup when the finger lifts on the button it touched, and ignores the click that
 * follows.
 */
function onButtonTap(container, handler) {
  let downOn = null;
  let handledAt = -Infinity;
  container.addEventListener("pointerdown", (e) => { downOn = e.pointerType === "touch" ? e.target.closest("button") : null; });
  container.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch") return;
    const btn = e.target.closest("button");
    if (!btn || btn !== downOn) return;
    handledAt = performance.now();
    handler(btn);
  });
  container.addEventListener("click", (e) => {
    if (performance.now() - handledAt < 700) return; // the touch tap was dealt with above
    const btn = e.target.closest("button");
    if (btn) handler(btn);
  });
}

export class Pane {
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
    this.mdrag = null;       // a mouse press that is measuring: placing a point or dragging one
    this.tmd = null;         // the same for one finger
    this.rubber = null;      // the live end of the measurement being made (a point)
    this.handles = [];       // the measurement points on this slice, in pane pixels (hit testing)
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
          <button type="button" data-act="measure" title="Measure distances (M): click two points" aria-pressed="false">\ud83d\udccf</button>
          <button type="button" data-act="flip-u" title="Flip horizontally">\u21c6</button>
          <button type="button" data-act="flip-v" title="Flip vertically">\u21c5</button>
          <button type="button" data-act="reset" title="Reset zoom and pan (double-click)">\u21ba</button>
          <button type="button" data-act="max" title="Maximize / restore">\u2922</button>
        </span>
      </div>
      <div class="slice-tools" role="group" aria-label="What one finger does">
        <button type="button" data-tool="cursor" title="One finger: move the crosshair">\u2316</button>
        <button type="button" data-tool="pan" title="One finger: pan">\u2725</button>
        <button type="button" data-tool="scroll" title="One finger: scroll through the slices">\u2195</button>
        <button type="button" data-tool="window" title="One finger: window / level">\u25d0</button>
        <button type="button" data-tool="measure" title="One finger: measure (tap two points, drag a point to move it)">\ud83d\udccf</button>
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
    ensureMeasureStyles();
    this.bindInput();
    this.bindTouch();
    this.showTouchTool();
    this.syncMeasuring();
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
    if (!this.views.prefetchEnabled) return; // switched off while a slice sweep plays: only the plane on screen is fetched
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
    if (st.showScaleBar !== false) parts.push(scaleBarSvg(st.spacing[info.u] / ppv.u, width, height));
    const meas = paneMeasureSvg({
      axis: this.axis, index: st.cursor[info.normal], measures: st.measures, pending: st.pending, rubber: this.rubber,
      selected: st.measureSel, spacing: st.spacing, unit: st.unit ?? "micrometer", width, height, view, ppv, flip,
    });
    this.handles = meas.handles;
    parts.push(meas.svg);
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
      if (e.pointerType === "touch" || e.target.closest(".slice-head, .slice-tools")) return; // touch: see bindTouch()
      el.focus({ preventScroll: true });
      if (st().measuring && e.button === 0 && !e.shiftKey && !spaceDown) { // the ruler: this press places or moves a point
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const { x, y } = this.local(e);
        this.measureDown(x, y, e.pointerId);
        return;
      }
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
      if (e.pointerType === "touch") return;
      const { x, y } = this.local(e);
      if (this.mdrag && this.mdrag.id === e.pointerId) {
        this.measureMove(x, y);
        return;
      }
      if (!this.drag) {
        this.hover(x, y);
        if (st().measuring && st().pending) this.setRubber(this.measurePoint(x, y)); // live line to the pointer
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
      if (this.mdrag && this.mdrag.id === e.pointerId) { this.measureEnd(); return; }
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
      else if (k === "m") s.setMeasuring(!s.measuring);
      else if (k === "Escape" && (s.pending || s.measuring)) { if (s.pending) s.setPending(null); else s.setMeasuring(false); this.rubber = null; }
      else if ((k === "Delete" || k === "Backspace") && s.measureSel !== null) s.removeMeasure(s.measureSel);
      else handled = false;
      if (handled) e.preventDefault();
    });
    el.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });

    // A tap on a button acts when the finger lifts: after a quick drag or pinch some touch screens do not
    // send the click of the next tap, and a button that sometimes ignores a tap is worse than none.
    onButtonTap(el.querySelector(".slice-tools"), (btn) => {
      if (btn.dataset.tool) this.views.setTouchTool(btn.dataset.tool);
    });
    onButtonTap(el.querySelector(".slice-btns"), (btn) => {
      const act = btn.dataset.act;
      if (act === "reset") st().resetView(this.axis);
      else if (act === "flip-u") st().toggleFlip(this.axis, "u");
      else if (act === "flip-v") st().toggleFlip(this.axis, "v");
      else if (act === "max") st().setLayout(st().layout === this.axis ? "quad" : this.axis);
      else if (act === "measure") st().setMeasuring(!st().measuring);
    });
  }

  // ------------------------------------------------------------ measuring

  /** Shows whether the ruler is on (cursor shape, the button). */
  syncMeasuring() {
    const on = this.state.measuring;
    this.el.dataset.measuring = on ? "1" : "0";
    this.el.querySelector('[data-act="measure"]')?.setAttribute("aria-pressed", String(on));
    if (!on) this.rubber = null;
  }

  setRubber(p) {
    this.rubber = p;
    this.views.requestRender();
  }

  /** The 3D point under a pixel of this pane: on the slice shown, inside the volume. */
  measurePoint(x, y) {
    const st = this.state;
    const pt = this.planePoint(x, y);
    const ext = planeExtents(this.axis, st.dims);
    return roundPoint(pointFromPlane(this.axis, clamp(pt.u, 0, ext.u), clamp(pt.v, 0, ext.v), st.cursor[AXIS_INFO[this.axis].normal]));
  }

  /** The end of a measurement (or the pending point) near a pixel, if any. */
  measureHandleAt(x, y, tolerance) {
    return hitHandle(this.handles, x, y, tolerance);
  }

  /** Completes the measurement with `pt`, or says why it cannot. */
  finishMeasure(pt) {
    const st = this.state;
    if (st.addMeasure(st.pending, pt, st.pendingAcc, 0) === null) this.updateHud("At most 50 measurements: delete one first");
    this.rubber = null;
  }

  measureDown(x, y, id) {
    const st = this.state;
    const hit = this.measureHandleAt(x, y, 10);
    if (hit) { // take that point
      if (hit.id !== null) st.selectMeasure(hit.id);
      this.mdrag = { id, kind: hit.id === null ? "pending" : "handle", mid: hit.id, end: hit.end };
      st.beginInteraction();
      return;
    }
    st.selectMeasure(null);
    const pt = this.measurePoint(x, y);
    if (st.pending) { // the second click
      this.finishMeasure(pt);
      this.mdrag = { id, kind: "none" };
      return;
    }
    st.setPending(pt, 0);
    this.mdrag = { id, kind: "rubber", sx: x, sy: y, moved: false };
    st.beginInteraction();
  }

  measureMove(x, y) {
    const d = this.mdrag, st = this.state;
    if (d.kind === "handle") st.movePoint(d.mid, d.end, this.measurePoint(x, y), 0);
    else if (d.kind === "pending") st.setPending(this.measurePoint(x, y), 0);
    else if (d.kind === "rubber") {
      if (!d.moved && Math.hypot(x - d.sx, y - d.sy) > 4) d.moved = true;
      if (d.moved) this.setRubber(this.measurePoint(x, y)); // dragging from the first point: the line follows
    }
  }

  measureEnd() {
    const d = this.mdrag, st = this.state;
    this.mdrag = null;
    st.endInteraction();
    if (d.kind === "rubber" && d.moved && st.pending && this.rubber) this.finishMeasure(this.rubber); // press, drag, release
    else if (d.kind === "none" || d.kind === "handle") this.rubber = null;
    this.views.requestRender();
  }

  /** A tap with the ruler tool on a touch screen: select a point, or place the next one. */
  measureTap(x, y) {
    const st = this.state;
    const hit = this.measureHandleAt(x, y, 20);
    if (hit && hit.id !== null) { st.selectMeasure(hit.id); return; }
    const pt = this.measurePoint(x, y);
    if (st.pending) this.finishMeasure(pt);
    else st.setPending(pt, 0);
  }

  /** One finger dragging with the ruler tool: moves the point it started on, or draws a line from the pending point. */
  touchMeasureDrag(x, y, dx, dy) {
    const st = this.state;
    if (!this.tmd) {
      const sx = x - dx, sy = y - dy;
      const hit = this.measureHandleAt(sx, sy, 24);
      if (hit) {
        if (hit.id !== null) st.selectMeasure(hit.id);
        this.tmd = { kind: hit.id === null ? "pending" : "handle", mid: hit.id, end: hit.end };
      } else {
        if (!st.pending) st.setPending(this.measurePoint(sx, sy), 0);
        this.tmd = { kind: "rubber" };
      }
    }
    const pt = this.measurePoint(x, y);
    if (this.tmd.kind === "handle") st.movePoint(this.tmd.mid, this.tmd.end, pt, 0);
    else if (this.tmd.kind === "pending") st.setPending(pt, 0);
    else this.setRubber(pt);
  }

  touchMeasureEnd() {
    const d = this.tmd, st = this.state;
    this.tmd = null;
    if (d?.kind === "rubber" && st.pending && this.rubber) this.finishMeasure(this.rubber);
    this.rubber = null;
  }

  // Touch: one finger taps and drags (what a drag does is the chosen tool), two fingers pinch and pan.
  bindTouch() {
    this.scrollAcc = 0;
    bindTouchGestures(this.el, {
      local: (e) => this.local(e),
      tool: () => this.views.touchTool,
      focus: () => this.el.focus({ preventScroll: true }),
      begin: () => { this.scrollAcc = 0; this.state.beginInteraction(); },
      end: () => { this.touchMeasureEnd(); this.state.endInteraction(); },
      tap: (x, y) => { if (this.views.touchTool === "measure") this.measureTap(x, y); else { this.moveCursorTo(x, y); this.hover(x, y); } },
      // two quick taps place two points with the ruler: they are not a double tap there
      doubleTap: (x, y) => { if (this.views.touchTool === "measure") this.measureTap(x, y); else this.state.resetView(this.axis); },
      drag: (tool, x, y, dx, dy) => this.touchDrag(tool, x, y, dx, dy),
      pinch: (g) => this.touchPinch(g),
    });
  }

  touchDrag(tool, x, y, dx, dy) {
    const s = this.state;
    if (tool === "pan") {
      const ppv = this.ppv(), flip = s.flips[this.axis], v = s.views[this.axis];
      s.setView(this.axis, { centerU: v.centerU - (flip.u * dx) / ppv.u, centerV: v.centerV - (flip.v * dy) / ppv.v });
    } else if (tool === "window") {
      s.setWindow(dragWindow(s.window, dx, dy, s.dtype));
    } else if (tool === "measure") {
      this.touchMeasureDrag(x, y, dx, dy);
    } else if (tool === "scroll") {
      // dragging up goes to the next slice, like scrolling a page; about one slice per 10 px
      this.scrollAcc -= dy;
      const steps = Math.trunc(this.scrollAcc / 10);
      if (!steps) return;
      this.scrollAcc -= steps * 10;
      this.lastDir = steps > 0 ? 1 : -1;
      s.moveAlong(this.axis, steps, this.axis);
    } else {
      this.moveCursorTo(x, y);
    }
  }

  touchPinch({ factor, cx, cy, dx, dy }) {
    const s = this.state, axis = this.axis;
    s.setView(axis, zoomAt(s.views[axis], factor, cx, cy, this.size.width, this.size.height, this.ppv(), s.flips[axis]));
    const ppv = this.ppv(), flip = s.flips[axis], v = s.views[axis];
    s.setView(axis, { centerU: v.centerU - (flip.u * dx) / ppv.u, centerV: v.centerV - (flip.v * dy) / ppv.v });
  }

  showTouchTool() {
    for (const b of this.el.querySelectorAll(".slice-tools button")) b.setAttribute("aria-pressed", String(b.dataset.tool === this.views.touchTool));
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
      const state = new SliceState({ dims: info.dims, spacing: info.spacing, dtype: info.dtype, window: info.window, channels: info.channels, unit: info.unit ?? null });
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
    // What one finger drags do on a touch screen (see Pane.bindTouch); remembered in this browser
    this.touchTool = "cursor";
    try {
      const saved = localStorage.getItem("vg_slice_touch_tool");
      if (["cursor", "pan", "scroll", "window", "measure"].includes(saved)) this.touchTool = saved;
    } catch (_) { /* storage unavailable */ }
    this.renderer = new SliceRenderer(device);
    this.renderer.setLut(buildLut(state.tf.stops));
    this._raf = 0;
    this._disposed = false;
    this.pane3d = grid.querySelector("#pane-3d");
    this.viewer = null;
    this.overlay3d = this.pane3d ? new Overlay3D(this.pane3d, state) : null;
    this.measure3d = this.pane3d ? new Measure3D({ views: this, host: this.pane3d }) : null;

    this.panes = {};
    for (const axis of AXES) this.panes[axis] = new Pane(this, axis, grid.querySelector(`[data-axis="${axis}"]`));
    const angledEl = grid.querySelector('[data-axis="angled"]');
    this.angled = angledEl ? new ObliquePane(this, angledEl, { scaleBarSvg }) : null; // the angled slice (see oblique-pane.js)

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
        this.angled?.sync();
        this.requestRender();
      }),
      state.on("angled", () => { this.angled?.sync(); this.requestRender(); }),
      state.on("channel", () => { for (const p of Object.values(this.panes)) { p.shownKey = null; p.sync(); } if (this.angled) { this.angled.shownKey = null; this.angled.sync(); } }),
      state.on("interaction", ({ active }) => { if (!active) for (const p of Object.values(this.panes)) p.sync(); }),
      state.on("layout", () => this.applyLayout()),
      state.on("view", () => this.requestRender()),
      state.on("window", () => this.requestRender()),
      state.on("tf", () => { this.renderer.setLut(buildLut(state.tf.stops)); this.requestRender(); }),
      state.on("option", () => this.requestRender()),
      state.on("measuring", () => { for (const p of Object.values(this.panes)) p.syncMeasuring(); this.requestRender(); }),
      state.on("measure", () => { if (!state.pending) for (const p of Object.values(this.panes)) p.rubber = null; this.requestRender(); }),
    ];
    for (const axis of AXES) this.panes[axis].prevIdx = state.cursor[AXIS_INFO[axis].normal];
    device.lost.then((l) => { if (!this._disposed) this.fail(`GPU device lost: ${l.message}`); });
    this.applyLayout();
    this._viewerLoop = this._viewerLoop.bind(this);
  }

  /** Connects the kiln viewer so the 3D plane overlay can follow its camera. */
  attachViewer(viewer) {
    this.viewer = viewer;
    this.measure3d?.attachViewer(viewer);
    if (!this._loop && !this._disposed) this._loop = requestAnimationFrame(this._viewerLoop);
  }
  detachViewer() {
    this.viewer = null;
    this.measure3d?.detachViewer();
    cancelAnimationFrame(this._loop);
    this._loop = 0;
  }
  _viewerLoop() {
    if (this._disposed || !this.viewer) { this._loop = 0; return; }
    this.overlay3d?.update(this.viewer);
    this._loop = requestAnimationFrame(this._viewerLoop);
  }

  fail(message) {
    for (const p of [...Object.values(this.panes), this.angled]) if (p) { p.error = message; p.updateHud(); }
  }

  // ------------------------------------------------------------------ layout

  /** 3D visible in these layouts */
  static show3d(layout) { return layout === "3d" || layout === "quad"; }

  applyLayout() {
    const layout = this.state.layout;
    this.grid.dataset.layout = layout;
    if (this.pane3d) this.pane3d.dataset.visible = SliceViews.show3d(layout) ? "1" : "0";
    // "angled": the angled slice big on the left, the three axis panes next to it
    for (const axis of AXES) this.panes[axis].setVisible(layout === "quad" || layout === "angled" || layout === axis);
    this.angled?.setVisible(layout === "angled");
    this.requestRender();
    for (const p of Object.values(this.panes)) if (p.visible) p.resize();
    if (this.angled?.visible) this.angled.resize();
    this.onLayout?.(layout);
  }

  // ---------------------------------------------------------------- rendering

  requestRender() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this._disposed) return;
      for (const p of Object.values(this.panes)) p.draw();
      this.angled?.draw();
      this.onRender?.();
    });
  }

  // ------------------------------------------------------------ saving a slice as an image

  /** Whether planes next to the one shown are fetched ahead (on by default; a playing sweep turns it off). */
  prefetchEnabled = true;
  setPrefetch(on) {
    this.prefetchEnabled = !!on;
  }

  /** The slice panes on screen now: [{ axis, label, index }]. */
  visibleSlices() {
    return AXES.filter((a) => this.panes[a].visible).map((axis) => {
      const info = AXIS_INFO[axis];
      const index = planeIndex(axis, this.state.cursor);
      return { axis, label: `${info.label} slice (${info.normal.toUpperCase()} = ${index})`, name: `${info.label}-${info.normal}${index}`, index, count: this.state.dims[info.normal], normal: info.normal };
    });
  }

  /**
   * The part of a plane that is saved: [u0, u1) x [v0, v1) in voxels. "whole" = the full plane,
   * "visible" = what the pane shows at its current zoom and pan (clipped to the plane).
   */
  exportRegion(axis, area) {
    const ext = planeExtents(axis, this.state.dims);
    if (area !== "visible") return { u0: 0, v0: 0, width: ext.u, height: ext.v };
    const pane = this.panes[axis];
    const ppv = pane.ppv();
    const view = this.state.views[axis];
    const halfU = pane.size.width / ppv.u / 2;
    const halfV = pane.size.height / ppv.v / 2;
    const u0 = Math.max(0, Math.floor(view.centerU - halfU));
    const u1 = Math.min(ext.u, Math.ceil(view.centerU + halfU));
    const v0 = Math.max(0, Math.floor(view.centerV - halfV));
    const v1 = Math.min(ext.v, Math.ceil(view.centerV + halfV));
    return { u0, v0, width: Math.max(0, u1 - u0), height: Math.max(0, v1 - v0) };
  }

  /**
   * Saves a slice at the full resolution of the data: one image pixel per voxel, whatever the zoom.
   * Orientation (flips), window / level, invert and the colour table are those of the pane.
   * @param {"xy"|"xz"|"yz"} axis
   * @param {{area?: "whole"|"visible", raw?: boolean, index?: number}} [o]  raw: the voxel values themselves,
   *   not the picture; index: a slice other than the cursor's (the cursor is not moved)
   * @returns {Promise<{width, height, rgba, gray} | {width, height, raw}>}
   */
  async exportSlice(axis, { area = "whole", raw = false, index } = {}) {
    const st = this.state;
    const region = this.exportRegion(axis, area);
    if (region.width < 1 || region.height < 1) throw new Error("The slice is not in view");
    const idx = index ?? planeIndex(axis, st.cursor);
    // always the full-resolution plane (the pane may be showing a coarser preview)
    const plane = await this.client.get(axis, idx, { channel: st.channel, stride: 1, priority: 2 });
    const { width, height } = region;
    const flip = st.flips[axis];
    const cu = region.u0 + width / 2;
    const cv = region.v0 + height / 2;

    if (raw) {
      // the same orientation as the picture; voxel (i, j) of the output is read straight from the plane
      const data = new plane.data.constructor(width * height);
      for (let j = 0; j < height; j++) {
        const pv = Math.min(plane.height - 1, Math.max(0, Math.floor(cv + (flip.v * (j + 0.5 - height / 2)))));
        for (let i = 0; i < width; i++) {
          const pu = Math.min(plane.width - 1, Math.max(0, Math.floor(cu + (flip.u * (i + 0.5 - width / 2)))));
          data[j * width + i] = plane.data[pv * plane.width + pu];
        }
      }
      return { width, height, raw: data };
    }

    const gpu = this.renderer.createPane();
    try {
      this.renderer.upload(gpu, plane);
      const gray = isGrayRamp(st.tf.stops);
      const rgba = await this.renderer.renderToPixels(gpu, {
        width,
        height,
        extent: planeExtents(axis, st.dims),
        view: { centerU: cu, centerV: cv },
        ppv: { u: 1, v: 1 },
        flip,
        window: st.window,
        invert: st.invert,
        lut: !gray,
      });
      return { width, height, rgba, gray };
    } finally {
      this.renderer.destroyPane(gpu);
    }
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

  setTouchTool(tool) {
    this.touchTool = tool;
    try { localStorage.setItem("vg_slice_touch_tool", tool); } catch (_) { /* storage unavailable */ }
    for (const axis of AXES) this.panes[axis].showTouchTool();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    cancelAnimationFrame(this._loop);
    this._offs.forEach((off) => off());
    this.measure3d?.dispose();
    this.overlay3d?.dispose();
    for (const p of Object.values(this.panes)) p.dispose();
    this.angled?.dispose();
    this.client.dispose();
    this.renderer.dispose();
    try { this.device.destroy(); } catch { /* already lost */ }
    this.grid.dataset.layout = "3d";
    if (this.pane3d) this.pane3d.dataset.visible = "1";
  }
}
