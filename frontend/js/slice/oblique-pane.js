// The angled slice pane: the XY plane through the cursor, rotated about the volume's x, y and z axes
// (angles in SliceState.angled), cut out of the volume by the server (GET .../slices/<token>/oblique).
//
//   * the image always shows the plane through the cursor, centred on it; a click (or drag) in it moves the
//     cursor to that point of the volume and the plane is re-cut there once the button is released
//   * the mouse wheel changes the field of view (SliceState.angled.fov), right-drag the window / level
//   * what is shown is described by the server (X-Oblique-* headers, see PlaneClient.getOblique), so the
//     pixel -> voxel mapping used for picking is the one the plane was cut with
//
// It draws with the same SliceRenderer, window, invert and colour table as the three axis panes.

import { AXIS_COLORS, clamp, dragWindow } from "./geometry.js";
import { isGrayRamp } from "./transfer-function.js";

const NS = "http://www.w3.org/2000/svg";
export const IMAGE_SIZE = 768;     // pixels per side of the image requested from the server
const DEFAULT_FOV_VOXELS = 1024;   // default field of view (finest voxels): keeps the volume the server must read bounded
const DEBOUNCE_MS = 60;

const fmtAngle = (a) => `${+a.toFixed(1)}°`;

export class ObliquePane {
  /**
   * @param {import("./slice-views.js").SliceViews} views
   * @param {HTMLElement} el   the pane's element (`[data-axis="angled"]`)
   * @param {{scaleBarSvg: Function}} helpers
   */
  constructor(views, el, { scaleBarSvg }) {
    this.views = views;
    this.el = el;
    this.scaleBarSvg = scaleBarSvg;
    this.visible = false;
    this.plane = null;       // the plane on the GPU, with its geometry: { width, height, data, oblique, center, scale }
    this.shownKey = null;
    this.pendingKey = null;
    this.abort = null;
    this.timer = 0;
    this.busyTimer = 0;
    this.drag = null;
    this.error = null;
    this.size = { width: 1, height: 1, dpr: 1 };

    el.classList.add("slice-pane", "slice-pane-2d");
    el.dataset.visible = "0";
    el.tabIndex = 0;
    el.innerHTML = `
      <canvas class="slice-canvas"></canvas>
      <svg class="slice-svg" xmlns="${NS}"></svg>
      <div class="slice-head">
        <span class="slice-title" title="The XY plane through the cursor, rotated about the X, Y and Z axes (set the angles in the Slice views panel)">Angled</span>
        <span class="slice-sub"></span>
        <span class="slice-btns">
          <button type="button" data-act="zoom-in" title="Zoom in (mouse wheel)">+</button>
          <button type="button" data-act="zoom-out" title="Zoom out (mouse wheel)">−</button>
          <button type="button" data-act="reset" title="Back to the XY plane and the default zoom (double-click)">↺</button>
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

  // ---------------------------------------------------------------- geometry

  /** Finest voxel spacing: one image pixel is `scale` times this. */
  get baseSpacing() {
    const s = this.state.spacing;
    return Math.min(s.x, s.y, s.z);
  }

  /** Image pixels the plane is requested at: voxels per pixel for the current field of view. */
  scale() {
    const d = this.state.dims;
    const diag = Math.hypot(d.x * this.state.spacing.x, d.y * this.state.spacing.y, d.z * this.state.spacing.z) / this.baseSpacing;
    return (Math.min(diag, DEFAULT_FOV_VOXELS) / IMAGE_SIZE) * this.state.angled.fov;
  }

  /** CSS pixels per image pixel so the whole image fits the pane. */
  fit() {
    return (Math.min(this.size.width, this.size.height) / IMAGE_SIZE) * 0.98;
  }

  /** The voxel under a pane pixel on the plane shown (continuous coordinates), or null before the first plane. */
  voxelAt(x, y) {
    const p = this.plane;
    if (!p) return null;
    const f = this.fit();
    const col = p.width / 2 + (x - this.size.width / 2) / f;
    const row = p.height / 2 + (y - this.size.height / 2) / f;
    const sp = this.state.spacing, { u, v, pixel } = p.oblique;
    const dc = col - p.width / 2, dr = row - p.height / 2;
    return {
      col, row,
      x: p.center.x + (pixel * (dr * u[0] + dc * v[0])) / sp.x,
      y: p.center.y + (pixel * (dr * u[1] + dc * v[1])) / sp.y,
      z: p.center.z + (pixel * (dr * u[2] + dc * v[2])) / sp.z,
    };
  }

  /** Pane pixel where a voxel falls on the plane shown (projected onto it). */
  pixelOf(vox) {
    const p = this.plane;
    if (!p) return null;
    const sp = this.state.spacing, { u, v, pixel } = p.oblique;
    const d = [(vox.x - p.center.x) * sp.x, (vox.y - p.center.y) * sp.y, (vox.z - p.center.z) * sp.z];
    const dot = (a) => a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
    const f = this.fit();
    return { x: this.size.width / 2 + (f * dot(v)) / pixel, y: this.size.height / 2 + (f * dot(u)) / pixel };
  }

  // ------------------------------------------------------------------- layout

  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    this.el.dataset.visible = on ? "1" : "0";
    if (!on) this.cancelPending();
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

  // --------------------------------------------------------------------- data

  cancelPending() {
    clearTimeout(this.timer);
    this.abort?.abort();
    this.abort = null;
    this.pendingKey = null;
    this.setBusy(false);
  }

  request() {
    const st = this.state;
    const center = { ...st.cursor };
    const { rx, ry, rz } = st.angled;
    const scale = this.scale();
    return { center, angles: { rx, ry, rz }, size: IMAGE_SIZE, scale, channel: st.channel };
  }

  /** Makes sure the plane for the cursor, angles and zoom now is (being) loaded. Waits while a pick is being dragged. */
  sync() {
    if (!this.visible || this.drag) return;
    const r = this.request();
    const key = `${r.center.x},${r.center.y},${r.center.z}|${r.angles.rx},${r.angles.ry},${r.angles.rz}|${r.scale.toFixed(4)}|${r.channel}`;
    if (key === this.shownKey || key === this.pendingKey) return;
    this.cancelPending();
    this.pendingKey = key;
    this.busyTimer = setTimeout(() => { if (this.pendingKey === key) this.setBusy(true); }, 150);
    this.timer = setTimeout(() => this.fetch(key, r), DEBOUNCE_MS); // latest wins while a slider or the wheel is moving
  }

  fetch(key, r) {
    const ac = new AbortController();
    this.abort = ac;
    this.views.client
      .getOblique(r, ac.signal)
      .then((plane) => {
        if (this.pendingKey !== key) return;
        this.pendingKey = null;
        this.setBusy(false);
        this.show(plane, key, r);
      })
      .catch((err) => {
        if (err?.name === "AbortError" || this.pendingKey !== key) return;
        this.pendingKey = null;
        this.setBusy(false);
        this.error = err.status === 413
          ? "Too large to cut at this zoom: zoom in (mouse wheel or +)"
          : err.message || String(err);
        this.updateHud();
      });
  }

  show(plane, key, r) {
    try {
      this.views.renderer.upload(this.gpu, plane);
    } catch (err) {
      this.error = err.message;
      this.updateHud();
      return;
    }
    this.error = null;
    this.plane = { ...plane, center: r.center, angles: r.angles, scale: r.scale };
    this.shownKey = key;
    this.updateHud();
    this.views.requestRender();
  }

  setBusy(on) {
    clearTimeout(this.busyTimer);
    this.busyEl.hidden = !on;
  }

  // ------------------------------------------------------------------ drawing

  draw() {
    if (!this.visible) return;
    const st = this.state;
    const { dpr } = this.size;
    const p = this.plane;
    const f = this.fit() * dpr;
    this.views.renderer.draw(this.gpu, this.ctx.getCurrentTexture().createView(), this.format, {
      width: this.canvas.width,
      height: this.canvas.height,
      extent: { u: p?.width ?? 1, v: p?.height ?? 1 },
      view: { centerU: (p?.width ?? 1) / 2, centerV: (p?.height ?? 1) / 2 },
      ppv: { u: f, v: f },
      flip: { u: 1, v: 1 },
      window: st.window,
      invert: st.invert,
      lut: !isGrayRamp(st.tf.stops), // the plain grey ramp skips the colour table
    });
    this.drawOverlay();
    const a = st.angled;
    this.subEl.textContent = `X ${fmtAngle(a.rx)}  Y ${fmtAngle(a.ry)}  Z ${fmtAngle(a.rz)}${a.fov !== 1 ? ` · ${Math.round(100 / a.fov)}%` : ""}`;
  }

  drawOverlay() {
    const st = this.state;
    const { width, height } = this.size;
    const p = this.plane;
    const parts = [];
    if (p) {
      const f = this.fit();
      const hw = (p.width * f) / 2, hh = (p.height * f) / 2;
      parts.push(`<rect x="${(width / 2 - hw).toFixed(1)}" y="${(height / 2 - hh).toFixed(1)}" width="${(2 * hw).toFixed(1)}" height="${(2 * hh).toFixed(1)}" fill="none" stroke="#ffffff" stroke-opacity="0.18"/>`);
      if (st.showCrosshair) {
        const c = this.pixelOf(st.cursor);
        const gap = 10;
        const line = (x1, y1, x2, y2) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#fff" stroke-opacity="0.85"/>`;
        parts.push(
          line(c.x - gap - 20, c.y, c.x - gap, c.y), line(c.x + gap, c.y, c.x + gap + 20, c.y),
          line(c.x, c.y - gap - 20, c.x, c.y - gap), line(c.x, c.y + gap, c.x, c.y + gap + 20),
          `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="none" stroke="#fff" stroke-opacity="0.9"/>`,
        );
      }
      parts.push(this.axesGizmo(p));
      if (st.showScaleBar !== false) parts.push(this.scaleBarSvg(p.oblique.pixel / f, width, height));
    }
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.innerHTML = parts.join("");
  }

  /** Where the volume's X, Y and Z axes point in the image (their length shows how much they lie in the plane). */
  axesGizmo(p) {
    const { u, v } = p.oblique;
    const { width } = this.size;
    const cx = width - 44, cy = 54, len = 30;
    let out = "";
    ["x", "y", "z"].forEach((axis, i) => {
      const dx = v[i] * len, dy = u[i] * len; // the axis' component along the image columns / rows
      const col = AXIS_COLORS[axis];
      out += `<line x1="${cx}" y1="${cy}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="#000" stroke-opacity="0.7" stroke-width="4" stroke-linecap="round"/>` +
        `<line x1="${cx}" y1="${cy}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="${col}" stroke-width="2" stroke-linecap="round"/>`;
      if (Math.hypot(dx, dy) > 7) {
        const k = 1 + 9 / Math.hypot(dx, dy);
        out += `<text x="${(cx + dx * k).toFixed(1)}" y="${(cy + dy * k + 4).toFixed(1)}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="${col}" stroke="#000" stroke-opacity="0.7" stroke-width="3" paint-order="stroke">${axis.toUpperCase()}</text>`;
      }
    });
    return out;
  }

  updateHud(text = "") {
    this.hudEl.textContent = this.error ?? text;
    this.hudEl.classList.toggle("error", !!this.error);
  }

  // -------------------------------------------------------------------- input

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hover(x, y) {
    const p = this.plane;
    const q = this.voxelAt(x, y);
    const d = this.state.dims;
    if (!q || q.x < 0 || q.y < 0 || q.z < 0 || q.x >= d.x || q.y >= d.y || q.z >= d.z) { this.updateHud(); return; }
    const i = Math.floor(q.col), j = Math.floor(q.row);
    let value = "";
    if (i >= 0 && j >= 0 && i < p.width && j < p.height) {
      const val = p.data[j * p.width + i];
      value = ` = ${Number.isInteger(val) ? val : val.toPrecision(5)}`;
    }
    this.updateHud(`x ${Math.floor(q.x)}  y ${Math.floor(q.y)}  z ${Math.floor(q.z)}${value}`);
  }

  /** Moves the cursor to the point under a pane pixel (inside the volume only). */
  pick(x, y) {
    const q = this.voxelAt(x, y);
    if (!q) return;
    const d = this.state.dims;
    if (q.x < 0 || q.y < 0 || q.z < 0 || q.x >= d.x || q.y >= d.y || q.z >= d.z) return;
    this.state.setCursor({ x: q.x, y: q.y, z: q.z }, "angled");
  }

  zoom(factor) {
    const st = this.state;
    st.setAngled({ fov: st.angled.fov / factor }, "angled");
  }

  bindInput() {
    const el = this.el;
    const st = () => this.state;
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".slice-head")) return;
      const mode = e.button === 0 ? "pick" : e.button === 2 ? "window" : null;
      if (!mode) return;
      e.preventDefault();
      el.focus({ preventScroll: true });
      el.setPointerCapture(e.pointerId);
      const { x, y } = this.local(e);
      this.drag = { mode, id: e.pointerId, x, y };
      st().beginInteraction();
      if (mode === "pick") this.pick(x, y);
    });
    el.addEventListener("pointermove", (e) => {
      const { x, y } = this.local(e);
      if (!this.drag) { this.hover(x, y); return; }
      if (this.drag.id !== e.pointerId) return;
      const dx = x - this.drag.x, dy = y - this.drag.y;
      this.drag.x = x;
      this.drag.y = y;
      if (this.drag.mode === "pick") this.pick(x, y);
      else st().setWindow(dragWindow(st().window, dx, dy, st().dtype));
    });
    const end = (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.drag = null;
      st().endInteraction();
      this.sync(); // re-cut the plane through the point that was picked
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", () => { if (!this.drag) this.updateHud(); });

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)));
    }, { passive: false });
    el.addEventListener("dblclick", (e) => {
      if (!e.target.closest(".slice-head")) st().resetAngled("angled");
    });
    el.addEventListener("keydown", (e) => {
      const s = st();
      const step = e.shiftKey ? 10 : 1;
      const a = s.angled;
      let handled = true;
      if (e.key === "i") s.setInvert(!s.invert);
      else if (e.key === "w") s.resetWindow();
      else if (e.key === "Home" || e.key === "r") s.resetAngled("angled");
      else if (e.key === "+" || e.key === "=") this.zoom(1.25);
      else if (e.key === "-") this.zoom(0.8);
      else if (e.key === "ArrowLeft") s.setAngled({ rz: a.rz - step }, "angled");
      else if (e.key === "ArrowRight") s.setAngled({ rz: a.rz + step }, "angled");
      else if (e.key === "ArrowUp") s.setAngled({ rx: a.rx - step }, "angled");
      else if (e.key === "ArrowDown") s.setAngled({ rx: a.rx + step }, "angled");
      else handled = false;
      if (handled) e.preventDefault();
    });
    el.querySelector(".slice-btns").addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "zoom-in") this.zoom(1.25);
      else if (act === "zoom-out") this.zoom(0.8);
      else if (act === "reset") st().resetAngled("angled");
    });
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
