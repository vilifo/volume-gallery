// Pure geometry for the slice views: orientation, pane transforms, cursor mapping, windowing.
// No DOM, no WebGPU: unit-tested in frontend/tests/.
//
// Conventions
//   * Voxel indices are integers in the served level, x fastest. "Voxel coordinates" are continuous:
//     voxel i covers [i, i + 1); physical coordinates are voxel coordinates times the voxel spacing.
//   * The three panes show three mutually perpendicular planes through the cursor. With the default
//     orientation they are axis-aligned (name = the two axes the plane spans, index = the voxel along the third):
//       "xy"  index = z   u = x   v = y     (slices along Z)
//       "xz"  index = y   u = x   v = z     (slices along Y)
//       "yz"  index = x   u = y   v = z     (slices along X)
//     The orientation (a rotation R, see paneFrame) turns the three planes together about the cursor, so a
//     pane can show a plane at any angle. The pane keeps its name: "xy" is the plane whose normal is R * z.
//   * A pane's image holds square pixels of physical size `pixel`; its columns run along u, its rows along v
//     (physical unit vectors). "Plane coordinates" (a, b) are continuous image pixel units (pixel i covers
//     [i, i + 1)); for the default orientation of an isotropic volume they are voxel units.

export const AXES = ["xy", "xz", "yz"];

// flip: display direction per plane axis (+1 = increasing index to the right / downwards).
// The XZ and YZ planes show z increasing upwards by default.
export const AXIS_INFO = {
  xy: { id: 0, normal: "z", u: "x", v: "y", label: "XY", flip: { u: 1, v: 1 } },
  xz: { id: 1, normal: "y", u: "x", v: "z", label: "XZ", flip: { u: 1, v: -1 } },
  yz: { id: 2, normal: "x", u: "y", v: "z", label: "YZ", flip: { u: 1, v: -1 } },
};

export const AXIS_COLORS = { x: "#ff5a5a", y: "#5ad65a", z: "#5a9bff" };

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalToVoxel(n, size) {
  return clamp(Math.floor(n * size), 0, size - 1);
}
export function voxelToNormal(i, size) {
  return (i + 0.5) / size;
}

/** Index of the slice a pane's cursor is in along the pane's base axis. */
export function planeIndex(axis, cursor) {
  return cursor[AXIS_INFO[axis].normal];
}

// ---------------------------------------------------------------- small vector / matrix helpers
// 3-vectors are arrays [x, y, z]; 3x3 matrices are row-major arrays of 9.

export const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit3 = (a) => { const l = len3(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

export function matMul(A, B) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return out;
}
export const matVec = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];

