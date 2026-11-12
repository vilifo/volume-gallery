// Slice views: three 2D panes (xy / xz / yz) next to the kiln 3D view.
//
//   server (plan + blocks) -> PlaneClient -> PlaneAssembler -> SliceRenderer (WebGPU, one texture per pane)
//                                ^                                   ^
//                                |                                   +-- drawn on demand, never in a free-running loop
//   SliceState (cursor, orientation, views, window, layout) <-- pointer / wheel / keyboard input
//
// Every pane reads the same SliceState. The three panes show three perpendicular planes through the cursor;
// clicking in a pane moves the cursor, and dragging one of its crosshair lines turns the three planes together
// about the cursor, so any pane can show a plane at any angle. A pane asks the server for the plan of its plane
// (a PaneGeometry), fetches the blocks that plan reads from (the ones most pixels need first) and shows the image
// as it fills in.

import { PlaneClient } from "./plane-client.js?v=mpr1";
import { SliceRenderer, requestSliceDevice } from "./slice-renderer.js?v=mpr1";
import { SliceState } from "./cursor.js?v=mpr1";
import { bindTouchGestures } from "./touch-gestures.js?v=org6";
import { buildLut, isGrayRamp } from "./transfer-function.js";
import { Overlay3D } from "./overlay-3d.js?v=mpr1";
import { hitHandle, paneMeasureSvg, pointFromPane, roundPoint } from "./measure.js?v=mpr1";
import { Measure3D } from "./measure-3d.js?v=mpr1";
import { ensureMeasureStyles } from "./measure-ui.js?v=meas1";
import { niceScaleLength } from "../scalebar.js";
import {
  lineInBox, AXES, AXIS_INFO, AXIS_COLORS, absView, clamp, clipLineToPolygon, dragWindow, isAligned,
  paneScale, pixelToPlane, planeToPixel, textureFormatFor, zoomAt,
} from "./geometry.js";

