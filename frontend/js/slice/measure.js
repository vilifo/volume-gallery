// Distance measuring in the slice panes and in the 3D view: pure geometry, no DOM and no WebGPU (unit-tested).
//
// A measurement joins two points. Points are in continuous voxel coordinates of the volume the slice views
// serve: voxel i covers [i, i + 1) along an axis, exactly the "plane coordinates" of geometry.js, with the third
// coordinate that of the plane's centre (slice index + 0.5). The distance is taken in physical units from the
// voxel spacing (the unit of volume.json, micrometres when it does not say).
//
// 3D points come from a ray through a pixel: it is cast against the three slice planes (exact), or through a
// coarse copy of the volume held in memory (CoarseVolume) to find where the ray first meets the rendered
// structure (approximate: the accuracy is that of the coarse level; refine the point in a slice pane).

import { clamp, dot3, nearestInPolygon, planeToPixel } from "./geometry.js";

export const MAX_MEASURES = 50;
const UNIT_METRES = { nanometer: 1e-9, micrometer: 1e-6, millimeter: 1e-3, centimeter: 1e-2, meter: 1 };
const UNIT_SHORT = { nm: 1e-9, "\u00b5m": 1e-6, mm: 1e-3, m: 1 };

// ------------------------------------------------------------------------------------- distances

/** Distance in physical units (that of `spacing`) between two points in voxel coordinates. */
export function distance(a, b, spacing) {
  return Math.hypot((a.x - b.x) * spacing.x, (a.y - b.y) * spacing.y, (a.z - b.z) * spacing.z);
}

/** Distance in voxels (isotropic, spacing ignored). */
export const voxelDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Length of `value` (in `unit`) with a fitting unit: 0.5 mm shows as 500 \u00b5m, 12000 \u00b5m as 12 mm. */
export function formatLength(value, unit = "micrometer") {
  const per = UNIT_METRES[unit];
  if (!Number.isFinite(value)) return "\u2014";
  if (!per) return `${+value.toPrecision(4)}${unit ? ` ${unit}` : ""}`;
  const metres = Math.abs(value) * per;
  const [label, size] = metres >= 1 ? ["m", 1] : metres >= 1e-3 ? ["mm", 1e-3] : metres >= 1e-6 ? ["\u00b5m", 1e-6] : ["nm", 1e-9];
  const v = (value * per) / size;
  return `${+v.toPrecision(Math.abs(v) >= 100 ? 4 : 3)} ${label}`;
}

/** "1.23 mm" for a measurement, given the spacing and unit of the volume. */
export const measureLabel = (m, spacing, unit) => formatLength(distance(m.a, m.b, spacing), unit);

/** The three components of the vector a -> b in physical units. */
export const deltas = (a, b, spacing) => ({ x: (b.x - a.x) * spacing.x, y: (b.y - a.y) * spacing.y, z: (b.z - a.z) * spacing.z });

export { UNIT_SHORT };

// ------------------------------------------------------------------------------- planes and points

/** Half the thickness of the slice a pane shows, in physical units (half a voxel along its normal). */
const halfThickness = (geom) => 0.5 * (Math.abs(geom.n[0]) * geom.spacing.x + Math.abs(geom.n[1]) * geom.spacing.y + Math.abs(geom.n[2]) * geom.spacing.z);

/** Whether a point lies on the slice a pane shows (within half a voxel of its plane). */
export const onSlice = (geom, p) => Math.abs(geom.project(p).h) <= halfThickness(geom) + 1e-9;

/** The 3D point (voxel coordinates) under plane coordinates (a, b) of a pane: on its plane, inside the volume (null when the plane misses it). */
export function pointFromPane(geom, a, b) {
  const q = nearestInPolygon(geom.polygon(), a, b);
  return q ? geom.unproject(q[0], q[1]) : null;
}

/** Rounds a point to 1/100 voxel (keeps links and saved views short). */
export const roundPoint = (p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100 });

