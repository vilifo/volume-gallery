// Pure geometry for the slice views: pane transforms, cursor mapping, windowing.
// No DOM, no WebGPU: unit-tested in frontend/tests/.
//
// Conventions
//   * Voxel indices are integers in the served level, x fastest.
//   * A plane is addressed by (axis, index). `axis` names the plane by the two physical
//     axes it spans and `index` is the voxel index along the third one. Its pixels are
//     (u, v) with u along the row and v down the rows, exactly as the server sends them:
//       "xy"  index = z   u = x   v = y     (slices along Z)
//       "xz"  index = y   u = x   v = z     (slices along Y)
//       "yz"  index = x   u = y   v = z     (slices along X)
//   * "Plane coordinates" are continuous voxel units: voxel i covers [i, i + 1).

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

// ---------------------------------------------------------------- cursor <-> plane

export function planeExtents(axis, dims) {
  const { u, v } = AXIS_INFO[axis];
  return { u: dims[u], v: dims[v] };
}

/** Cursor position inside a pane's plane (voxel centre), in plane coordinates. */
export function cursorInPlane(axis, cursor) {
  const { u, v } = AXIS_INFO[axis];
  return { u: cursor[u] + 0.5, v: cursor[v] + 0.5 };
}

/** Index of the plane a pane shows for this cursor. */
export function planeIndex(axis, cursor) {
  return cursor[AXIS_INFO[axis].normal];
}

// ---------------------------------------------------------------- pane transform

/** Relative voxel size along the plane axes (smallest spacing of the volume = 1). */
export function planeSpacing(axis, spacing) {
  const { u, v } = AXIS_INFO[axis];
  const m = Math.min(spacing.x, spacing.y, spacing.z) || 1;
  return { u: spacing[u] / m, v: spacing[v] / m };
}

/** Pixels per voxel at zoom 1 so the whole plane fits the pane (isotropic part). */
export function fitScale(axis, dims, spacing, width, height, margin = 0.96) {
  const ext = planeExtents(axis, dims);
  const sp = planeSpacing(axis, spacing);
  const s = Math.min(width / (ext.u * sp.u), height / (ext.v * sp.v)) * margin;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** Pixels per voxel along u and v for a pane view ({zoom, centerU, centerV}). */
export function panePpv(axis, dims, spacing, view, width, height) {
  const fit = fitScale(axis, dims, spacing, width, height);
  const sp = planeSpacing(axis, spacing);
  return { u: fit * view.zoom * sp.u, v: fit * view.zoom * sp.v };
}

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

/** Default view: whole plane centred, zoom 1. */
export function defaultView(axis, dims) {
  const ext = planeExtents(axis, dims);
  return { zoom: 1, centerU: ext.u / 2, centerV: ext.v / 2 };
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
