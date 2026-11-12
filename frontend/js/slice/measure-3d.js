// Placing and moving measurement points in the 3D view. While the ruler is on, a click (a press and release without
// moving) in the 3D view places a point; dragging still rotates the view, because the click is only noticed, not
// taken. The points of a measurement can be dragged: a press on one takes over from the camera controls, and the
// point follows the pointer at its depth.
//
// Where a click lands (SliceState.measure3dMode):
//  - "surface": where the ray first meets what the view shows, found in a coarse copy of the volume that is loaded
//    when the ruler is turned on (see CoarseVolume in measure.js). It follows the render mode, the transfer function,
//    the window and the clipping, and is accurate to about half a coarse voxel (shown with the measurement); fine-tune
//    the end in a slice pane.
//  - "planes": on the three slice planes shown in the 3D view (exact; move them with the cursor).

import { AXES } from "./geometry.js";
import { hitHandle, loadCoarseVolume, pickPlanes, pickVolume, pixelRay, repositionAtDepth } from "./measure.js";

const show3d = (layout) => layout === "3d" || layout === "quad"; // as SliceViews.show3d (not imported: it imports this)
const CLICK_PX = 5;      // a press that moves further is a drag (the camera's)
const CLICK_MS = 700;    // a press that lasts longer is not a click
const HANDLE_PX = 12;    // how close a press must be to a point to take it
const HOVER_MS = 60;     // live preview of the second point: at most this often

export class Measure3D {
  /**
   * @param {{views: import("./slice-views.js").SliceViews, host: HTMLElement}} o  host: the element that holds the kiln canvas and the 3D overlay
   */
  constructor({ views, host }) {
    this.views = views;
    this.host = host;
    this.viewer = null;
    this.coarse = null;
    this.status = "";                 // shown in the controls
    this.readyText = "";
    this._loading = null;
    this._abort = null;
    this._down = null;                // a press that may become a click
    this._drag = null;                // a point being dragged
    this._pointers = new Set();
    this._hoverAt = 0;
    const st = views.state;
    this._offs = [
      st.on("measuring", () => { if (st.measuring) this.ensureCoarse(); else this._clearHover(); }),
      st.on("measure3d", () => { if (st.measuring) this.ensureCoarse(); }),
    ];
    this._onDown = (e) => this._down_(e);
    this._onMove = (e) => this._move(e);
    this._onUp = (e) => this._up(e);
    this._onCancel = (e) => { this._pointers.delete(e.pointerId); this._down = null; this._endDrag(e); };
    host.addEventListener("pointerdown", this._onDown, true);
    host.addEventListener("pointermove", this._onMove, true);
    host.addEventListener("pointerup", this._onUp, true);
    host.addEventListener("pointercancel", this._onCancel, true);
  }

  attachViewer(viewer) {
    this.viewer = viewer;
    if (this.views.state.measuring) this.ensureCoarse();
  }
  detachViewer() { this.viewer = null; }

  get active() {
    const st = this.views.state;
    return st.measuring && show3d(st.layout) && !!this.viewer?.camera;
  }

  _setStatus(text) {
    this.status = text;
    this.views.state._emit("measure3d-status", { status: text }); // (not "measure3d": that one starts the loading)
  }

  /** Starts loading the coarse volume if the ruler is on in surface mode and it has not been loaded. */
  ensureCoarse() {
    const st = this.views.state;
    if (this.coarse || this._loading || st.measure3dMode !== "surface") return this._loading;
    const provider = this.viewer?.engine?.dataProvider;
    if (!provider?.getMetadata) { this._setStatus("3D picking needs the 3D view"); return null; }
    this._abort = new AbortController();
    this._setStatus("Preparing 3D picking\u2026");
    this._loading = loadCoarseVolume(provider, {
      signal: this._abort.signal,
      onProgress: (d, t) => this._setStatus(`Preparing 3D picking\u2026 ${d} of ${t}`),
    }).then((vol) => {
      this.coarse = vol;
      this.readyText = `3D picking ready (about \u00b1${+vol.accuracy.toPrecision(2)} voxels)`;
      this._setStatus(this.readyText);
    }).catch((err) => {
      if (!err.cancelled) { console.error("[measure] coarse volume:", err); this._setStatus(`3D picking is not available: ${err.message}`); }
    }).finally(() => { this._loading = null; });
    return this._loading;
  }