// ------------------------------------------------------------------------------------ URL form

/** "x,y,z,x,y,z;x,y,z,x,y,z": measurements as text (labels are not kept). */
export function encodeMeasures(list) {
  return list.slice(0, MAX_MEASURES).map((m) => [m.a.x, m.a.y, m.a.z, m.b.x, m.b.y, m.b.z].map((v) => +v.toFixed(2)).join(",")).join(";");
}

/** The measurements in a text made by encodeMeasures; anything malformed or out of the volume is dropped. */
export function decodeMeasures(text, dims) {
  const out = [];
  if (typeof text !== "string" || text.length > 20000) return out;
  for (const part of text.split(";").slice(0, MAX_MEASURES)) {
    const n = part.split(",").map(Number);
    if (n.length !== 6 || !n.every(Number.isFinite)) continue;
    const a = { x: n[0], y: n[1], z: n[2] }, b = { x: n[3], y: n[4], z: n[5] };
    if (![a, b].every((p) => p.x >= 0 && p.x <= dims.x && p.y >= 0 && p.y <= dims.y && p.z >= 0 && p.z <= dims.z)) continue;
    out.push({ a, b });
  }
  return out;
}

/** The measurements as CSV text (header included): point coordinates in voxels, the distance in the volume's unit and in voxels. */
export function measuresCsv(list, spacing, unit) {
  const rows = [["id", "label", "ax", "ay", "az", "bx", "by", "bz", `distance (${unit ?? "micrometer"})`, "distance (voxels)"]];
  for (const m of list) {
    rows.push([m.id, `"${String(m.label ?? "").replace(/"/g, '""')}"`, m.a.x, m.a.y, m.a.z, m.b.x, m.b.y, m.b.z, +distance(m.a, m.b, spacing).toPrecision(6), +voxelDistance(m.a, m.b).toPrecision(6)]);
  }
  return rows.map((r) => r.join(",")).join("\n");
}

// --------------------------------------------------------------------------------- slice pane drawing

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function labelSvg(x, y, text, color) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${MONO}" font-size="12" fill="${color}" stroke="#000" stroke-opacity="0.8" stroke-width="3.5" paint-order="stroke" text-anchor="middle">${esc(text)}</text>`;
}

/**
 * SVG of the measurements in a slice pane (`geom`: its PaneGeometry; `view`: the absolute view, see absView). `measures` is the state's list; the point being placed (`pending`) and the
 * live line to the pointer (`rubber`, a point) are drawn too. Endpoints on this slice are solid; a measurement
 * with only one end on the slice shows the projected line dashed. Returns { svg, handles } where handles are
 * the draggable endpoints on this slice: [{ id, end: "a"|"b", x, y }] in pane pixels (id null for the pending point).
 */
