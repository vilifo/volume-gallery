// The single source of truth for the slice views: cursor, per-pane views, window,
// layout. Panes, the 3D overlay and the URL sync all subscribe here.

import { AXES, AXIS_INFO, clamp, defaultView, fullRangeWindow } from "./geometry.js";
import { MAX_MEASURES, decodeMeasures, encodeMeasures, roundPoint } from "./measure.js";
import { decodeTf, encodeTf, normalizeStops, presetStops } from "./transfer-function.js";


export const LAYOUTS = ["3d", "quad", "xy", "xz", "yz", "angled"];

// Angled slice: rotation about the volume's x, y, z axes (degrees) and the field-of-view factor (see oblique-pane.js)
export const ANGLE_LIMIT = 180;
export const FOV_RANGE = [0.05, 4];

export class SliceState {
  /**
   * @param {{dims:{x:number,y:number,z:number}, spacing:{x:number,y:number,z:number}, dtype:string,
   *          window?:{center:number,width:number}, channels?:number, layout?:string, unit?:string|null}} o
   *   unit: what `spacing` is in (volume.json's unit); distances are measured in it
   */
  constructor({ dims, spacing, dtype, window: win, channels = 1, layout = "3d", unit = null }) {
    this.dims = dims;
    this.spacing = spacing;
    this.unit = unit;
    this.dtype = dtype;
    this.channels = channels;
    this.cursor = { x: Math.floor(dims.x / 2), y: Math.floor(dims.y / 2), z: Math.floor(dims.z / 2) };
    this.views = Object.fromEntries(AXES.map((a) => [a, defaultView(a, dims)]));
    this.flips = Object.fromEntries(AXES.map((a) => [a, { ...AXIS_INFO[a].flip }]));
    this.defaultWindow = win ?? fullRangeWindow(dtype);
    this.window = { ...this.defaultWindow };
    this.invert = false;
    this.channel = 0;
    this.layout = LAYOUTS.includes(layout) ? layout : "3d";
    this.angled = { rx: 0, ry: 0, rz: 0, fov: 1 }; // the angled slice: XY plane rotated about x, then y, then z; fov: 1 = default, < 1 zoomed in
    this.linkZoom = false;
    this.showCrosshair = true;
    this.showScaleBar = true; // length reference in each slice pane
    this.show3dPlanes = true; // outlines of the three planes over the 3D view
    this.show3dCursor = true; // the cursor (three crossing lines + dot) over the 3D view
    this.tf = { preset: "gray", stops: presetStops("gray") }; // colours over the windowed range
    this.interacting = false;
    // Distance measuring. Points are in continuous voxel coordinates (see measure.js); a measurement is
    // { id, a, b, label, accA, accB, acc }: how far off each end can be (a point picked in the 3D view is only
    // as exact as the coarse volume it was found in, in voxels; 0 = exact) and the larger of the two.
    this.measures = [];
    this.measuring = false;       // the ruler is on: clicks place points instead of moving the cursor
    this.pending = null;          // the first point of a measurement that is being made
    this.pendingAcc = 0;
    this.measureSel = null;       // id of the selected measurement
    this.measure3dMode = "surface"; // where a click in the 3D view lands: "surface" (approximate) | "planes" (exact)
    this._measureId = 1;
    this._listeners = new Map();
    this._interactTimer = null;
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, detail = {}) {
    for (const fn of this._listeners.get(event) ?? []) fn(detail);
    if (event !== "change") for (const fn of this._listeners.get("change") ?? []) fn({ event, ...detail });
  }

  // ------------------------------------------------------------------- cursor

  /** Sets any of x / y / z (voxel indices, clamped); emits "cursor" with the axes that moved. */
  setCursor(partial, source = null) {
    const changed = [];
    for (const a of ["x", "y", "z"]) {
      if (partial[a] === undefined) continue;
      const v = clamp(Math.round(partial[a]), 0, this.dims[a] - 1);
      if (v !== this.cursor[a]) {
        this.cursor[a] = v;
        changed.push(a);
      }
    }
    if (changed.length) this._emit("cursor", { changed, cursor: { ...this.cursor }, source });
    return changed;
  }

  moveAlong(axis, delta, source = null) {
    const n = AXIS_INFO[axis].normal;
    return this.setCursor({ [n]: this.cursor[n] + delta }, source);
  }

  /** Click / drag in a pane: sets the two in-plane coordinates from continuous plane coordinates. */
  setFromPlane(axis, u, v, source = null) {
    const { u: ua, v: va } = AXIS_INFO[axis];
    return this.setCursor({ [ua]: Math.floor(u), [va]: Math.floor(v) }, source);
  }