/** Rotation by `angle` (radians, counter-clockwise looking against the axis) about a unit axis (Rodrigues). */
export function rotAxis(axis, angle) {
  const [x, y, z] = unit3(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

/** Re-orthonormalises a rotation (a long chain of drags would otherwise let it drift). */
export function orthonormalize(R) {
  const c0 = unit3([R[0], R[3], R[6]]);
  let c1 = [R[1], R[4], R[7]];
  const k = dot3(c0, c1);
  c1 = unit3([c1[0] - k * c0[0], c1[1] - k * c0[1], c1[2] - k * c0[2]]);
  const c2 = cross3(c0, c1);
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}

const RAD = Math.PI / 180;
/** R = Rz(rz) * Ry(ry) * Rx(rx): turn about the volume's x axis, then y, then z (degrees). */
export function eulerToMatrix(rx, ry, rz) {
  return matMul(rotAxis([0, 0, 1], rz * RAD), matMul(rotAxis([0, 1, 0], ry * RAD), rotAxis([1, 0, 0], rx * RAD)));
}
/** The angles (degrees; ry within +-90) for which eulerToMatrix gives R. */
export function matrixToEuler(R) {
  const sy = clamp(-R[6], -1, 1);
  const ry = Math.asin(sy);
  let rx, rz;
  if (Math.abs(sy) < 0.999999) {
    rx = Math.atan2(R[7], R[8]);
    rz = Math.atan2(R[3], R[0]);
  } else { // looking along an axis of the turn: only rx - rz (or rx + rz) is defined
    rx = Math.atan2(-R[5], R[4]);
    rz = 0;
  }
  const deg = (r) => { const d = r / RAD; return Math.abs(d) < 1e-9 ? 0 : d; };
  return { rx: deg(rx), ry: deg(ry), rz: deg(rz) };
}

// ---------------------------------------------------------------- panes: orientation and plane frames

// A pane's base frame (orientation = identity): image columns along u, rows along v, scrolling along n.
const BASE = {
  xy: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  xz: { u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] },
  yz: { u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
};

/**
 * The frame (unit vectors in physical x, y, z) of a pane for the orientation R and the pane's roll `psi`
 * (radians): u (image columns), v (image rows), n (the plane's normal). The three normals are the columns of R
 * (yz: R x, xz: R y, xy: R z), so the planes stay perpendicular. The roll is a turn of the image about its
 * own normal; it is what keeps a pane's picture still while its crosshair lines are turned (see
 * SliceState.rotateAboutPane).
 */
export function paneFrame(axis, R = IDENTITY, psi = 0) {
  const b = BASE[axis];
  const F = psi ? matMul(R, rotAxis(b.n, psi)) : R;
  return { u: matVec(F, b.u), v: matVec(F, b.v), n: matVec(R, b.n) };
}

/** +1 when (u, v, n) is right-handed (xy, yz), -1 for xz: the sign between "turn about n" and "turn from u to v". */
export const FRAME_HANDEDNESS = { xy: 1, xz: -1, yz: 1 };

/** Whether a pane's plane is axis-aligned (to within rounding). */
export const isAligned = (n) => n.some((c) => Math.abs(c) > 1 - 1e-9);

/**
 * Everything about one pane's plane for a given orientation and cursor position: its image (size, pixel
 * size), where the cursor and other planes are in it, and the polygon where it cuts the volume.
 *
 * The image covers the volume's bounding box projected onto the plane, so its size depends on the
 * orientation only; scrolling along the normal moves the plane but leaves the image's frame in place.
 * `pos` is the cursor in continuous voxel coordinates. When the pane's normal is an axis, the plane is
 * snapped to the centre of the voxel slice that axis coordinate is in (so a slice is shown as stored).
 */
export class PaneGeometry {
  /**
   * @param {object} o
   * @param {"xy"|"xz"|"yz"} o.axis
   * @param {number[]} [o.R] @param {{xy:number,xz:number,yz:number}} [o.psi]
   * @param {{x,y,z}} o.pos @param {{x,y,z}} o.dims @param {{x,y,z}} o.spacing
   * @param {number} [o.maxSide]  the image is made coarser if it would be wider or taller than this
   * @param {number} [o.pixel]    physical pixel size (default: the finest voxel spacing)
   */
  constructor({ axis, R = IDENTITY, psi = {}, pos, dims, spacing, maxSide = 8192, pixel }) {
    this.axis = axis;
    this.dims = dims;
    this.spacing = spacing;
    const sp = [spacing.x, spacing.y, spacing.z];
    const S = [dims.x * sp[0], dims.y * sp[1], dims.z * sp[2]];
    this.S = S;
    const f = paneFrame(axis, R, psi[axis] ?? 0);
    this.u = f.u;
    this.v = f.v;
    this.n = f.n;
    this.normals = { xy: matVec(R, BASE.xy.n), xz: matVec(R, BASE.xz.n), yz: matVec(R, BASE.yz.n) };
    const hu = (Math.abs(f.u[0]) * S[0] + Math.abs(f.u[1]) * S[1] + Math.abs(f.u[2]) * S[2]) / 2;
    const hv = (Math.abs(f.v[0]) * S[0] + Math.abs(f.v[1]) * S[1] + Math.abs(f.v[2]) * S[2]) / 2;
    const base = Math.min(sp[0], sp[1], sp[2]) || 1;
    let px = pixel ?? base;
    if (!pixel && Math.max(2 * hu, 2 * hv) / px > maxSide) px = Math.max(2 * hu, 2 * hv) / maxSide;
    this.pixel = px;
    this.width = Math.max(1, Math.ceil((2 * hu) / px - 1e-6));
    this.height = Math.max(1, Math.ceil((2 * hv) / px - 1e-6));
    // the image at the default orientation, which sets the zoom (so rotating does not change it)
    const bu = BASE[axis].u.findIndex((c) => c === 1), bv = BASE[axis].v.findIndex((c) => c === 1);
    this.baseExt = { u: S[bu] / px, v: S[bv] / px };

    // the plane: through the cursor, with an axis-aligned normal snapped to its voxel slice
    const P = [pos.x * sp[0], pos.y * sp[1], pos.z * sp[2]];
    const c = [pos.x, pos.y, pos.z], dm = [dims.x, dims.y, dims.z];
    for (let i = 0; i < 3; i++) if (Math.abs(this.n[i]) > 1 - 1e-9) P[i] = (Math.floor(clamp(c[i], 0, dm[i] - 1e-9)) + 0.5) * sp[i];
    this.point = P;
    this.offset = dot3(this.n, P);
    const Vc = [S[0] / 2, S[1] / 2, S[2] / 2];
    const k = this.offset - dot3(this.n, Vc);
    const O = [Vc[0] + k * this.n[0], Vc[1] + k * this.n[1], Vc[2] + k * this.n[2]]; // the volume's centre, on the plane
    this.origin = [O[0] - hu * f.u[0] - hv * f.v[0], O[1] - hu * f.u[1] - hv * f.v[1], O[2] - hu * f.u[2] - hv * f.v[2]];
    this._poly = null;
  }

  /** The request body of POST .../plan. */
  spec() {
    return { origin: this.origin, u: this.u, v: this.v, pixel: this.pixel, width: this.width, height: this.height };
  }

  /** A point of the volume (voxel coordinates) -> { a, b } plane coordinates and h, its distance from the plane (physical, signed along n). */
  project(p) {
    const s = this.spacing;
    const P = [p.x * s.x, p.y * s.y, p.z * s.z];
    const d = [P[0] - this.origin[0], P[1] - this.origin[1], P[2] - this.origin[2]];
    return { a: dot3(d, this.u) / this.pixel, b: dot3(d, this.v) / this.pixel, h: dot3(this.n, P) - this.offset };
  }

  /** Plane coordinates (a, b) -> the point of the plane (voxel coordinates). */
  unproject(a, b) {
    const s = this.spacing, o = this.origin, k = this.pixel;
    return {
      x: (o[0] + (a * this.u[0] + b * this.v[0]) * k) / s.x,
      y: (o[1] + (a * this.u[1] + b * this.v[1]) * k) / s.y,
      z: (o[2] + (a * this.u[2] + b * this.v[2]) * k) / s.z,
    };
  }

  /** The cut of the plane through the volume, as a convex polygon of plane coordinates [[a, b], ...] (empty when it misses). */
  polygon() {
    if (this._poly) return this._poly;
    let poly = [[0, 0], [this.width, 0], [this.width, this.height], [0, this.height]];
    for (let k = 0; k < 3 && poly.length; k++) {
      const A = this.u[k] * this.pixel, B = this.v[k] * this.pixel;
      poly = clipPolygon(poly, A, B, this.S[k] - this.origin[k]);   // origin + A a + B b <= S
      poly = clipPolygon(poly, -A, -B, this.origin[k]);             // origin + A a + B b >= 0
    }
    this._poly = poly;
    return poly;
  }

  /** Direction (unit, in plane coordinates) of the line where pane `other`'s plane cuts this one. */
  lineDirection(other) {
    const d = cross3(this.normals[other], this.n);
    const a = dot3(d, this.u), b = dot3(d, this.v);
    const l = Math.hypot(a, b);
    return l > 1e-9 ? [a / l, b / l] : [1, 0];
  }

  /** Key that changes when the image would. */
  get key() {
    return `${this.n.map((c) => c.toFixed(5))}|${this.u.map((c) => c.toFixed(5))}|${this.offset.toFixed(4)}`;
  }
}

/** Keeps the part of a convex polygon with A * a + B * b <= C. */
export function clipPolygon(poly, A, B, C) {
  if (!poly.length) return poly;
  const out = [];
  const val = (p) => A * p[0] + B * p[1] - C;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const vp = val(p), vq = val(q);
    if (vp <= 0) out.push(p);
    if ((vp < 0 && vq > 0) || (vp > 0 && vq < 0)) {
      const t = vp / (vp - vq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** The part t in [t0, t1] of the line c + t * d inside a convex polygon (any winding), or null. */
export function clipLineToPolygon(c, d, poly) {
  if (poly.length < 3) return null;
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; }
  const sgn = area >= 0 ? 1 : -1;
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q[0] - p[0], ey = q[1] - p[1];
    // inside: sgn * cross(e, point - p) >= 0
    const base = sgn * (ex * (c[1] - p[1]) - ey * (c[0] - p[0]));
    const slope = sgn * (ex * d[1] - ey * d[0]);
    if (Math.abs(slope) < 1e-12) { if (base < 0) return null; continue; }
    const t = -base / slope;
    if (slope > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return Number.isFinite(t0) && Number.isFinite(t1) ? [t0, t1] : null;
}

/** The point of a convex polygon (any winding) nearest to (a, b): the point itself when inside; null for an empty polygon. */
export function nearestInPolygon(poly, a, b) {
  if (!poly.length) return null;
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; }
  const sgn = area >= 0 ? 1 : -1;
  let inside = poly.length >= 3;
  for (let i = 0; inside && i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if (sgn * ((q[0] - p[0]) * (b - p[1]) - (q[1] - p[1]) * (a - p[0])) < 0) inside = false;
  }
  if (inside) return [a, b];
  let best = null, bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q[0] - p[0], ey = q[1] - p[1], l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? clamp(((a - p[0]) * ex + (b - p[1]) * ey) / l2, 0, 1) : 0;
    const x = p[0] + ex * t, y = p[1] + ey * t, d = (x - a) ** 2 + (y - b) ** 2;
    if (d < bd) { bd = d; best = [x, y]; }
  }
  return best;
}

/** The polygon (physical x, y, z, in order around it) where the plane n . X = offset cuts the box [0, S]. */
export function planeBoxPolygon(n, offset, S) {
  const pts = [];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(n[a]) < 1e-12) continue;
    const b = (a + 1) % 3, c = (a + 2) % 3;
    for (const vb of [0, S[b]]) for (const vc of [0, S[c]]) {
      const t = (offset - n[b] * vb - n[c] * vc) / n[a];
      if (t < -1e-9 || t > S[a] + 1e-9) continue;
      const p = [0, 0, 0];
      p[a] = clamp(t, 0, S[a]); p[b] = vb; p[c] = vc;
      if (!pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-7 * (S[0] + S[1] + S[2]))) pts.push(p);
    }
  }
  if (pts.length < 3) return [];
  const m = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
  const e1 = unit3(Math.abs(n[0]) < 0.9 ? cross3(n, [1, 0, 0]) : cross3(n, [0, 1, 0]));
  const e2 = cross3(n, e1);
  const ang = (p) => { const d = [p[0] - m[0], p[1] - m[1], p[2] - m[2]]; return Math.atan2(dot3(d, e2), dot3(d, e1)); };
  return pts.sort((p, q) => ang(p) - ang(q));
}

