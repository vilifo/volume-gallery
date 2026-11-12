// The single source of truth for the slice views: cursor, per-pane views, window,
// layout. Panes, the 3D overlay and the URL sync all subscribe here.

import {
  AXES, AXIS_INFO, FRAME_HANDEDNESS, IDENTITY, PaneGeometry, clamp, defaultView, eulerToMatrix, fullRangeWindow,
  isAligned, matMul, matrixToEuler, nearestInPolygon, orthonormalize, rotAxis,
} from "./geometry.js";
import { MAX_MEASURES, decodeMeasures, encodeMeasures, roundPoint } from "./measure.js";
import { decodeTf, encodeTf, normalizeStops, presetStops } from "./transfer-function.js";


export const LAYOUTS = ["3d", "quad", "xy", "xz", "yz"];

// The orientation of the three slice planes as rotations about the volume's x, y, z axes (degrees; see geometry.js)
export const ANGLE_LIMITS = { rx: 180, ry: 90, rz: 180 };
const ZERO_PSI = () => ({ xy: 0, xz: 0, yz: 0 });

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
    // The cursor in continuous voxel coordinates (voxel i covers [i, i + 1)); `cursor` is the voxel it is in.
    this.pos = { x: Math.floor(dims.x / 2) + 0.5, y: Math.floor(dims.y / 2) + 0.5, z: Math.floor(dims.z / 2) + 0.5 };
    this.cursor = { x: Math.floor(dims.x / 2), y: Math.floor(dims.y / 2), z: Math.floor(dims.z / 2) };
    // The three slice planes are perpendicular and turn together about the cursor: R is their orientation, psi
    // the roll of each pane's picture (see paneFrame / rotateAboutPane).
    this.R = [...IDENTITY];
    this.psi = ZERO_PSI();
    this.maxSide = 4096; // the largest image a pane makes (the slice views set it from the GPU's limits)
    this._ver = 0;
    this._geom = {};
    this.views = Object.fromEntries(AXES.map((a) => [a, defaultView()]));
    this.flips = Object.fromEntries(AXES.map((a) => [a, { ...AXIS_INFO[a].flip }]));
    this.defaultWindow = win ?? fullRangeWindow(dtype);
    this.window = { ...this.defaultWindow };
    this.invert = false;
    this.channel = 0;
    this.layout = LAYOUTS.includes(layout) ? layout : "3d";
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

  /** Geometry of a pane's plane (cached until the cursor or the orientation changes). */
  paneGeom(axis) {
    const c = this._geom[axis];
    if (c?.ver === this._ver) return c.g;
    const g = new PaneGeometry({ axis, R: this.R, psi: this.psi, pos: this.pos, dims: this.dims, spacing: this.spacing, maxSide: this.maxSide });
    this._geom[axis] = { ver: this._ver, g };
    return g;
  }

  _clampPos(p) {
    const d = this.dims;
    return { x: clamp(p.x, 0, d.x - 1e-6), y: clamp(p.y, 0, d.y - 1e-6), z: clamp(p.z, 0, d.z - 1e-6) };
  }

  /** Sets the cursor from continuous voxel coordinates (any of x / y / z; clamped to the volume); emits "cursor". */
  setPos(partial, source = null) {
    const next = this._clampPos({ ...this.pos, ...Object.fromEntries(["x", "y", "z"].filter((a) => Number.isFinite(partial[a])).map((a) => [a, partial[a]])) });
    const changed = ["x", "y", "z"].filter((a) => Math.abs(next[a] - this.pos[a]) > 1e-9);
    if (!changed.length) return changed;
    this.pos = next;
    this._ver++;
    for (const a of ["x", "y", "z"]) this.cursor[a] = Math.floor(next[a]);
    this._emit("cursor", { changed, cursor: { ...this.cursor }, pos: { ...next }, source });
    return changed;
  }

  /** Sets any of x / y / z as voxel indices (the cursor goes to the centre of that voxel); emits "cursor" with the axes that moved. */
  setCursor(partial, source = null) {
    const p = {};
    for (const a of ["x", "y", "z"]) if (partial[a] !== undefined) p[a] = clamp(Math.round(partial[a]), 0, this.dims[a] - 1) + 0.5;
    return this.setPos(p, source);
  }

  /** Scrolls a pane: `delta` slices along its normal (a voxel for an axis-aligned plane, else the finest voxel size). */
  moveAlong(axis, delta, source = null) {
    const g = this.paneGeom(axis);
    const p = { ...this.pos };
    const keys = ["x", "y", "z"];
    const k = g.n.findIndex((c) => Math.abs(c) > 1 - 1e-9);
    if (k >= 0) {
      const a = keys[k];
      p[a] = clamp(Math.floor(this.pos[a]) + Math.round(delta) * Math.sign(g.n[k]), 0, this.dims[a] - 1) + 0.5;
    } else {
      keys.forEach((a, i) => { p[a] = this.pos[a] + (delta * g.pixel * g.n[i]) / this.spacing[a]; });
    }
    return this.setPos(p, source);
  }

  /** Moves the cursor `delta` pixels along a pane's image columns (a voxel for an axis-aligned plane). */
  moveInPlane(axis, delta, source = null) {
    const g = this.paneGeom(axis);
    const p = { ...this.pos };
    const keys = ["x", "y", "z"];
    const k = g.u.findIndex((c) => Math.abs(c) > 1 - 1e-9);
    if (k >= 0) {
      const a = keys[k];
      p[a] = clamp(Math.floor(this.pos[a]) + Math.round(delta) * Math.sign(g.u[k]), 0, this.dims[a] - 1) + 0.5;
    } else {
      keys.forEach((a, i) => { p[a] = this.pos[a] + (delta * g.pixel * g.u[i]) / this.spacing[a]; });
    }
    return this.setPos(p, source);
  }

  /** A pane's geometry for another cursor position (not cached), e.g. for slices that are saved without moving the cursor. */
  paneGeomAt(axis, pos, maxSide = this.maxSide) {
    return new PaneGeometry({ axis, R: this.R, psi: this.psi, pos, dims: this.dims, spacing: this.spacing, maxSide });
  }

  /** Click / drag in a pane: moves the cursor to plane coordinates (a, b) (the nearest point of the slice when outside). */
  setFromPane(axis, a, b, source = null) {
    const g = this.paneGeom(axis);
    const q = nearestInPolygon(g.polygon(), a, b);
    if (!q) return [];
    return this.setPos(g.unproject(q[0], q[1]), source);
  }

  // ------------------------------------------------------------- orientation

  get aligned() {
    return AXES.every((a) => isAligned(this.paneGeom(a).n));
  }

  /** The orientation as angles about the volume's x, y, z axes (degrees). */
  euler() {
    const e = matrixToEuler(this.R);
    const r = (v) => Math.round(v * 10) / 10 + 0; // + 0: no -0
    return { rx: r(e.rx), ry: r(e.ry), rz: r(e.rz) };
  }

  /** Runs `change`, then moves every pane's view so the cursor stays where it was on screen. */
  _keepCursorStill(change) {
    const off = {};
    for (const a of AXES) {
      const g = this.paneGeom(a), p = g.project(this.pos);
      off[a] = { u: p.a - g.width / 2, v: p.b - g.height / 2 };
    }
    change();
    this._ver++;
    for (const a of AXES) {
      const g = this.paneGeom(a), p = g.project(this.pos);
      const v = this.views[a];
      this.views[a] = { ...v, centerU: v.centerU + (p.a - g.width / 2 - off[a].u), centerV: v.centerV + (p.b - g.height / 2 - off[a].v) };
    }
  }

  /** Sets the orientation from angles about x, y, z (degrees); the pictures are not rolled. */
  setOrientation({ rx, ry, rz }, source = null) {
    const e = this.euler();
    const n = {
      rx: clamp(Number.isFinite(rx) ? rx : e.rx, -ANGLE_LIMITS.rx, ANGLE_LIMITS.rx),
      ry: clamp(Number.isFinite(ry) ? ry : e.ry, -ANGLE_LIMITS.ry, ANGLE_LIMITS.ry),
      rz: clamp(Number.isFinite(rz) ? rz : e.rz, -ANGLE_LIMITS.rz, ANGLE_LIMITS.rz),
    };
    const same = n.rx === e.rx && n.ry === e.ry && n.rz === e.rz && AXES.every((a) => this.psi[a] === 0);
    if (same) return false;
    this._keepCursorStill(() => {
      this.R = eulerToMatrix(n.rx, n.ry, n.rz);
      this.psi = ZERO_PSI();
    });
    this._emit("orientation", { source });
    return true;
  }

  /** Back to the axis-aligned planes. */
  resetOrientation(source = null) {
    if (this.R.every((c, i) => c === IDENTITY[i]) && AXES.every((a) => this.psi[a] === 0)) return false;
    this._keepCursorStill(() => { this.R = [...IDENTITY]; this.psi = ZERO_PSI(); });
    this._emit("orientation", { source });
    return true;
  }

  /** What rotateAboutPane starts from: take it when a drag starts. */
  orientationSnapshot() {
    return { R: [...this.R], psi: { ...this.psi } };
  }

  /**
   * Turns the three planes about the cursor around the normal of pane `axis`, by `angle` radians seen in that
   * pane's picture (from u towards v) from the orientation `snap` (a drag's start). The picture of that pane
   * stays as it is (its roll compensates), so the crosshair lines turn against a still image.
   */
  rotateAboutPane(axis, angle, snap = this.orientationSnapshot(), source = null) {
    const theta = FRAME_HANDEDNESS[axis] * angle; // a turn about the normal, in the sense the normal is right-handed
    const nb = { xy: [0, 0, 1], xz: [0, 1, 0], yz: [1, 0, 0] }[axis];
    this._keepCursorStill(() => {
      this.R = orthonormalize(matMul(snap.R, rotAxis(nb, theta)));
      this.psi = { ...snap.psi, [axis]: snap.psi[axis] - theta };
    });
    this._emit("orientation", { source });
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
    const centred = ["x", "y", "z"].every((a) => Math.abs(this.pos[a] - this.cursor[a] - 0.5) < 1e-6);
    p.cursor = centred ? `${this.cursor.x},${this.cursor.y},${this.cursor.z}` : ["x", "y", "z"].map((a) => (+this.pos[a].toFixed(3)).toString()).join(","); // whole numbers: voxel indices
    if (this.layout !== "3d") p.layout = this.layout;
    if (this.window.center !== this.defaultWindow.center || this.window.width !== this.defaultWindow.width) {
      p.win = `${+this.window.center.toPrecision(7)},${+this.window.width.toPrecision(7)}`;
    }
    if (this.channel) p.ch = String(this.channel);
    const e = this.euler();
    if (e.rx || e.ry || e.rz) p.ang = `${e.rx},${e.ry},${e.rz}`;
    if (AXES.some((a) => Math.abs(this.psi[a]) > 1e-9)) p.roll = AXES.map((a) => +((this.psi[a] * 180) / Math.PI).toFixed(2)).join(",");
    if (this.tf.preset !== "gray") p.stf = encodeTf(this.tf);
    if (this.measures.length) p.meas = encodeMeasures(this.measures); // the distances travel with the link
    return p;
  }

  /** Applies parameters produced by toParams (unknown / malformed values are ignored). */
  applyParams(params) {
    const get = (k) => (params instanceof URLSearchParams ? params.get(k) : params[k]);
    const cur = (get("cursor") ?? "").split(",").map(Number);
    if (cur.length === 3 && cur.every(Number.isFinite)) {
      const [x, y, z] = cur; // whole numbers are voxel indices, anything else continuous coordinates
      this.setPos({ x: Number.isInteger(x) ? x + 0.5 : x, y: Number.isInteger(y) ? y + 0.5 : y, z: Number.isInteger(z) ? z + 0.5 : z }, "url");
    }
    const win = (get("win") ?? "").split(",").map(Number);
    if (win.length === 2 && win.every(Number.isFinite) && win[1] > 0) this.setWindow({ center: win[0], width: win[1] });
    const ch = Number(get("ch"));
    if (Number.isFinite(ch) && get("ch") !== null) this.setChannel(ch);
    const ang = (get("ang") ?? "").split(",").map(Number); // (links of the old angled view carry a fourth number: ignored)
    if (ang.length >= 3 && ang.length <= 4 && ang.slice(0, 3).every(Number.isFinite)) {
      this.setOrientation({ rx: ang[0], ry: ang[1], rz: ang[2] }, "url");
      const roll = (get("roll") ?? "").split(",").map(Number);
      if (roll.length === 3 && roll.every(Number.isFinite)) {
        const R = this.R;
        this._keepCursorStill(() => { this.R = R; this.psi = Object.fromEntries(AXES.map((a, i) => [a, (roll[i] * Math.PI) / 180])); });
        this._emit("orientation", { source: "url" });
      }
    }
    const tf = decodeTf(get("stf") ?? "");
    if (tf) {
      this.tf = tf;
      this._emit("tf");
    }
    const layout = get("layout");
    if (layout) this.setLayout(layout === "angled" ? "quad" : layout); // (the angled view is now any of the three panes)
    const meas = get("meas");
    if (meas) {
      this.measures = [];
      for (const m of decodeMeasures(meas, this.dims)) this.measures.push({ id: this._measureId++, a: m.a, b: m.b, label: `M${this._measureId - 1}`, accA: 0, accB: 0, acc: 0 });
      this._emit("measure", { kind: "loaded" });
    }
  }
}
