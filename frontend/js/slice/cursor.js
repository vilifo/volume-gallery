// The single source of truth for the slice views: cursor, per-pane views, window,
// layout. Panes, the 3D overlay and the URL sync all subscribe here.

import { AXES, AXIS_INFO, clamp, defaultView, fullRangeWindow } from "./geometry.js";
import { decodeTf, encodeTf, normalizeStops, presetStops } from "./transfer-function.js";


export const LAYOUTS = ["3d", "quad", "xy", "xz", "yz"];

export class SliceState {
  /**
   * @param {{dims:{x:number,y:number,z:number}, spacing:{x:number,y:number,z:number}, dtype:string,
   *          window?:{center:number,width:number}, channels?:number, layout?:string}} o
   */
  constructor({ dims, spacing, dtype, window: win, channels = 1, layout = "3d" }) {
    this.dims = dims;
    this.spacing = spacing;
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
    this.linkZoom = false;
    this.showCrosshair = true;
    this.showScaleBar = true; // length reference in each slice pane
    this.show3dPlanes = true; // outlines of the three planes over the 3D view
    this.show3dCursor = true; // the cursor (three crossing lines + dot) over the 3D view
    this.tf = { preset: "gray", stops: presetStops("gray") }; // colours over the windowed range
    this.interacting = false;
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

  /** Voxel value formatting helper for the HUD. */
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
    if (this.tf.preset !== "gray") p.stf = encodeTf(this.tf);
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
    const tf = decodeTf(get("stf") ?? "");
    if (tf) {
      this.tf = tf;
      this._emit("tf");
    }
    const layout = get("layout");
    if (layout) this.setLayout(layout);
  }
}