  // -------------------------------------------------------------------- views

  setView(axis, view, source = null) {
    const prev = this.views[axis];
    this.views[axis] = { ...prev, ...view };
    this._emit("view", { axis, source });
    if (this.linkZoom && view.zoom !== undefined && view.zoom !== prev.zoom) {
      for (const other of AXES) {
        if (other === axis || this.views[other].zoom === view.zoom) continue;
        this.views[other] = { ...this.views[other], zoom: view.zoom };
        this._emit("view", { axis: other, source });
      }
    }
  }

  resetView(axis) {
    this.views[axis] = defaultView(axis, this.dims);
    this._emit("view", { axis });
  }

  toggleFlip(axis, which) {
    this.flips[axis][which] *= -1;
    this._emit("view", { axis });
  }

  // ------------------------------------------------------ window and the rest

  setWindow(win) {
    this.window = { center: win.center, width: Math.max(win.width, 1e-6) };
    this._emit("window");
  }
  resetWindow() {
    this.setWindow(this.defaultWindow);
  }
  setInvert(v) {
    this.invert = !!v;
    this._emit("window");
  }
  setChannel(c) {
    const ch = clamp(Math.round(c), 0, this.channels - 1);
    if (ch !== this.channel) {
      this.channel = ch;
      this._emit("channel");
    }
  }
  // ----------------------------------------------------------------- transfer function

  /** Selects a preset colour map; unknown names are ignored. */
  setTfPreset(name) {
    const stops = presetStops(name);
    if (!stops) return;
    this.tf = { preset: name, stops };
    this._emit("tf");
  }

  /** Replaces the colour stops (the transfer function becomes "custom"). */
  setTfStops(stops) {
    const norm = normalizeStops(stops);
    if (!norm || norm.length < 2) return;
    this.tf = { preset: "custom", stops: norm };
    this._emit("tf");
  }

  /** Changes the angled slice: any of { rx, ry, rz } (degrees, -180..180) and fov (field-of-view factor). */
  setAngled(patch, source = null) {
    const next = { ...this.angled };
    for (const k of ["rx", "ry", "rz"]) {
      if (patch[k] === undefined || !Number.isFinite(patch[k])) continue;
      next[k] = Math.round(clamp(patch[k], -ANGLE_LIMIT, ANGLE_LIMIT) * 10) / 10;
    }
    if (patch.fov !== undefined && Number.isFinite(patch.fov)) next.fov = +clamp(patch.fov, FOV_RANGE[0], FOV_RANGE[1]).toPrecision(4);
    if (["rx", "ry", "rz", "fov"].every((k) => next[k] === this.angled[k])) return false;
    this.angled = next;
    this._emit("angled", { angled: { ...next }, source });
    return true;
  }

  /** Back to the XY plane at the default field of view. */
  resetAngled(source = null) {
    return this.setAngled({ rx: 0, ry: 0, rz: 0, fov: 1 }, source);
  }

  setLayout(layout) {
    if (!LAYOUTS.includes(layout) || layout === this.layout) return;
    this.layout = layout;
    this._emit("layout", { layout });
  }
  setOption(name, value) {
    this[name] = value;
    this._emit("option", { name });
  }

  /** Marks active manipulation (drag / wheel burst); previews are used until it ends. */
  beginInteraction(holdMs = 0) {
    clearTimeout(this._interactTimer);
    if (!this.interacting) {
      this.interacting = true;
      this._emit("interaction", { active: true });
    }
    if (holdMs) this._interactTimer = setTimeout(() => this.endInteraction(), holdMs);
  }
  endInteraction() {
    clearTimeout(this._interactTimer);
    if (this.interacting) {
      this.interacting = false;
      this._emit("interaction", { active: false });
    }
  }

  // ------------------------------------------------------------------------- measuring

  setMeasuring(on) {
    on = !!on;
    if (on === this.measuring) return;
    this.measuring = on;
    if (!on && this.pending) { this.pending = null; this._emit("measure", { kind: "pending" }); }
    this._emit("measuring", { on });
  }

  /** The first point of a measurement (null cancels it). */
  setPending(p, acc = 0) {
    this.pending = p ? roundPoint(p) : null;
    this.pendingAcc = p ? acc : 0;
    this._emit("measure", { kind: "pending" });
  }

