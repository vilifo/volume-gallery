// Draws the slice cursor and the three slice planes on top of the kiln 3D view. Both can be
// switched off independently (SliceState.show3dCursor / show3dPlanes).
//
// kiln-render's volume is a box centred at the origin with extents
// `engine.config.normalizedSize`; a plane at voxel index i of an axis with size N
// sits at (i + 0.5) / N - 0.5 of that extent (the same mapping kiln's own slice
// mode uses). The lines are drawn in an SVG layer above the canvas, so they are
// not occluded by the volume; that is intended for position indicators.

import { AXIS_COLORS, voxelToNormal } from "./geometry.js";

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

/** World-space corners (and cursor lines) for the current cursor. */
export function planeGeometry(cursor, dims, size) {
  const pos = {
    x: (voxelToNormal(cursor.x, dims.x) - 0.5) * size[0],
    y: (voxelToNormal(cursor.y, dims.y) - 0.5) * size[1],
    z: (voxelToNormal(cursor.z, dims.z) - 0.5) * size[2],
  };
  const h = size.map((s) => s / 2);
  return {
    pos,
    // closed outlines of the three planes
    planes: {
      z: [[-h[0], -h[1], pos.z], [h[0], -h[1], pos.z], [h[0], h[1], pos.z], [-h[0], h[1], pos.z]],
      y: [[-h[0], pos.y, -h[2]], [h[0], pos.y, -h[2]], [h[0], pos.y, h[2]], [-h[0], pos.y, h[2]]],
      x: [[pos.x, -h[1], -h[2]], [pos.x, h[1], -h[2]], [pos.x, h[1], h[2]], [pos.x, -h[1], h[2]]],
    },
    // the three lines where two planes cross (each parallel to one axis)
    lines: {
      x: [[-h[0], pos.y, pos.z], [h[0], pos.y, pos.z]],
      y: [[pos.x, -h[1], pos.z], [pos.x, h[1], pos.z]],
      z: [[pos.x, pos.y, -h[2]], [pos.x, pos.y, h[2]]],
    },
  };
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
    this._off = state.on("change", () => { this._lastKey = ""; });
  }

  /** Call every frame (cheap): redraws only when the camera, cursor or size changed. */
  update(viewer) {
    const st = this.state;
    const visible = (st.show3dPlanes || st.show3dCursor) && (st.layout === "3d" || st.layout === "quad");
    this.svg.style.display = visible ? "" : "none";
    if (!visible || !viewer?.camera) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    const view = viewer.camera.getViewMatrix();
    const proj = viewer.camera.getProjectionMatrix(w / h);
    const key = `${Array.from(view)}|${Array.from(proj)}|${w}x${h}|${st.cursor.x},${st.cursor.y},${st.cursor.z}|${+st.show3dCursor}${+st.show3dPlanes}`;
    if (key === this._lastKey) return;
    this._lastKey = key;

    const vp = multiplyMat4(proj, view);
    const geo = planeGeometry(st.cursor, st.dims, viewer.engine.config.normalizedSize);
    const parts = [];
    const line = (a, b, color, width, opacity = 1) => {
      const s = projectSegment(vp, a, b, w, h);
      if (s) parts.push(`<line x1="${s[0].toFixed(1)}" y1="${s[1].toFixed(1)}" x2="${s[2].toFixed(1)}" y2="${s[3].toFixed(1)}" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round"/>`);
    };
    if (st.show3dPlanes) {
      for (const axis of ["x", "y", "z"]) {
        const c = geo.planes[axis];
        for (let i = 0; i < 4; i++) line(c[i], c[(i + 1) % 4], AXIS_COLORS[axis], 1.5, 0.85);
      }
    }
    if (st.show3dCursor) {
      for (const axis of ["x", "y", "z"]) line(geo.lines[axis][0], geo.lines[axis][1], AXIS_COLORS[axis], 2.5);
      const dot = projectPoint(vp, [geo.pos.x, geo.pos.y, geo.pos.z], w, h);
      if (dot) parts.push(`<circle cx="${dot[0].toFixed(1)}" cy="${dot[1].toFixed(1)}" r="4" fill="#fff" fill-opacity="0.9" stroke="#000" stroke-opacity="0.6"/>`);
    }
    this.svg.innerHTML = parts.join("");
  }

  dispose() {
    this._off();
    this.svg.remove();
  }
}
