// Transfer function of the slice views: colour stops over the windowed range
// (0 = bottom of the window, 1 = top), baked into a 256-entry RGBA lookup table.
// It is independent of kiln-render's 3D transfer function.
//
// Pure module (no DOM, no GPU), unit-tested in frontend/tests/.

export const TF_SIZE = 256;

const evenly = (colors) => colors.map((color, i) => ({ pos: i / (colors.length - 1), color }));

// Stops sampled from the usual colour maps (linear interpolation between them is
// visually close; "custom" is whatever the user edited).
const PRESETS = {
  gray: [{ pos: 0, color: "#000000" }, { pos: 1, color: "#ffffff" }],
  hot: [{ pos: 0, color: "#000000" }, { pos: 0.36, color: "#e60000" }, { pos: 0.72, color: "#ffe600" }, { pos: 1, color: "#ffffff" }],
  viridis: evenly(["#440154", "#482878", "#3e4a89", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6dcd59", "#b4de2c", "#fde725"]),
  plasma: evenly(["#0d0887", "#6a00a8", "#b12a90", "#e16462", "#fca636", "#f0f921"]),
  turbo: evenly(["#30123b", "#4662d7", "#36aaf9", "#1ae4b6", "#72fe5e", "#c7ef34", "#faba39", "#f66b19", "#ca2a04", "#7a0403"]),
  coolwarm: evenly(["#3b4cc0", "#8db0fe", "#dddddd", "#f4987a", "#b40426"]),
  rainbow: evenly(["#00007f", "#0000ff", "#00ffff", "#ffff00", "#ff0000", "#7f0000"]),
};

export const TF_PRESET_NAMES = Object.keys(PRESETS);
export const TF_LABELS = {
  gray: "Grayscale", hot: "Hot", viridis: "Viridis", plasma: "Plasma", turbo: "Turbo",
  coolwarm: "Cool-warm", rainbow: "Rainbow", custom: "Custom",
};

const HEX = /^#[0-9a-f]{6}$/i;

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Fresh copy of a preset's stops, or null for an unknown name. */
export function presetStops(name) {
  return PRESETS[name] ? PRESETS[name].map((s) => ({ ...s })) : null;
}

/**
 * Sorted, clamped stops that start at 0 and end at 1 (missing end points are added with the
 * nearest colour). Returns null if fewer than one valid stop remains.
 */
export function normalizeStops(stops) {
  const ok = (stops ?? [])
    .filter((s) => s && Number.isFinite(s.pos) && typeof s.color === "string" && HEX.test(s.color))
    .map((s) => ({ pos: Math.min(1, Math.max(0, s.pos)), color: s.color.toLowerCase() }))
    .sort((a, b) => a.pos - b.pos);
  if (!ok.length) return null;
  const out = [];
  for (const s of ok) {
    if (out.length && Math.abs(s.pos - out[out.length - 1].pos) < 1e-6) out[out.length - 1] = s; // same position: last wins
    else out.push(s);
  }
  if (out[0].pos > 0) out.unshift({ pos: 0, color: out[0].color });
  if (out[out.length - 1].pos < 1) out.push({ pos: 1, color: out[out.length - 1].color });
  if (out.length < 2) out.push({ pos: 1, color: out[0].color });
  return out;
}

/** Colour [r, g, b] (0..255) at position t in 0..1. */
export function sampleStops(stops, t) {
  const x = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < stops.length - 1 && stops[i].pos < x) i++;
  const a = stops[i - 1], b = stops[i];
  const span = b.pos - a.pos;
  const f = span > 0 ? Math.min(1, Math.max(0, (x - a.pos) / span)) : 0;
  const ca = hexToRgb(a.color), cb = hexToRgb(b.color);
  return ca.map((v, k) => Math.round(v + (cb[k] - v) * f));
}

/** Inserts a stop at `pos` coloured like the curve at that position. */
export function insertStop(stops, pos) {
  const p = Math.min(1, Math.max(0, pos));
  return normalizeStops([...stops, { pos: p, color: rgbToHex(sampleStops(stops, p)) }]);
}

// ------------------------------------------------------------------------------------------ opacity
// The opacity curve: points {x, y} over the windowed value (x: 0 = bottom of the window, 1 = top; y: 0 = the
// background shows, 1 = the colour). Linear between points. Unlike the colour stops it does not follow "Invert":
// it belongs to the data values, so it lines up with the histogram.

export const defaultAlpha = () => [{ x: 0, y: 1 }, { x: 1, y: 1 }];

/** Sorted, clamped points that start at x = 0 and end at x = 1 (missing end points are added at the nearest
 *  opacity). Returns null if no valid point remains. */
export function normalizeAlpha(points) {
  const ok = (points ?? [])
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }))
    .sort((a, b) => a.x - b.x);
  if (!ok.length) return null;
  const out = [];
  for (const p of ok) {
    if (out.length && p.x - out[out.length - 1].x < 1e-6) out[out.length - 1] = p; // same position: last wins
    else out.push(p);
  }
  if (out[0].x > 0) out.unshift({ x: 0, y: out[0].y });
  if (out[out.length - 1].x < 1) out.push({ x: 1, y: out[out.length - 1].y });
  if (out.length < 2) out.push({ x: 1, y: out[0].y });
  return out;
}