export function paneMeasureSvg({ geom, measures, pending = null, rubber = null, selected = null, spacing, unit, width, height, view, ppv, flip }) {
  const parts = [];
  const handles = [];
  const px = (p) => {
    const { a, b } = geom.project(p);
    return planeToPixel(a, b, width, height, view, ppv, flip);
  };
  const handle = (pt, color, id, end, sel) => {
    handles.push({ id, end, x: pt.x, y: pt.y });
    parts.push(`<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${sel ? 6 : 5}" fill="${color}" fill-opacity="0.35" stroke="#000" stroke-opacity="0.7" stroke-width="3"/>`,
      `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${sel ? 6 : 5}" fill="none" stroke="${color}" stroke-width="${sel ? 2.4 : 1.8}"/>`);
  };
  const line = (p, q, color, dashed, sel) => {
    const common = `x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}"`;
    const dash = dashed ? ` stroke-dasharray="6 5"` : "";
    parts.push(`<line ${common} stroke="#000" stroke-opacity="0.7" stroke-width="${sel ? 4.5 : 3.5}"${dash}/>`, `<line ${common} stroke="${color}" stroke-width="${sel ? 2.2 : 1.5}"${dash}/>`);
  };
  for (const m of measures) {
    const aOn = onSlice(geom, m.a), bOn = onSlice(geom, m.b);
    if (!aOn && !bOn) continue;
    const sel = m.id === selected;
    const color = sel ? "#ffd84a" : "#47e0c6";
    const pa = px(m.a), pb = px(m.b);
    line(pa, pb, color, !(aOn && bOn), sel);
    if (aOn) handle(pa, color, m.id, "a", sel);
    if (bOn) handle(pb, color, m.id, "b", sel);
    const len = measureLabel(m, spacing, unit);
    const out = aOn && bOn ? "" : " \u2197"; // an end is on another slice
    parts.push(labelSvg((pa.x + pb.x) / 2, (pa.y + pb.y) / 2 - 8, `${len}${out}`, color));
  }
  if (pending) {
    const on = onSlice(geom, pending);
    const pp = px(pending);
    if (on) handle(pp, "#ffd84a", null, "a", true);
    if (rubber) {
      const pr = px(rubber);
      line(pp, pr, "#ffd84a", true, false);
      parts.push(labelSvg((pp.x + pr.x) / 2, (pp.y + pr.y) / 2 - 8, formatLength(distance(pending, rubber, spacing), unit), "#ffd84a"));
    }
  }
  return { svg: parts.join(""), handles };
}

/** The endpoint (of `handles`) within `tolerance` pixels of (x, y), nearest first, or null. */
export function hitHandle(handles, x, y, tolerance = 10) {
  let best = null, bestD = tolerance;
  for (const h of handles) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= bestD) { best = h; bestD = d; }
  }
  return best;
}

// ------------------------------------------------------------------------------------- 3D: rays

/** Inverse of a column-major 4x4 matrix (doubles), or null when singular. */
export function invert4(m) {
  const a = Array.from(m, Number);
  const inv = new Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!det) return null;
  return inv.map((v) => v / det);
}

const mulVec = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3], m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
];
const norm3 = (v) => { const l = Math.hypot(...v); return l > 0 ? v.map((x) => x / l) : v; };

/**
 * The ray through pixel (px, py) of a width x height viewport (origin top-left), from the camera's view and
 * projection matrices (column-major, as kiln's camera gives them). `origin` is the camera position when known.
 * Returns { origin, dir } in world space, dir a unit vector, or null.
 */
export function pixelRay(view, proj, width, height, px, py, origin = null) {
  const vp = multiply(proj, view);
  const inv = invert4(vp);
  if (!inv) return null;
  const ndc = [(px / width) * 2 - 1, 1 - (py / height) * 2];
  const at = (z) => { const w = mulVec(inv, [ndc[0], ndc[1], z, 1]); return [w[0] / w[3], w[1] / w[3], w[2] / w[3]]; };
  const near = at(0.2), far = at(0.8);
  const o = origin ?? near;
  return { origin: o, dir: norm3([far[0] - near[0], far[1] - near[1], far[2] - near[2]]) };
}

/** Column-major 4x4 product a * b (doubles). */
export function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

/** World point -> voxel coordinates (the volume is a box centred on the origin with extents `size`). */
export const worldToVoxel = (w, dims, size) => ({ x: (w[0] / size[0] + 0.5) * dims.x, y: (w[1] / size[1] + 0.5) * dims.y, z: (w[2] / size[2] + 0.5) * dims.z });

/** Voxel coordinates -> world point. */
export const voxelToWorld = (p, dims, size) => [(p.x / dims.x - 0.5) * size[0], (p.y / dims.y - 0.5) * size[1], (p.z / dims.z - 0.5) * size[2]];