  _local(e) {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _ray(x, y) {
    const cam = this.viewer.camera;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return null;
    return pixelRay(cam.getViewMatrix(), cam.getProjectionMatrix(w / h), w, h, x, y, cam.position ? Array.from(cam.position) : null);
  }

  /** The 3D point under pixel (x, y): { point, acc } (acc: accuracy in voxels, 0 = exact), or null. */
  pick(x, y) {
    const st = this.views.state;
    const v = this.viewer;
    const ray = v && this._ray(x, y);
    if (!ray) return null;
    const size = v.engine.config.normalizedSize;
    if (st.measure3dMode === "planes") {
      const hit = pickPlanes(ray, AXES.map((a) => st.paneGeom(a)), st.dims, size);
      return hit ? { point: hit.point, acc: 0 } : null;
    }
    if (!this.coarse) { this.ensureCoarse(); return null; }
    const r = v.renderer;
    const hit = pickVolume(this.coarse, ray, size, st.dims, {
      mode: v.mode === "mip" || v.mode === "iso" ? v.mode : "dvr",
      isoValue: v.isoValue,
      tf: { windowCenter: v.windowCenter, windowWidth: v.windowWidth, points: v.transferFunction?.getOpacityPoints?.(), densityScale: r?.densityScale ?? 1 },
      clip: r?.clipMin ? { min: Array.from(r.clipMin), max: Array.from(r.clipMax) } : null,
    });
    return hit ? { point: hit.point, acc: hit.accuracy } : null;
  }

  // ------------------------------------------------------------------------------ input
  _handles() { return this.views.overlay3d?.handles ?? []; }

  _down_(e) {
    this._pointers.add(e.pointerId);
    if (!this.active || e.button !== 0 || this._pointers.size > 1 || e.target?.tagName !== "CANVAS") { this._down = null; return; }
    const { x, y } = this._local(e);
    const st = this.views.state;
    // (the overlay redraws on the next frame: a ring of a measurement that was just deleted must not catch the press)
    const live = this._handles().filter((h) => (h.id === null ? !!st.pending : st.measures.some((m) => m.id === h.id)));
    const hit = hitHandle(live, x, y, HANDLE_PX);
    if (hit) { // take the point: the camera controls must not see this press
      e.stopImmediatePropagation();
      e.preventDefault();
      try { this.host.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
      this.views.state.selectMeasure(hit.id);
      this._drag = { id: e.pointerId, mid: hit.id, end: hit.end, moved: false };
      this.views.state.beginInteraction();
      return;
    }
    this._down = { id: e.pointerId, x, y, t: performance.now(), moved: false };
  }

  _move(e) {
    if (e.pointerId === this._drag?.id) {
      e.stopImmediatePropagation();
      this._drag.moved = true;
      this._dragTo(e);
      return;
    }
    if (this._down && e.pointerId === this._down.id) {
      const { x, y } = this._local(e);
      if (Math.hypot(x - this._down.x, y - this._down.y) > CLICK_PX) this._down.moved = true;
      return;
    }
    // hovering with a first point set: preview the line to what is under the pointer
    const st = this.views.state;
    if (!this.active || !st.pending || e.pointerType === "touch" || e.buttons) return;
    const now = performance.now();
    if (now - this._hoverAt < HOVER_MS) return;
    this._hoverAt = now;
    const { x, y } = this._local(e);
    const hit = e.target?.tagName === "CANVAS" ? this.pick(x, y) : null;
    this.views.overlay3d?.setRubber(hit?.point ?? null);
  }

  _dragTo(e) {
    const st = this.views.state, v = this.viewer;
    const m = this._drag.mid === null ? { [this._drag.end]: st.pending } : st.measures.find((q) => q.id === this._drag.mid);
    const point = m?.[this._drag.end];
    if (!point || !v) return;
    const { x, y } = this._local(e);
    const ray = this._ray(x, y);
    const cam = v.camera;
    const fwd = Array.from(cam.target ?? [0, 0, 0], (t, i) => t - cam.position[i]);
    const len = Math.hypot(...fwd) || 1;
    const next = ray && repositionAtDepth(point, ray, fwd.map((c) => c / len), st.dims, v.engine.config.normalizedSize);
    if (!next) return;
    if (this._drag.mid === null) st.setPending(next, st.pendingAcc);
    else st.movePoint(this._drag.mid, this._drag.end, next, 0);
  }

  _endDrag(e) {
    if (this._drag && e.pointerId === this._drag.id) {
      this._drag = null;
      this.views.state.endInteraction();
    }
  }

  _up(e) {
    this._pointers.delete(e.pointerId);
    if (this._drag && e.pointerId === this._drag.id) { e.stopImmediatePropagation(); this._endDrag(e); return; }
    const d = this._down;
    this._down = null;
    if (!d || d.id !== e.pointerId || d.moved || performance.now() - d.t > CLICK_MS || !this.active) return;
    this._place(d.x, d.y);
  }

  /** A click at (x, y): the first point, or the second one that completes the measurement. */
  _place(x, y) {
    const st = this.views.state;
    const hit = this.pick(x, y);
    if (!hit) {
      this._setStatus(this.coarse || st.measure3dMode === "planes" ? "Nothing there: click on the volume (or on a slice plane in Slice planes mode)" : this.status);
      return;
    }
    if (/^Nothing there/.test(this.status)) this._setStatus(this.readyText ?? ""); // the hint has done its job
    if (st.pending) {
      if (st.addMeasure(st.pending, hit.point, st.pendingAcc, hit.acc) === null) this._setStatus("At most 50 measurements: delete one first");
      this.views.overlay3d?.setRubber(null);
    } else {
      st.setPending(hit.point, hit.acc);
    }
  }

  _clearHover() { this.views.overlay3d?.setRubber(null); }

  dispose() {
    this._abort?.abort();
    this._offs.forEach((off) => off());
    const h = this.host;
    h.removeEventListener("pointerdown", this._onDown, true);
    h.removeEventListener("pointermove", this._onMove, true);
    h.removeEventListener("pointerup", this._onUp, true);
    h.removeEventListener("pointercancel", this._onCancel, true);
    this.coarse = null;
  }
}