/** Opacity 0..1 at position t in 0..1. */
export function sampleAlpha(points, t) {
  const x = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < points.length - 1 && points[i].x < x) i++;
  const a = points[i - 1], b = points[i];
  const span = b.x - a.x;
  return a.y + (b.y - a.y) * (span > 0 ? Math.min(1, Math.max(0, (x - a.x) / span)) : 0);
}

/** True when nothing is see-through (the colour table's opacity row can be skipped). */
export const isOpaque = (points) => !points || points.every((p) => p.y >= 1);

/** URL form of the opacity curve: "x:y,x:y,...". */
export const encodeAlpha = (points) => points.map((p) => `${+p.x.toFixed(4)}:${+p.y.toFixed(4)}`).join(",");

/** Inverse of encodeAlpha, or null for malformed input (strict: one bad entry rejects the whole value). */
export function decodeAlpha(text) {
  if (!text || !text.includes(":")) return null;
  const pts = text.split(",").map((part) => {
    const [x, y] = part.split(":");
    return { x: x === "" ? NaN : Number(x), y: y === "" || y === undefined ? NaN : Number(y) };
  });
  if (pts.length < 2 || pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  return normalizeAlpha(pts);
}

/**
 * The 2-row table the slice shader reads (TF_SIZE x 2 RGBA): row 0 is the colour table (see buildLut), row 1
 * holds the opacity in its red channel. `alpha` may be null (opaque).
 */
export function buildLutTable(stops, alpha, size = TF_SIZE) {
  const out = new Uint8Array(size * 8);
  out.set(buildLut(stops, size), 0);
  for (let i = 0; i < size; i++) {
    const a = Math.round(255 * (alpha ? sampleAlpha(alpha, i / (size - 1)) : 1));
    out.set([a, a, a, 255], size * 4 + i * 4);
  }
  return out;
}

/** The table for a slice state's transfer function ({ stops, alpha }). */
export const lutFor = (tf) => buildLutTable(tf.stops, tf.alpha);

/** Whether the shader needs the table at all: not for the plain opaque grey ramp. */
export const needsLut = (tf) => !isGrayRamp(tf.stops) || !isOpaque(tf.alpha);

/** RGBA lookup table (opaque), `size` entries. */
export function buildLut(stops, size = TF_SIZE) {
  const lut = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = sampleStops(stops, i / (size - 1));
    lut.set([r, g, b, 255], i * 4);
  }
  return lut;
}

/** True for the plain black-to-white ramp (the shader then skips the table). */
export function isGrayRamp(stops) {
  return stops.length === 2 && stops[0].pos === 0 && stops[1].pos === 1 && stops[0].color === "#000000" && stops[1].color === "#ffffff";
}

/** URL form: a preset name, or "pos:rrggbb,pos:rrggbb,..." for custom stops. */
export function encodeTf(tf) {
  if (tf.preset !== "custom") return tf.preset;
  return tf.stops.map((s) => `${+s.pos.toFixed(4)}:${s.color.slice(1)}`).join(",");
}

/** Inverse of encodeTf; returns {preset, stops} or null for malformed input. */
export function decodeTf(text) {
  if (!text) return null;
  if (PRESETS[text]) return { preset: text, stops: presetStops(text) };
  if (!text.includes(":")) return null;
  const parts = text.split(",").map((part) => {
    const [pos, hex] = part.split(":");
    return { pos: Number(pos), color: `#${hex}` };
  });
  // strict: one bad entry rejects the whole value (a half-read link would show the wrong colours)
  if (parts.length < 2 || parts.some((p) => !Number.isFinite(p.pos) || !HEX.test(p.color))) return null;
  const stops = normalizeStops(parts);
  return stops && stops.length >= 2 ? { preset: "custom", stops } : null;
}