/** [t0, t1] where a ray is inside the axis-aligned box [min, max], or null. */
export function rayBox(o, d, min, max) {
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (o[i] < min[i] || o[i] > max[i]) return null; continue; }
    let a = (min[i] - o[i]) / d[i], b = (max[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t1 < 0 ? null : [Math.max(t0, 0), t1];
}

/**
 * Where the ray first meets one of the three slice planes (`geoms`: their PaneGeometry, through the cursor)
 * inside the volume: the exact way to place a 3D point. Returns { point (voxel coordinates), axis (the pane
 * name), t } or null.
 */
export function pickPlanes(ray, geoms, dims, size) {
  const h = size.map((x) => x / 2);
  const dm = [dims.x, dims.y, dims.z];
  let best = null;
  for (const g of geoms) {
    // the plane in voxel coordinates: sum(nv_k * x_k) = offset, with nv_k = spacing_k * n_k
    const nv = [g.n[0] * g.spacing.x, g.n[1] * g.spacing.y, g.n[2] * g.spacing.z];
    const x0 = ray.origin.map((o, k) => (o / size[k] + 0.5) * dm[k]);
    const dx = ray.dir.map((d, k) => (d / size[k]) * dm[k]);
    const denom = dot3(nv, dx);
    if (Math.abs(denom) < 1e-12) continue;
    const t = (g.offset - dot3(nv, x0)) / denom;
    if (!(t > 0) || (best && t >= best.t)) continue;
    const w = ray.origin.map((o, k) => o + ray.dir[k] * t);
    if ([0, 1, 2].some((k) => Math.abs(w[k]) > h[k])) continue;
    best = { t, w, axis: g.axis };
  }
  if (!best) return null;
  return { point: roundPoint(worldToVoxel(best.w, dims, size)), axis: best.axis, t: best.t };
}

// ------------------------------------------------------------------------- 3D: the coarse volume

const halfCache = new Float32Array(65536);
let halfReady = false;
/** float16 bits -> number (a table: bricks hold millions of them). */
export function halfToFloat(bits) {
  if (!halfReady) {
    for (let i = 0; i < 65536; i++) {
      const s = i & 0x8000 ? -1 : 1, e = (i >> 10) & 0x1f, f = i & 0x3ff;
      halfCache[i] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
    }
    halfReady = true;
  }
  return halfCache[bits];
}

/** A coarse level of the volume in memory (values 0..1 as the renderer sees them), for placing 3D points. */
export class CoarseVolume {
  /** @param {{dims: {x,y,z}, data: Float32Array, lod: number, factor: {x,y,z}}} o  factor: voxels of the finest level per voxel here */
  constructor({ dims, data, lod = 0, factor = { x: 1, y: 1, z: 1 } }) {
    this.dims = dims;
    this.data = data;
    this.lod = lod;
    this.factor = factor;
  }

  /** Trilinear sample at normalised coordinates (0..1 across the volume); values outside are 0. */
  sample(nx, ny, nz) {
    const { x: X, y: Y, z: Z } = this.dims;
    const fx = nx * X - 0.5, fy = ny * Y - 0.5, fz = nz * Z - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= X || y >= Y || z >= Z ? 0 : this.data[(z * Y + y) * X + x]);
    const c00 = at(x0, y0, z0) * (1 - tx) + at(x0 + 1, y0, z0) * tx;
    const c10 = at(x0, y0 + 1, z0) * (1 - tx) + at(x0 + 1, y0 + 1, z0) * tx;
    const c01 = at(x0, y0, z0 + 1) * (1 - tx) + at(x0 + 1, y0, z0 + 1) * tx;
    const c11 = at(x0, y0 + 1, z0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1, z0 + 1) * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  }

  /** The accuracy of a point picked here, in voxels of the finest level (half a coarse voxel). */
  get accuracy() { return Math.max(this.factor.x, this.factor.y, this.factor.z) / 2; }
}