const NS = "http://www.w3.org/2000/svg";
const UNIT_LABEL = { micrometer: "\u00b5m", millimeter: "mm", nanometer: "nm", centimeter: "cm", meter: "m" };
const HOLD_MS = 120;      // a new image replaces the one on screen when it is complete, or after this long (then it fills in)
const GAP_PX = 12;        // the crosshair lines leave this much room around the cursor (a press there moves the cursor)
const LINE_HIT_PX = 7;    // how close a press must be to a crosshair line to take it
const ROT_SNAP = Math.PI / 12; // Shift while turning the lines: steps of 15 degrees
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const sameFrame = (a, b) => a.width === b.width && a.height === b.height && a.pixel === b.pixel
  && a.u.every((c, i) => Math.abs(c - b.u[i]) < 1e-9) && a.v.every((c, i) => Math.abs(c - b.v[i]) < 1e-9);

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
    this.shown = null;       // what the texture holds: { geom, key, plane, complete }
    this.load = null;        // the image being loaded: { key, geom, ac, t0, asm, swapped, timer }
    this.lines = [];         // the crosshair lines as drawn, in pane pixels (hit testing)
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

    const info = AXIS_INFO[axis];
    el.classList.add("slice-pane", "slice-pane-2d");
    el.dataset.visible = "0";
    el.tabIndex = 0;
    el.innerHTML = `
      <canvas class="slice-canvas"></canvas>
      <svg class="slice-svg" xmlns="${NS}"></svg>
      <div class="slice-head">
        <span class="slice-title" style="color:${AXIS_COLORS[info.normal]}" title="${info.label} plane (scroll to move it along ${info.normal.toUpperCase()}; drag a crosshair line to turn the planes)">${info.label}</span>
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

  /** Key of the complete image on the texture (null while it is being replaced by one that is not complete yet). */
  get shownKey() {
    return this.shown?.complete ? this.shown.key : null;
  }

  get pendingKey() {
    return this.load?.key ?? null;
  }

  cancelPending() {
    const l = this.load;
    if (l) { l.ac.abort(); clearTimeout(l.timer); }
    this.load = null;
    this.setBusy(false);
  }

  keyFor(geom) {
    const st = this.state;
    return `${this.views.sliceInfo(this.axis).index}/${st.channel}/${geom.key}`;
  }

  /** Whether the pane's plane is the slice stack of its own axis (so scrolling, playing and saving by slice index make sense). */
  get alongOwnAxis() {
    const g = this.state.paneGeom(this.axis);
    const k = ["x", "y", "z"].indexOf(AXIS_INFO[this.axis].normal);
    return Math.abs(g.n[k]) > 1 - 1e-9;
  }

  /** Makes sure the image of the pane's plane (for the cursor and orientation now) is (being) loaded. */
  sync() {
    if (!this.visible) return;
    const st = this.state;
    const geom = st.paneGeom(this.axis);
    const key = this.keyFor(geom);
    if (this.shown?.complete && this.shown.key === key) { this.cancelPending(); return; }
    if (key === this.pendingKey) return;
    this.cancelPending(); // latest wins
    const ac = new AbortController();
    const load = { key, geom, ac, t0: performance.now(), asm: null, swapped: false, timer: 0 };
    this.load = load;
    this.busyTimer = setTimeout(() => { if (this.load === load) this.setBusy(true); }, 120);
    // while scrolling, the slice that was shown fills the picture until the blocks of the new one arrive
    const underlay = this.shown && sameFrame(this.shown.geom, geom) ? this.shown.plane : null;
    this.views.client
      .loadPlane(geom.spec(), { channel: st.channel, priority: 2, signal: ac.signal, underlay, onUpdate: (asm) => this.onLoadUpdate(load, asm) })
      .then(({ assembler }) => this.onLoadDone(load, assembler))
      .catch((err) => {
        if (err?.name === "AbortError" || this.load !== load) return;
        this.load = null;
        clearTimeout(load.timer);
        this.setBusy(false);
        this.error = err.message || String(err);
        this.updateHud();
        this.views.requestRender();
      });
  }

  /** The loading image has changed (cached blocks applied, or a chunk of the stream arrived). */
  onLoadUpdate(load, asm) {
    if (load !== this.load || !asm) return;
    load.asm = asm;
    if (!load.swapped) {
      const wait = HOLD_MS - (performance.now() - load.t0);
      if (this.shown && !asm.complete && wait > 0) { // keep the old image a moment: most loads are done by then
        load.timer ||= setTimeout(() => { load.timer = 0; this.onLoadUpdate(load, load.asm); }, wait + 2);
        return;
      }
      this.swap(load, asm);
      return;
    }
    const rows = asm.takeDirty();
    if (!rows) return;
    this.views.renderer.uploadRows(this.gpu, asm.plane, rows.r0, rows.r1);
    this.shown.complete = asm.complete;
    this.views.requestRender();
  }

  /** The loading image goes on the texture (in full; the rows that change after this are uploaded as they do). */
  swap(load, asm) {
    try {
      this.views.renderer.upload(this.gpu, asm.plane);
    } catch (err) {
      this.load = null;
      this.cancelPending();
      this.error = err.message;
      this.updateHud();
      return;
    }
    asm.takeDirty();
    load.swapped = true;
    this.error = null;
    this.shown = { geom: load.geom, key: load.key, plane: asm.plane, complete: asm.complete };
    this.views.requestRender();
  }

  onLoadDone(load, asm) {
    if (load !== this.load) return;
    clearTimeout(load.timer);
    this.load = null;
    this.setBusy(false);
    if (!load.swapped) this.swap(load, asm);
    else {
      const rows = asm.takeDirty();
      if (rows) this.views.renderer.uploadRows(this.gpu, asm.plane, rows.r0, rows.r1);
      this.shown.complete = true;
    }
    this.error = null;
    this.views.requestRender();
    this.prefetch();
  }

  /** While scrolling through slices, warms the cache with the blocks the next slices will need (only at block boundaries: the rest is cached). */
  prefetch() {
    if (!this.views.prefetchEnabled || !this.alongOwnAxis) return; // switched off while a slice sweep plays: only the image on screen is fetched
    const st = this.state;
    const normal = AXIS_INFO[this.axis].normal;
    const bs = this.views.info.blockSize || 64;
    const idx = st.cursor[normal];
    const dir = this.lastDir;
    const r = ((idx % bs) + bs) % bs;
    const near = dir > 0 ? bs - 1 - r : r; // slices to the next block
    if (near > 6) return;
    const target = dir > 0 ? idx + near + 1 : idx - near - 1;
    if (target < 0 || target >= st.dims[normal]) return;
    this.views.client.prefetchPlane(st.paneGeomAt(this.axis, { ...st.pos, [normal]: target + 0.5 }).spec(), { channel: st.channel });
  }

  setBusy(on) {
    clearTimeout(this.busyTimer);
    this.busyEl.hidden = !on;
  }

  // ------------------------------------------------------------ drawing

  ppv() {
    const st = this.state;
    return paneScale(st.paneGeom(this.axis), st.views[this.axis], this.size.width, this.size.height);
  }

  /** The view as absolute plane coordinates of the current geometry. */
  absView() {
    const st = this.state;
    return absView(st.views[this.axis], st.paneGeom(this.axis));
  }

  draw() {
    if (!this.visible) return;
    const st = this.state;
    const { dpr } = this.size;
    const ppv = this.ppv();
    // the texture is drawn in the frame of the image it holds (the same as the current one unless the orientation just changed)
    const tg = this.shown?.geom ?? st.paneGeom(this.axis);
    this.views.renderer.draw(this.gpu, this.ctx.getCurrentTexture().createView(), this.format, {
      width: this.canvas.width,
      height: this.canvas.height,
      extent: { u: tg.width, v: tg.height },
      view: absView(st.views[this.axis], tg),
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
    const geom = st.paneGeom(this.axis);
    const view = absView(st.views[this.axis], geom);
    const flip = st.flips[this.axis];
    const info = AXIS_INFO[this.axis];
    const toPx = (a, b) => planeToPixel(a, b, width, height, view, ppv, flip);
    const poly = geom.polygon().map(([a, b]) => toPx(a, b));
    const ptsAttr = poly.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
    const parts = [];
    if (poly.length >= 3) {
      if (!isAligned(geom.n)) { // a tilted plane: what is outside the volume is background
        parts.push(`<path d="M0,0H${width}V${height}H0Z M${poly.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join("L")}Z" fill="rgb(15,15,15)" fill-rule="evenodd"/>`);
      }
      parts.push(`<polygon points="${ptsAttr}" fill="none" stroke="#ffffff" stroke-opacity="0.18"/>`);
    }
    this.lines = [];
    const cp = geom.project(st.pos);
    const c = toPx(cp.a, cp.b);
    if (st.showCrosshair && poly.length >= 3) {
      const gap = GAP_PX / ppv.u; // in plane units
      for (const other of AXES) {
        if (other === this.axis) continue;
        const d = geom.lineDirection(other);
        const span = clipLineToPolygon([cp.a, cp.b], d, geom.polygon());
        if (!span) continue;
        const col = AXIS_COLORS[AXIS_INFO[other].normal]; // the plane `other` is the plane of constant <its normal axis>
        const at = (t) => toPx(cp.a + d[0] * t, cp.b + d[1] * t);
        const seg = (t0, t1) => {
          if (t1 - t0 < 1e-6) return "";
          const p = at(t0), q = at(t1);
          return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${col}" stroke-opacity="0.85"/>`;
        };
        const hot = this.hotLine === other || this.drag?.mode === "rotate";
        if (hot) parts.push(`<g stroke-width="2.6" stroke-linecap="round">${seg(span[0], Math.min(span[1], -gap))}${seg(Math.max(span[0], gap), span[1])}</g>`);
        else parts.push(seg(span[0], Math.min(span[1], -gap)), seg(Math.max(span[0], gap), span[1]));
        const e = at(1), f = at(0);
        const sd = { x: e.x - f.x, y: e.y - f.y }; // screen direction of the line (unit: ppv.u is the same along both axes)
        const sl = Math.hypot(sd.x, sd.y) || 1;
        this.lines.push({ other, x: c.x, y: c.y, dx: sd.x / sl, dy: sd.y / sl, t0: span[0] * ppv.u, t1: span[1] * ppv.u });
        for (const t of [span[1] - 14 / ppv.u, span[0] + 14 / ppv.u]) { // grips near the ends
          if (Math.abs(t) < gap + 20 / ppv.u) continue;
          const g = at(t);
          parts.push(`<circle cx="${g.x.toFixed(1)}" cy="${g.y.toFixed(1)}" r="${hot ? 4.5 : 3}" fill="${col}" fill-opacity="${hot ? 0.9 : 0.55}" stroke="#000" stroke-opacity="0.5"/>`);
        }
      }
      parts.push(`<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="none" stroke="#fff" stroke-opacity="0.9"/>`);
    }
    if (st.showScaleBar !== false) parts.push(scaleBarSvg(geom.pixel / ppv.u, width, height));
    const meas = paneMeasureSvg({
      geom, measures: st.measures, pending: st.pending, rubber: this.rubber,
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
    const zoom = st.views[this.axis].zoom;
    let where;
    if (this.alongOwnAxis) {
      const pos = (idx + 0.5) * st.spacing[n];
      const phys = this.views.info.unit ? ` \u00b7 ${fmtPos(pos, this.views.info.unit)}` : "";
      where = `${n} ${idx + 1} / ${st.dims[n]}${phys}`;
    } else {
      const e = st.euler();
      where = `tilted ${e.rx}\u00b0 ${e.ry}\u00b0 ${e.rz}\u00b0`;
    }
    const stale = this.load ? " \u00b7 \u2026" : "";
    const text = `${where}${zoom !== 1 ? ` \u00b7 ${Math.round(zoom * 100)}%` : ""}${stale}`;
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
    return pixelToPlane(x, y, this.size.width, this.size.height, this.absView(), this.ppv(), this.state.flips[this.axis]);
  }

  moveCursorTo(x, y) {
    const pt = this.planePoint(x, y);
    this.state.setFromPane(this.axis, pt.u, pt.v, this.axis);
  }

  /** Zooms by `factor` about the pointer; views are offsets from the image centre. */
  zoomBy(factor, x, y) {
    const s = this.state, g = s.paneGeom(this.axis);
    const r = zoomAt(this.absView(), factor, x, y, this.size.width, this.size.height, this.ppv(), s.flips[this.axis]);
    s.setView(this.axis, { zoom: r.zoom, centerU: r.centerU - g.width / 2, centerV: r.centerV - g.height / 2 });
  }

  panBy(dx, dy) {
    const s = this.state, ppv = this.ppv(), flip = s.flips[this.axis], v = s.views[this.axis];
    s.setView(this.axis, { centerU: v.centerU - (flip.u * dx) / ppv.u, centerV: v.centerV - (flip.v * dy) / ppv.v });
  }

  // ------------------------------------------------------------ turning the planes

  /** The crosshair line near a pixel, if a press there would take it (not the middle, which moves the cursor). */
  lineAt(x, y, tolerance = LINE_HIT_PX) {
    let best = null, bd = tolerance;
    for (const l of this.lines) {
      const rx = x - l.x, ry = y - l.y;
      const along = rx * l.dx + ry * l.dy;
      const across = Math.abs(-rx * l.dy + ry * l.dx);
      if (Math.abs(along) < GAP_PX || along < l.t0 - 4 || along > l.t1 + 4 || across > bd) continue;
      best = l;
      bd = across;
    }
    return best;
  }

  /** Angle of a pixel around the cursor in plane coordinates (from u towards v). */
  angleAt(x, y) {
    const g = this.state.paneGeom(this.axis), c = g.project(this.state.pos), q = this.planePoint(x, y);
    return Math.atan2(q.v - c.b, q.u - c.a);
  }

  startRotate(x, y) {
    const st = this.state;
    return { snap: st.orientationSnapshot(), last: this.angleAt(x, y), total: 0 };
  }

  /** Turns the planes so the lines follow the pointer at (x, y); `rot` is what startRotate returned. */
  rotateTo(rot, x, y, snapSteps) {
    const a = this.angleAt(x, y);
    rot.total += wrapPi(a - rot.last);
    rot.last = a;
    const angle = snapSteps ? Math.round(rot.total / ROT_SNAP) * ROT_SNAP : rot.total;
    this.state.rotateAboutPane(this.axis, angle, rot.snap, this.axis);
  }

  setHotLine(l) {
    const other = l?.other ?? null;
    if (other === this.hotLine) return;
    this.hotLine = other;
    this.el.style.cursor = other ? "grab" : "";
    this.views.requestRender();
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
      const { x, y } = this.local(e);
      const line = e.button === 0 && !e.shiftKey && !spaceDown ? this.lineAt(x, y) : null;
      const mode = line ? "rotate" : e.button === 1 || (e.button === 0 && (e.shiftKey || spaceDown)) ? "pan" : e.button === 0 ? "cursor" : e.button === 2 ? "window" : null;
      if (!mode) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.drag = { mode, id: e.pointerId, x, y, rot: mode === "rotate" ? this.startRotate(x, y) : null };
      if (mode === "rotate") this.el.style.cursor = "grabbing";
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
        this.setHotLine(st().showCrosshair && !st().measuring ? this.lineAt(x, y) : null);
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
      } else if (this.drag.mode === "rotate") {
        this.rotateTo(this.drag.rot, x, y, e.shiftKey);
      } else if (this.drag.mode === "pan") {
        this.panBy(dx, dy);
      } else {
        s.setWindow(dragWindow(s.window, dx, dy, s.dtype));
      }
    });

    const end = (e) => {
      if (this.mdrag && this.mdrag.id === e.pointerId) { this.measureEnd(); return; }
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const was = this.drag.mode;
      this.drag = null;
      if (was === "rotate") { const p = this.local(e); this.el.style.cursor = ""; this.setHotLine(this.lineAt(p.x, p.y)); }
      st().endInteraction();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", () => { if (!this.drag) { this.updateHud(); this.setHotLine(null); } });

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const s = st();
      if (e.ctrlKey || e.metaKey) {
        const { x, y } = this.local(e);
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        this.zoomBy(factor, x, y);
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
      const { x, y } = this.local(e);
      if (this.lineAt(x, y)) st().resetOrientation(this.axis); // a double-click on a crosshair line levels the planes
      else st().resetView(this.axis);
    });

    el.addEventListener("keydown", (e) => {
      const s = st();
      const k = e.key;
      const step = e.shiftKey ? 10 : 1;
      let handled = true;
      if (k === " ") spaceDown = true;
      else if (k === "ArrowUp" || k === "PageUp") { this.lastDir = 1; s.moveAlong(this.axis, k === "PageUp" ? 10 : step, this.axis); }
      else if (k === "ArrowDown" || k === "PageDown") { this.lastDir = -1; s.moveAlong(this.axis, -(k === "PageDown" ? 10 : step), this.axis); }
      else if (k === "ArrowLeft") s.moveInPlane(this.axis, -step, this.axis);
      else if (k === "ArrowRight") s.moveInPlane(this.axis, step, this.axis);
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

  /** The 3D point under a pixel of this pane: on the plane shown, inside the volume. */
  measurePoint(x, y) {
    const pt = this.planePoint(x, y);
    return roundPoint(pointFromPane(this.state.paneGeom(this.axis), pt.u, pt.v) ?? this.state.pos);
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
      end: () => { this.touchMeasureEnd(); this.trot = null; this.state.endInteraction(); },
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
      this.panBy(dx, dy);
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
      // a finger that starts on a crosshair line turns the planes; anywhere else it moves the cursor
      if (!this.trot) {
        const line = s.showCrosshair ? this.lineAt(x - dx, y - dy, 16) : null;
        this.trot = line ? this.startRotate(x - dx, y - dy) : { cursor: true };
      }
      if (this.trot.cursor) this.moveCursorTo(x, y);
      else this.rotateTo(this.trot, x, y, false);
    }
  }

  touchPinch({ factor, cx, cy, dx, dy }) {
    this.zoomBy(factor, cx, cy);
    this.panBy(dx, dy);
  }

  showTouchTool() {
    for (const b of this.el.querySelectorAll(".slice-tools button")) b.setAttribute("aria-pressed", String(b.dataset.tool === this.views.touchTool));
  }

  hover(x, y) {
    const st = this.state;
    const geom = st.paneGeom(this.axis);
    const pt = this.planePoint(x, y);
    const q = pointFromPane(geom, pt.u, pt.v);
    if (!q || Math.hypot(geom.project(q).a - pt.u, geom.project(q).b - pt.v) > 1e-6) { // outside the cut of the volume
      this.updateHud();
      return;
    }
    let value = "";
    const sh = this.shown;
    if (sh) { // the value where the pointer is, from the image on the texture (in its own frame)
      const s = sh.geom.project(q);
      const col = Math.floor(s.a), row = Math.floor(s.b);
      if (col >= 0 && row >= 0 && col < sh.plane.width && row < sh.plane.height) {
        const val = sh.plane.data[row * sh.plane.width + col];
        value = ` = ${Number.isInteger(val) ? val : val.toPrecision(5)}`;
      }
    }
    this.updateHud(`x ${Math.floor(q.x)}  y ${Math.floor(q.y)}  z ${Math.floor(q.z)}${value}`);
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
    state.maxSide = Math.min(device.limits.maxTextureDimension2D, 4096); // (before any geometry is made)
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

    this._needSync = false;
    this._offs = [
      state.on("cursor", ({ changed }) => {
        for (const axis of AXES) {
          const pane = this.panes[axis];
          const idx = state.cursor[AXIS_INFO[axis].normal];
          if (idx !== pane.prevIdx) pane.lastDir = Math.sign(idx - pane.prevIdx) || pane.lastDir; // scroll direction, for prefetching
          pane.prevIdx = idx;
        }
        this.requestSync();
      }),
      state.on("orientation", () => this.requestSync()),
      state.on("channel", () => { for (const p of Object.values(this.panes)) p.shown = null; this.requestSync(); }),
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

  /** The panes bring their images up to date before the next frame (a drag makes many changes per frame: one load each at most). */
  requestSync() {
    this._needSync = true;
    this.requestRender();
  }

  requestRender() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this._disposed) return;
      if (this._needSync) {
        this._needSync = false;
        for (const p of Object.values(this.panes)) p.sync();
      }
      for (const p of Object.values(this.panes)) p.draw();
      this.onRender?.();
    });
  }

  // ------------------------------------------------------------ saving a slice as an image

  /** Whether planes next to the one shown are fetched ahead (on by default; a playing sweep turns it off). */
  prefetchEnabled = true;
  setPrefetch(on) {
    this.prefetchEnabled = !!on;
  }

  /**
   * Where a pane is in its stack of slices: { index, count, own, t0, step }. For a pane along its own axis the
   * slices are the voxel layers; for a tilted plane they are steps of the finest voxel size along its normal,
   * through the cursor, from one side of the volume to the other (t0: where the first is, relative to the cursor).
   */
  sliceInfo(axis) {
    const st = this.state;
    const g = st.paneGeom(axis);
    const n = AXIS_INFO[axis].normal;
    if (this.panes[axis].alongOwnAxis) return { index: st.cursor[n], count: st.dims[n], own: true, t0: 0, step: 1 };
    const P = [st.pos.x * st.spacing.x, st.pos.y * st.spacing.y, st.pos.z * st.spacing.z];
    const seg = lineInBox(P, g.n, g.S);
    const d = (p) => (p[0] - P[0]) * g.n[0] + (p[1] - P[1]) * g.n[1] + (p[2] - P[2]) * g.n[2];
    const [ta, tb] = seg ? [d(seg[0]), d(seg[1])].sort((x, y) => x - y) : [0, 0];
    const step = g.pixel;
    return { index: Math.round(-ta / step) + 0, count: Math.max(1, Math.floor((tb - ta) / step + 1e-9) + 1), own: false, t0: ta, step };
  }

  /** The cursor position (voxel coordinates) of slice `index` of a pane's stack: the cursor moved along the pane's normal. */
  slicePos(axis, index) {
    const st = this.state;
    const info = this.sliceInfo(axis);
    if (info.own) return { ...st.pos, [AXIS_INFO[axis].normal]: clamp(Math.round(index), 0, info.count - 1) + 0.5 };
    const g = st.paneGeom(axis);
    const t = info.t0 + clamp(Math.round(index), 0, info.count - 1) * info.step;
    return { x: st.pos.x + (g.n[0] * t) / st.spacing.x, y: st.pos.y + (g.n[1] * t) / st.spacing.y, z: st.pos.z + (g.n[2] * t) / st.spacing.z };
  }

  /** Moves the cursor to slice `index` of a pane's stack (see sliceInfo). */
  setSlice(axis, index, source = null) {
    return this.state.setPos(this.slicePos(axis, index), source);
  }

  /** The slice panes on screen now: [{ axis, label, name, index, count, normal }] (a tilted pane has its stack of slices along its normal). */
  visibleSlices() {
    return AXES.filter((a) => this.panes[a].visible).map((axis) => {
      const info = AXIS_INFO[axis];
      const { index, count, own } = this.sliceInfo(axis);
      return {
        axis, index, count, normal: info.normal,
        label: own ? `${info.label} slice (${info.normal.toUpperCase()} = ${index})` : `${info.label} slice (tilted, ${index + 1} of ${count})`,
        name: `${info.label}-${own ? info.normal : "tilted"}${index}`,
      };
    });
  }

  /**
   * The part of a pane's image that is saved: [u0, u0 + width) x [v0, v0 + height) in image pixels (physical
   * pixels of the finest voxel size, see PaneGeometry). "whole" = the full image, "visible" = what the pane shows
   * at its current zoom and pan (clipped to the image).
   */
  exportRegion(axis, area) {
    const g = this.state.paneGeom(axis);
    if (area !== "visible") return { u0: 0, v0: 0, width: g.width, height: g.height };
    const pane = this.panes[axis];
    const ppv = pane.ppv();
    const view = absView(this.state.views[axis], g);
    const halfU = pane.size.width / ppv.u / 2;
    const halfV = pane.size.height / ppv.v / 2;
    const u0 = Math.max(0, Math.floor(view.centerU - halfU));
    const u1 = Math.min(g.width, Math.ceil(view.centerU + halfU));
    const v0 = Math.max(0, Math.floor(view.centerV - halfV));
    const v1 = Math.min(g.height, Math.ceil(view.centerV + halfV));
    return { u0, v0, width: Math.max(0, u1 - u0), height: Math.max(0, v1 - v0) };
  }

  /**
   * Saves a slice at the full resolution of the data: one image pixel per (finest) voxel, whatever the zoom.
   * Orientation (flips), window / level, invert and the colour table are those of the pane. A tilted plane is
   * saved as it is cut: what is outside the volume is zero.
   * @param {"xy"|"xz"|"yz"} axis
   * @param {{area?: "whole"|"visible", raw?: boolean, index?: number}} [o]  raw: the voxel values themselves,
   *   not the picture; index: a slice other than the cursor's (the cursor is not moved; for a pane that shows
   *   the slices of its own axis)
   * @returns {Promise<{width, height, rgba, gray} | {width, height, raw}>}
   */
  async exportSlice(axis, { area = "whole", raw = false, index } = {}) {
    const st = this.state;
    const shownGeom = st.paneGeom(axis);
    const region = this.exportRegion(axis, area);
    if (region.width < 1 || region.height < 1) throw new Error("The slice is not in view");
    // the full-resolution image (the pane may be showing a coarser one: the largest the GPU takes, at most what the server makes)
    const pos = index === undefined ? st.pos : this.slicePos(axis, index);
    const geom = st.paneGeomAt(axis, pos, Math.min(this.device.limits.maxTextureDimension2D, 16384));
    const k = shownGeom.pixel / geom.pixel; // (the pane's image can be coarser than the full-resolution one)
    const full = { u0: Math.round(region.u0 * k), v0: Math.round(region.v0 * k), width: Math.min(geom.width, Math.round(region.width * k)), height: Math.min(geom.height, Math.round(region.height * k)) };
    const { assembler } = await this.client.loadPlane(geom.spec(), { channel: st.channel, priority: 2 });
    const plane = assembler.plane;
    const { width, height } = full;
    const flip = st.flips[axis];
    const cu = full.u0 + width / 2;
    const cv = full.v0 + height / 2;

    if (raw) {
      // the same orientation as the picture; value (i, j) of the output is read straight from the image
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
        extent: { u: plane.width, v: plane.height },
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
    const c = this.client.stats();
    return {
      blocks: c.blocks, cacheMB: c.cacheMB, inflight: c.inflight, queued: c.queued,
      loads: c.loads, cachedBlocks: c.cached, fetchedBlocks: c.fetched, aborted: c.aborted, streamedMB: +(c.bytes / 1e6).toFixed(1),
      lastMs: +c.lastMs.toFixed(1), lastPlanMs: +c.lastPlanMs.toFixed(1), lastServerPlanMs: +c.lastServerPlanMs.toFixed(1),
      lastFirstMs: +c.lastFirstMs.toFixed(1), lastBlocks: c.lastBlocks,
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
    this.client.dispose();
    this.renderer.dispose();
    try { this.device.destroy(); } catch { /* already lost */ }
    this.grid.dataset.layout = "3d";
    if (this.pane3d) this.pane3d.dataset.visible = "1";
  }
}