  /** Completes a measurement; returns its id, or null when there are already MAX_MEASURES. accA / accB: see the constructor. */
  addMeasure(a, b, accA = 0, accB = 0) {
    if (this.measures.length >= MAX_MEASURES) return null;
    const id = this._measureId++;
    this.measures.push({ id, a: roundPoint(a), b: roundPoint(b), label: `M${id}`, accA, accB, acc: Math.max(accA, accB) });
    this.pending = null;
    this.pendingAcc = 0;
    this.measureSel = id;
    this._emit("measure", { kind: "added", id });
    return id;
  }

  /** Moves one end ("a" | "b") of a measurement. */
  movePoint(id, end, p, acc = 0) {
    const m = this.measures.find((q) => q.id === id);
    if (!m || (end !== "a" && end !== "b")) return;
    m[end] = roundPoint(p);
    m[end === "a" ? "accA" : "accB"] = acc; // an end set by hand in a slice is exact
    m.acc = Math.max(m.accA, m.accB);
    this._emit("measure", { kind: "moved", id });
  }

  removeMeasure(id) {
    const i = this.measures.findIndex((q) => q.id === id);
    if (i < 0) return;
    this.measures.splice(i, 1);
    if (this.measureSel === id) this.measureSel = null;
    this._emit("measure", { kind: "removed", id });
  }

  clearMeasures() {
    if (!this.measures.length && !this.pending) return;
    this.measures = [];
    this.pending = null;
    this.pendingAcc = 0;
    this.measureSel = null;
    this._emit("measure", { kind: "cleared" });
  }

  selectMeasure(id) {
    if (id === this.measureSel) return;
    this.measureSel = id;
    this._emit("measure", { kind: "selected", id });
  }

  setMeasure3dMode(mode) {
    if (mode !== "surface" && mode !== "planes") return;
    this.measure3dMode = mode;
    this._emit("measure3d", { mode });
  }

  // ---------------------------------------------------------------------- URL

  /** Query parameters describing this state (only what differs from the defaults). */
  toParams() {
    const p = {};
    p.cursor = `${this.cursor.x},${this.cursor.y},${this.cursor.z}`;
    if (this.layout !== "3d") p.layout = this.layout;
    if (this.window.center !== this.defaultWindow.center || this.window.width !== this.defaultWindow.width) {
      p.win = `${+this.window.center.toPrecision(7)},${+this.window.width.toPrecision(7)}`;
    }
    if (this.channel) p.ch = String(this.channel);
    const a = this.angled;
    if (a.rx || a.ry || a.rz || a.fov !== 1) p.ang = `${a.rx},${a.ry},${a.rz}${a.fov !== 1 ? `,${a.fov}` : ""}`;
    if (this.tf.preset !== "gray") p.stf = encodeTf(this.tf);
    if (this.measures.length) p.meas = encodeMeasures(this.measures); // the distances travel with the link
    return p;
  }

  /** Applies parameters produced by toParams (unknown / malformed values are ignored). */
  applyParams(params) {
    const get = (k) => (params instanceof URLSearchParams ? params.get(k) : params[k]);
    const cur = (get("cursor") ?? "").split(",").map(Number);
    if (cur.length === 3 && cur.every(Number.isFinite)) this.setCursor({ x: cur[0], y: cur[1], z: cur[2] }, "url");
    const win = (get("win") ?? "").split(",").map(Number);
    if (win.length === 2 && win.every(Number.isFinite) && win[1] > 0) this.setWindow({ center: win[0], width: win[1] });
    const ch = Number(get("ch"));
    if (Number.isFinite(ch) && get("ch") !== null) this.setChannel(ch);
    const ang = (get("ang") ?? "").split(",").map(Number);
    if (ang.length >= 3 && ang.length <= 4 && ang.every(Number.isFinite)) {
      this.setAngled({ rx: ang[0], ry: ang[1], rz: ang[2], ...(ang.length === 4 && ang[3] > 0 ? { fov: ang[3] } : {}) }, "url");
    }
    const tf = decodeTf(get("stf") ?? "");
    if (tf) {
      this.tf = tf;
      this._emit("tf");
    }
    const layout = get("layout");
    if (layout) this.setLayout(layout);
    const meas = get("meas");
    if (meas) {
      this.measures = [];
      for (const m of decodeMeasures(meas, this.dims)) this.measures.push({ id: this._measureId++, a: m.a, b: m.b, label: `M${this._measureId - 1}`, accA: 0, accB: 0, acc: 0 });
      this._emit("measure", { kind: "loaded" });
    }
  }
}