/** The part of the line P + t * dir inside the box [0, S]: [start, end] (physical points), or null. */
export function lineInBox(P, dir, S) {
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-12) { if (P[i] < 0 || P[i] > S[i]) return null; continue; }
    let a = (0 - P[i]) / dir[i], b = (S[i] - P[i]) / dir[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return [[P[0] + dir[0] * t0, P[1] + dir[1] * t0, P[2] + dir[2] * t0], [P[0] + dir[0] * t1, P[1] + dir[1] * t1, P[2] + dir[2] * t1]];
}

// ---------------------------------------------------------------- pane transform

/** Pixels per image pixel at zoom 1 so the whole default-orientation image fits the pane. */
export function fitScale(ext, width, height, margin = 0.96) {
  const s = Math.min(width / ext.u, height / ext.v) * margin;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** Screen pixels per image pixel for a pane view ({zoom, ...}); the same along u and v (the image has square pixels). */
export function paneScale(geom, view, width, height) {
  const s = fitScale(geom.baseExt, width, height) * view.zoom;
  return { u: s, v: s };
}

/** The view's centre as absolute plane coordinates: views are stored as an offset from the image centre. */
export const absView = (view, geom) => ({ ...view, centerU: geom.width / 2 + view.centerU, centerV: geom.height / 2 + view.centerV });

/** Pane pixel (origin top-left, y down) to continuous plane coordinates. */
export function pixelToPlane(px, py, width, height, view, ppv, flip) {
  return {
    u: view.centerU + (flip.u * (px - width / 2)) / ppv.u,
    v: view.centerV + (flip.v * (py - height / 2)) / ppv.v,
  };
}

export function planeToPixel(u, v, width, height, view, ppv, flip) {
  return {
    x: width / 2 + flip.u * (u - view.centerU) * ppv.u,
    y: height / 2 + flip.v * (v - view.centerV) * ppv.v,
  };
}

/** Default view: the whole image, centred (centre = offset from the image centre), zoom 1. */
export function defaultView() {
  return { zoom: 1, centerU: 0, centerV: 0 };
}

/**
 * Zoom by `factor` keeping the plane point under the pointer fixed.
 * Returns a new view (zoom clamped to [0.25, 64]).
 */
export function zoomAt(view, factor, px, py, width, height, ppv, flip) {
  const zoom = clamp(view.zoom * factor, 0.25, 64);
  const f = zoom / view.zoom;
  const anchor = pixelToPlane(px, py, width, height, view, ppv, flip);
  // after zooming the same plane point must stay under (px, py)
  const nppv = { u: ppv.u * f, v: ppv.v * f };
  return {
    zoom,
    centerU: anchor.u - (flip.u * (px - width / 2)) / nppv.u,
    centerV: anchor.v - (flip.v * (py - height / 2)) / nppv.v,
  };
}

/** Number of taps per pixel side when zoomed out (box filter); 1 when magnified. */
export function minifyTaps(ppv) {
  const m = Math.min(ppv.u, ppv.v);
  return m >= 1 ? 1 : clamp(Math.ceil(1 / m), 1, 4);
}

// ---------------------------------------------------------------- sample formats

const FORMATS = {
  uint8: { format: "r8uint", bytes: 1, sample: "uint", range: [0, 255], array: Uint8Array },
  int8: { format: "r8sint", bytes: 1, sample: "sint", range: [-128, 127], array: Int8Array },
  uint16: { format: "r16uint", bytes: 2, sample: "uint", range: [0, 65535], array: Uint16Array },
  int16: { format: "r16sint", bytes: 2, sample: "sint", range: [-32768, 32767], array: Int16Array },
  float32: { format: "r32float", bytes: 4, sample: "float", range: [0, 1], array: Float32Array },
};

export const SUPPORTED_DTYPES = Object.keys(FORMATS);

/** Texture format description for a transport dtype, or null when unsupported. */
export function textureFormatFor(dtype) {
  return FORMATS[dtype] ?? null;
}

// ---------------------------------------------------------------- windowing

export function fullRangeWindow(dtype) {
  const [lo, hi] = FORMATS[dtype]?.range ?? [0, 1];
  return { center: (lo + hi) / 2, width: Math.max(hi - lo, 1e-6) };
}

/** CPU mirror of the shader's window function. Output 0..1. */
export function applyWindow(value, center, width, invert = false) {
  const g = clamp((value - (center - width / 2)) / width, 0, 1);
  return invert ? 1 - g : g;
}

/** Window from a dragged delta: horizontal = width, vertical = centre (right-drag convention). */
export function dragWindow(win, dx, dy, dtype) {
  const [lo, hi] = FORMATS[dtype]?.range ?? [0, 1];
  const range = hi - lo;
  const scale = range / 800; // 800 px of drag sweeps the whole range
  return {
    center: clamp(win.center + dy * scale, lo, hi),
    width: clamp(win.width + dx * scale, range / 4096, range * 2),
  };
}