/** The coarsest-first choice of a level: the finest whose voxel count fits `maxVoxels` (else the coarsest). */
export function chooseLevel(levels, maxVoxels) {
  let pick = levels[levels.length - 1];
  for (const l of [...levels].sort((a, b) => a.lod - b.lod)) {
    if (l.dimensions[0] * l.dimensions[1] * l.dimensions[2] <= maxVoxels) { pick = l; break; }
  }
  return pick;
}

/**
 * Builds a CoarseVolume from a kiln DataProvider: loads every brick of one coarse level (a few dozen bricks, about
 * as much data as a small image) and copies their cores into one array.
 * @param {object} provider  kiln's DataProvider (getMetadata, loadBrick)
 * @param {{maxVoxels?: number, signal?: AbortSignal, onProgress?: (done: number, total: number) => void, concurrency?: number}} [o]
 */
export async function loadCoarseVolume(provider, { maxVoxels = 8_000_000, signal, onProgress, concurrency = 4 } = {}) {
  const meta = provider.getMetadata();
  const level = chooseLevel(meta.levels, maxVoxels);
  const [X, Y, Z] = level.dimensions;
  const grid = level.brickGrid ?? provider.getBrickGrid(level.lod);
  const B = meta.brickSize, P = meta.physicalBrickSize, ghost = Math.floor((P - B) / 2);
  const data = new Float32Array(X * Y * Z);
  const jobs = [];
  for (let bz = 0; bz < grid[2]; bz++) for (let by = 0; by < grid[1]; by++) for (let bx = 0; bx < grid[0]; bx++) jobs.push([bx, by, bz]);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      if (signal?.aborted) throw Object.assign(new Error("Cancelled"), { cancelled: true });
      const [bx, by, bz] = jobs[next++];
      const res = await provider.loadBrick(level.lod, bx, by, bz, 0, signal);
      if (res?.data) {
        const src = res.data;
        const half = src instanceof Uint16Array;
        const x0 = bx * B, y0 = by * B, z0 = bz * B;
        const nx = Math.min(B, X - x0), ny = Math.min(B, Y - y0), nz = Math.min(B, Z - z0);
        for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
          let s = ((z + ghost) * P + (y + ghost)) * P + ghost;
          let d = ((z0 + z) * Y + (y0 + y)) * X + x0;
          for (let x = 0; x < nx; x++, s++, d++) data[d] = half ? halfToFloat(src[s]) : src[s] / 255;
        }
      }
      onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  const full = meta.dimensions;
  return new CoarseVolume({ dims: { x: X, y: Y, z: Z }, data, lod: level.lod, factor: { x: full[0] / X, y: full[1] / Y, z: full[2] / Z } });
}

const interp = (points, x) => {
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  let i = 0;
  while (points[i + 1].x < x) i++;
  const span = points[i + 1].x - points[i].x;
  return span > 0 ? points[i].y + ((points[i + 1].y - points[i].y) * (x - points[i].x)) / span : points[i + 1].y;
};

/** The opacity (0..1) the renderer gives a value: window, then the opacity curve, scaled by the density. */
export function opacityOf(value, { windowCenter = 0.5, windowWidth = 1, points, densityScale = 1 }) {
  const x = clamp((value - (windowCenter - windowWidth / 2)) / Math.max(windowWidth, 1e-6), 0, 1);
  const o = points?.length ? interp([...points].sort((a, b) => a.x - b.x), x) : x;
  return clamp(o * densityScale, 0, 1);
}

export const DVR_THRESHOLD = 0.15; // the opacity at which a ray counts as having reached a structure

/**
 * Where a ray first meets what the 3D view shows, using the coarse volume. `mode` is the render mode:
 *  - "iso": the first crossing of `isoValue` (a surface),
 *  - "mip": the brightest point along the ray,
 *  - anything else (volume rendering): the first sample whose opacity reaches DVR_THRESHOLD.
 * The ray is in world space; `size` are the box extents, `clip` the clipping box ({min, max}, fractions 0..1)
 * outside which nothing is shown. Returns { point (voxel coordinates in `dims`), value, accuracy (voxels) } or null.
 */
