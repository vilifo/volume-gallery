// Draws the slice cursor and the three slice planes on top of the kiln 3D view. Both can be
// switched off independently (SliceState.show3dCursor / show3dPlanes).
//
// kiln-render's volume is a box centred at the origin with extents
// `engine.config.normalizedSize`; a plane at voxel index i of an axis with size N
// sits at (i + 0.5) / N - 0.5 of that extent (the same mapping kiln's own slice
// mode uses). The lines are drawn in an SVG layer above the canvas, so they are
// not occluded by the volume; that is intended for position indicators.

import { AXIS_COLORS, lineInBox, planeBoxPolygon } from "./geometry.js";
import { distance, formatLength, measureLabel, voxelToWorld } from "./measure.js?v=mpr2";

/** Multiplies a column-major 4x4 matrix with a vec4. */
export function mulMat4Vec4(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

export function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Projects a world-space point to pixel coordinates, or null when it is behind the camera. */
export function projectPoint(viewProj, p, width, height, eps = 1e-4) {
  const c = mulMat4Vec4(viewProj, [p[0], p[1], p[2], 1]);
  if (!(c[3] > eps)) return null;
  return [((c[0] / c[3]) * 0.5 + 0.5) * width, (1 - ((c[1] / c[3]) * 0.5 + 0.5)) * height];
}

/**
 * Clips the segment p0-p1 (clip-space vec4s) against the near plane (w > eps) and
 * returns pixel coordinates [x0, y0, x1, y1], or null if nothing is in front of the camera.
 */
export function projectSegment(viewProj, a, b, width, height, eps = 1e-4) {
  let p0 = mulMat4Vec4(viewProj, [a[0], a[1], a[2], 1]);
  let p1 = mulMat4Vec4(viewProj, [b[0], b[1], b[2], 1]);
  const in0 = p0[3] > eps;
  const in1 = p1[3] > eps;
  if (!in0 && !in1) return null;
  if (in0 !== in1) {
    const t = (eps - p0[3]) / (p1[3] - p0[3]);
    const hit = p0.map((v, i) => v + (p1[i] - v) * t);
    if (in0) p1 = hit; else p0 = hit;
  }
  const px = (p) => [((p[0] / p[3]) * 0.5 + 0.5) * width, (1 - ((p[1] / p[3]) * 0.5 + 0.5)) * height];
  return [...px(p0), ...px(p1)];
}

/**
 * World-space outlines of the three slice planes (where they cut the volume) and the three lines where two of
 * them cross, for the state's cursor and orientation. Plane and line names are the axes (x, y, z) their normal /
 * direction is closest to: the plane "z" is the XY pane's, and so on.
 */
export function planeGeometry(st, size) {
  const geoms = { z: st.paneGeom("xy"), y: st.paneGeom("xz"), x: st.paneGeom("yz") };
  const S = geoms.z.S;
  const world = (p) => [(p[0] / S[0] - 0.5) * size[0], (p[1] / S[1] - 0.5) * size[1], (p[2] / S[2] - 0.5) * size[2]];
  const P = [st.pos.x * st.spacing.x, st.pos.y * st.spacing.y, st.pos.z * st.spacing.z];
  for (const g of Object.values(geoms)) for (let k = 0; k < 3; k++) if (Math.abs(g.n[k]) > 1 - 1e-9) P[k] = g.point[k]; // (axis-aligned planes sit at the centre of their voxel)
  const planes = {}, lines = {};
  for (const [axis, g] of Object.entries(geoms)) {
    planes[axis] = planeBoxPolygon(g.n, g.offset, S).map(world);
    const seg = lineInBox(P, g.n, S); // the two other planes cross along this plane's normal
    lines[axis] = seg ? seg.map(world) : null;
  }
  return { pos: world(P), planes, lines };
}

const NS = "http://www.w3.org/2000/svg";

export class Overlay3D {
  /**
   * @param {HTMLElement} host   element that contains the kiln canvas (positioned)
   * @param {import("./cursor.js").SliceState} state
   */
  constructor(host, state) {
    this.host = host;
    this.state = state;
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "slice-overlay-3d");
    this.svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden";
    host.appendChild(this.svg);
    this._lastKey = "";
    this.handles = []; // the measurement points as drawn, in pixels of the host: [{ id, end, x, y }] (id null: the pending point)
    this.rubber = null; // the live end of the measurement being made, a point in voxel coordinates
    this._off = state.on("change", () => { this._lastKey = ""; });
  }

  /** The live end of a measurement in the making (null removes it). */
  setRubber(p) {
    this.rubber = p;
    this._lastKey = "";
  }

  /** Call every frame (cheap): redraws only when the camera, cursor or size changed. */
  update(viewer) {
    const st = this.state;
    const measuring = st.measures.length > 0 || !!st.pending;
    const visible = (st.show3dPlanes || st.show3dCursor || measuring) && (st.layout === "3d" || st.layout === "quad");
    this.svg.style.display = visible ? "" : "none";
    if (!visible || !viewer?.camera) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    const view = viewer.camera.getViewMatrix();
    const proj = viewer.camera.getProjectionMatrix(w / h);
    const key = `${Array.from(view)}|${Array.from(proj)}|${w}x${h}|${st._ver}|${+st.show3dCursor}${+st.show3dPlanes}`;
    if (key === this._lastKey) return;
    this._lastKey = key;

    const vp = multiplyMat4(proj, view);
    const geo = planeGeometry(st, viewer.engine.config.normalizedSize);
    const parts = [];
    const line = (a, b, color, width, opacity = 1) => {
      const s = projectSegment(vp, a, b, w, h);
      if (s) parts.push(`<line x1="${s[0].toFixed(1)}" y1="${s[1].toFixed(1)}" x2="${s[2].toFixed(1)}" y2="${s[3].toFixed(1)}" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round"/>`);
    };
    if (st.show3dPlanes) {
      for (const axis of ["x", "y", "z"]) {
        const c = geo.planes[axis];
        for (let i = 0; i < c.length; i++) line(c[i], c[(i + 1) % c.length], AXIS_COLORS[axis], 1.5, 0.85);
      }
    }
    if (st.show3dCursor) {
      for (const axis of ["x", "y", "z"]) if (geo.lines[axis]) line(geo.lines[axis][0], geo.lines[axis][1], AXIS_COLORS[axis], 2.5);
      const dot = projectPoint(vp, geo.pos, w, h);
      if (dot) parts.push(`<circle cx="${dot[0].toFixed(1)}" cy="${dot[1].toFixed(1)}" r="4" fill="#fff" fill-opacity="0.9" stroke="#000" stroke-opacity="0.6"/>`);
    }
    this.handles = [];
    if (measuring) this._drawMeasures(parts, vp, w, h, viewer.engine.config.normalizedSize);
    this.svg.innerHTML = parts.join("");
  }

  /** The measurements: a line per measurement with its length, a ring on each end (the rings are what can be dragged). */
  _drawMeasures(parts, vp, w, h, size) {
    const st = this.state;
    const unit = st.unit ?? "micrometer";
    const world = (p) => voxelToWorld(p, st.dims, size);
    const text = (x, y, s, color) => parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="ui-monospace,Menlo,monospace" font-size="12" fill="${color}" stroke="#000" stroke-opacity="0.8" stroke-width="3.5" paint-order="stroke" text-anchor="middle">${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`);
    const seg = (a, b, color, dashed, width) => {
      const s = projectSegment(vp, a, b, w, h);
      if (!s) return null;
      const c = `x1="${s[0].toFixed(1)}" y1="${s[1].toFixed(1)}" x2="${s[2].toFixed(1)}" y2="${s[3].toFixed(1)}"`;
      const dash = dashed ? ` stroke-dasharray="6 5"` : "";
      parts.push(`<line ${c} stroke="#000" stroke-opacity="0.7" stroke-width="${width + 2}"${dash}/>`, `<line ${c} stroke="${color}" stroke-width="${width}"${dash}/>`);
      return s;
    };
    const ring = (p, color, id, end, sel) => {
      const px = projectPoint(vp, world(p), w, h);
      if (!px) return;
      this.handles.push({ id, end, x: px[0], y: px[1] });
      parts.push(`<circle cx="${px[0].toFixed(1)}" cy="${px[1].toFixed(1)}" r="${sel ? 6 : 5}" fill="${color}" fill-opacity="0.35" stroke="#000" stroke-opacity="0.7" stroke-width="3"/>`,
        `<circle cx="${px[0].toFixed(1)}" cy="${px[1].toFixed(1)}" r="${sel ? 6 : 5}" fill="none" stroke="${color}" stroke-width="${sel ? 2.4 : 1.8}"/>`);
    };
    for (const m of st.measures) {
      const sel = m.id === st.measureSel;
      const color = sel ? "#ffd84a" : "#47e0c6";
      const s = seg(world(m.a), world(m.b), color, false, sel ? 2.2 : 1.5);
      ring(m.a, color, m.id, "a", sel);
      ring(m.b, color, m.id, "b", sel);
      if (s) text((s[0] + s[2]) / 2, (s[1] + s[3]) / 2 - 8, `${measureLabel(m, st.spacing, unit)}${m.acc ? ` \u00b1${+m.acc.toPrecision(2)} vox` : ""}`, color);
    }
    if (st.pending) {
      ring(st.pending, "#ffd84a", null, "a", true);
      if (this.rubber) {
        const s = seg(world(st.pending), world(this.rubber), "#ffd84a", true, 1.5);
        if (s) text((s[0] + s[2]) / 2, (s[1] + s[3]) / 2 - 8, formatLength(distance(st.pending, this.rubber, st.spacing), unit), "#ffd84a");
      }
    }
  }

  dispose() {
    this._off();
    this.svg.remove();
  }
}