export function pickVolume(vol, ray, size, dims, { mode = "dvr", isoValue = 0.5, tf = {}, clip = null } = {}) {
  const half = size.map((s) => s / 2);
  const span = rayBox(ray.origin, ray.dir, half.map((h) => -h), half);
  if (!span) return null;
  let [t0, t1] = span;
  const lo = clip?.min ?? [0, 0, 0], hi = clip?.max ?? [1, 1, 1];
  const cb = rayBox(ray.origin, ray.dir, [0, 1, 2].map((i) => (lo[i] - 0.5) * size[i]), [0, 1, 2].map((i) => (hi[i] - 0.5) * size[i]));
  if (!cb) return null;
  t0 = Math.max(t0, cb[0]);
  t1 = Math.min(t1, cb[1]);
  if (t0 >= t1) return null;
  // steps of at most half a coarse voxel along the dominant axis
  const dn = [ray.dir[0] / size[0], ray.dir[1] / size[1], ray.dir[2] / size[2]];
  const dt = 0.5 / Math.max(Math.abs(dn[0]) * vol.dims.x, Math.abs(dn[1]) * vol.dims.y, Math.abs(dn[2]) * vol.dims.z, 1e-9);
  const at = (t) => [0, 1, 2].map((i) => (ray.origin[i] + ray.dir[i] * t) / size[i] + 0.5);
  const val = (t) => { const n = at(t); return vol.sample(n[0], n[1], n[2]); };
  const op = (v) => opacityOf(v, tf);
  const result = (t, value) => {
    const n = at(t);
    return { point: roundPoint({ x: n[0] * dims.x, y: n[1] * dims.y, z: n[2] * dims.z }), value, accuracy: vol.accuracy, t };
  };
  let prevT = t0, prevV = val(t0);
  if (mode === "mip") {
    let bestT = t0, bestV = prevV;
    for (let t = t0 + dt; t <= t1; t += dt) { const v = val(t); if (v > bestV) { bestV = v; bestT = t; } }
    return bestV > 0.02 ? result(bestT, bestV) : null;
  }
  const f = mode === "iso" ? (v) => v - isoValue : (v) => op(v) - DVR_THRESHOLD; // crosses zero at the surface
  if (f(prevV) >= 0) return result(t0, prevV); // starts inside
  for (let t = t0 + dt; t <= t1 + dt; t += dt) {
    const tt = Math.min(t, t1);
    const v = val(tt);
    if (f(v) >= 0) {
      const f0 = f(prevV), f1 = f(v);
      const s = f1 === f0 ? 1 : clamp(-f0 / (f1 - f0), 0, 1);
      const th = prevT + (tt - prevT) * s;
      return result(th, val(th));
    }
    prevT = tt;
    prevV = v;
    if (tt >= t1) break;
  }
  return null;
}

/** Moves a point so that it stays at the same depth along a new ray (dragging a 3D endpoint): the plane through it facing the camera. */
export function repositionAtDepth(point, ray, cameraDir, dims, size) {
  const w = voxelToWorld(point, dims, size);
  const denom = ray.dir[0] * cameraDir[0] + ray.dir[1] * cameraDir[1] + ray.dir[2] * cameraDir[2];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((w[0] - ray.origin[0]) * cameraDir[0] + (w[1] - ray.origin[1]) * cameraDir[1] + (w[2] - ray.origin[2]) * cameraDir[2]) / denom;
  if (!(t > 0)) return null;
  const nw = ray.origin.map((o, k) => o + ray.dir[k] * t);
  const p = worldToVoxel(nw, dims, size);
  const c = (v, n) => clamp(v, 0, n);
  return roundPoint({ x: c(p.x, dims.x), y: c(p.y, dims.y), z: c(p.z, dims.z) });
}
