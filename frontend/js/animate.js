// Animations of a volume: a sweep through the slices of one axis, a 3D turntable, or a 3D camera path
// through saved views. The maths of the paths lives here (poses, key times, the clipping box and the transfer
// function that a view can carry), and renderAnimation(): every frame is rendered completely (the 3D view is
// waited for until all the data it needs has streamed in and the image has converged) and goes to an MP4
// video or a zip of images. The timeline panel (timeline.js) is the user interface for all of it.

import { Mp4Sink, ZipSink, canEncodeVideo } from "./animate-io.js";
import { waitForRefined, captureRgba, afterFrames, resizeCanvasTo, accessExpiredError } from "./render-capture.js";

// ------------------------------------------------------------------------- camera poses (pure maths)

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Rotates v about the unit axis k by `angle` radians (Rodrigues). */
export function rotateAbout(v, k, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), d = dot(k, v) * (1 - c);
  const kv = cross(k, v);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}

// Orientation as a quaternion [x, y, z, w] from the camera axes: right = up x back, up, back
function quatFromAxes(up, back) {
  const r = cross(up, back);
  const m00 = r[0], m10 = r[1], m20 = r[2], m01 = up[0], m11 = up[1], m21 = up[2], m02 = back[0], m12 = back[1], m22 = back[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  const l = Math.hypot(...q);
  return q.map((x) => x / l);
}

function axesFromQuat([x, y, z, w]) {
  return {
    up: [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    back: [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  };
}

function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((x) => -x); d = -d; }
  if (d > 0.9995) return normalizeQ(a.map((x, i) => lerp(x, b[i], t)));
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((x, i) => x * wa + b[i] * wb);
}
const normalizeQ = (q) => { const l = Math.hypot(...q); return q.map((x) => x / l); };

export const TF_PRESETS = ["coolwarm", "grayscale", "grayscale-inverted", "hot", "cool", "viridis", "plasma", "seismic"];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const hasClip = (p) => Array.isArray(p?.clipMin) && Array.isArray(p?.clipMax) && p.clipMin.length === 3 && p.clipMax.length === 3;
export const hasTf = (p) => !!p?.tf && Array.isArray(p.tf.points) && p.tf.points.length >= 2;

/** True when the pose's clipping box cuts something off (a pose without a box, or the whole volume, is not clipped). */
export function isClipped(p) {
  return hasClip(p) && (p.clipMin.some((v) => v > 0) || p.clipMax.some((v) => v < 1));
}

// ------------------------------------------------------------------- the transfer function of a view
// A view (key) can carry the transfer function: the colour map (a built-in preset, or "custom" with colour
// stops), the opacity curve, the window and the density. Between two views the opacity curve, the window and
// the density slide linearly and the colours blend (through a 33-colour sample of each map).

const RGB_N = 33;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** The transfer function of a KilnViewer as a key's `tf` (null if the viewer has none). */
export function readTf(viewer) {
  const tf = viewer?.transferFunction;
  if (!tf?.getOpacityPoints) return null;
  const stops = tf.getColorStops?.() ?? null;
  const out = {
    preset: tf.preset === "custom" && !stops ? "grayscale" : tf.preset,
    points: tf.getOpacityPoints().map((p) => ({ x: r4(p.x), y: r4(p.y) })),
  };
  if (out.preset === "custom") out.colorStops = stops.map((s) => ({ pos: r4(s.pos), color: s.color }));
  if (Number.isFinite(viewer.windowCenter)) out.windowCenter = r4(viewer.windowCenter);
  if (Number.isFinite(viewer.windowWidth)) out.windowWidth = r4(viewer.windowWidth);
  const density = viewer.renderer?.densityScale;
  if (Number.isFinite(density)) out.densityScale = r4(density);
  return out;
}

const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (c) => "#" + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");

function stopsRgbAt(stops, x) {
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  if (x <= s[0].pos) return hexToRgb(s[0].color);
  if (x >= s[s.length - 1].pos) return hexToRgb(s[s.length - 1].color);
  let i = 0;
  while (s[i + 1].pos < x) i++;
  const span = s[i + 1].pos - s[i].pos;
  const f = span > 0 ? (x - s[i].pos) / span : 0;
  const a = hexToRgb(s[i].color), b = hexToRgb(s[i + 1].color);
  return a.map((v, k) => v + (b[k] - v) * f);
}

/** The colour map of a key's tf as RGB_N colours (Float32Array of r, g, b, 0..255); a preset is sampled from the viewer. */
function sampleRgb(viewer, spec, cache) {
  if (spec.preset === "custom" && spec.colorStops?.length) {
    const out = new Float32Array(RGB_N * 3);
    for (let i = 0; i < RGB_N; i++) out.set(stopsRgbAt(spec.colorStops, i / (RGB_N - 1)), i * 3);
    return out;
  }
  if (cache.has(spec.preset)) return cache.get(spec.preset);
  const tf = viewer.transferFunction;
  const keep = { preset: tf.preset, stops: tf.getColorStops?.() ?? null, points: tf.getOpacityPoints() };
  const out = new Float32Array(RGB_N * 3);
  try {
    tf.setPreset(spec.preset);
    for (let i = 0; i < RGB_N; i++) out.set(tf.getColor(i / (RGB_N - 1)).slice(0, 3), i * 3);
  } finally { // nothing is drawn in between; put everything back exactly as it was
    if (keep.stops) tf.setColorStops(keep.stops); else tf.setPreset(keep.preset);
    tf.setOpacityPoints(keep.points); // some presets (seismic) also set the opacity curve
  }
  cache.set(spec.preset, out);
  return out;
}

/** A copy of a spec in which every view's transfer function knows its colours, so that they can be blended. */
export function prepareSpec(spec, viewer) {
  if (!viewer?.transferFunction || !spec.keys?.some(hasTf)) return spec;
  const cache = new Map();
  const prep = (k) => (hasTf(k) ? { ...k, tf: { ...k.tf, rgb: sampleRgb(viewer, k.tf, cache) } } : k);
  return { ...spec, keys: spec.keys.map(prep), ...(spec.start ? { start: prep(spec.start) } : {}) };
}

function pointsAt(points, x) {
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  let i = 0;
  while (points[i + 1].x < x) i++;
  const span = points[i + 1].x - points[i].x;
  return span > 0 ? lerp(points[i].y, points[i + 1].y, (x - points[i].x) / span) : points[i + 1].y;
}

/** The opacity curve a fraction t of the way between two curves (resampled at every point of either). */
export function lerpPoints(a, b, t) {
  const sa = [...a].sort((p, q) => p.x - q.x), sb = [...b].sort((p, q) => p.x - q.x);
  const xs = [...new Set([...sa, ...sb].map((p) => p.x))].sort((p, q) => p - q);
  return xs.map((x) => ({ x, y: lerp(pointsAt(sa, x), pointsAt(sb, x), t) }));
}

const sameColours = (a, b) => a.preset === b.preset && (a.preset !== "custom" || JSON.stringify(a.colorStops) === JSON.stringify(b.colorStops));
const pick = (a, b, t, f = lerp) => (Number.isFinite(a) && Number.isFinite(b) ? f(a, b, t) : Number.isFinite(a) ? a : b);

/** The transfer function a fraction t of the way from view a's to view b's (see prepareSpec for blending colours). */
export function interpolateTf(a, b, t) {
  if (a === b || t <= 0) return a;
  if (t >= 1) return b;
  const out = {
    points: lerpPoints(a.points, b.points, t),
    windowCenter: pick(a.windowCenter, b.windowCenter, t),
    windowWidth: pick(a.windowWidth, b.windowWidth, t),
    densityScale: pick(a.densityScale, b.densityScale, t),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (sameColours(a, b)) {
    out.preset = a.preset;
    if (a.colorStops) out.colorStops = a.colorStops;
  } else if (a.rgb && b.rgb) {
    out.preset = "custom";
    out.blend = true;
    out.rgb = a.rgb.map((v, i) => v + (b.rgb[i] - v) * t);
  } else { // colours that were not prepared cannot be blended: switch half way
    const from = t < 0.5 ? a : b;
    out.preset = from.preset;
    if (from.colorStops) out.colorStops = from.colorStops;
  }
  return out;
}

const tfSigs = new WeakMap(); // viewer -> what applyTf set last (to skip frames in which nothing changed)

/** Forget what was applied last: the transfer function may have been changed by hand since. */
export const resetTfSignature = (viewer) => tfSigs.delete(viewer);

/**
 * Sets a transfer function on a KilnViewer. Tells the controls panel (a "vg-tf-changed" event) when something changed.
 * Returns whether it did.
 */
export function applyTf(viewer, t) {
  const tf = viewer?.transferFunction;
  if (!tf || !t || !Array.isArray(t.points)) return false;
  const q = (v) => Math.round(v * 1e4);
  const colours = t.blend ? `b${Array.from(t.rgb, Math.round).join(",")}` : `${t.preset}${t.colorStops ? JSON.stringify(t.colorStops) : ""}`;
  const sig = [colours, t.points.map((p) => `${q(p.x)}:${q(p.y)}`).join(" "), t.windowCenter, t.windowWidth, t.densityScale].join("|");
  if (tfSigs.get(viewer) === sig) return false;
  tfSigs.set(viewer, sig);
  if (t.blend) {
    const stops = Array.from({ length: RGB_N }, (_, i) => ({ pos: i / (RGB_N - 1), color: rgbToHex(Array.from(t.rgb.slice(i * 3, i * 3 + 3))) }));
    tf.setColorStops?.(stops);
  } else if (t.preset === "custom") {
    if (t.colorStops) tf.setColorStops?.(t.colorStops);
  } else if (tf.preset !== t.preset || tf.getColorStops?.()) {
    tf.setPreset(t.preset);
  }
  tf.setOpacityPoints(t.points.map((p) => ({ x: p.x, y: p.y }))); // after the preset: seismic sets its own curve
  if (Number.isFinite(t.windowCenter)) viewer.windowCenter = t.windowCenter;
  if (Number.isFinite(t.windowWidth)) viewer.windowWidth = t.windowWidth;
  if (Number.isFinite(t.densityScale) && viewer.renderer) viewer.renderer.densityScale = t.densityScale;
  viewer.renderer?.markDirty?.();
  viewer.renderer?.resetAccumulation?.();
  window.dispatchEvent(new CustomEvent("vg-tf-changed"));
  return true;
}

// -------------------------------------------------------------------------------------------- poses

/**
 * A camera pose: where the eye is (target + back * distance) and how it is turned. A key can also carry
 *  - `at`: when it is reached, as a fraction 0..1 of one pass (keys without it are spread evenly),
 *  - `clipMin` / `clipMax`: the clipping box of the 3D view (each [x, y, z], a fraction 0..1 of the volume),
 *  - `tf`: the transfer function (see readTf).
 * What a key leaves out stays as it is. If only one of two neighbouring keys has a clipping box or a transfer
 * function, that one is held rather than guessing what the other should have been.
 */
export function interpolatePose(a, b, t) {
  const q = slerp(quatFromAxes(a.up, a.back), quatFromAxes(b.up, b.back), t);
  const { up, back } = axesFromQuat(q);
  const pose = {
    back: normalize(back),
    up: normalize(up),
    distance: Math.exp(lerp(Math.log(a.distance), Math.log(b.distance), t)), // zoom feels even in log space
    target: lerp3(a.target, b.target, t),
  };
  const ca = hasClip(a), cb = hasClip(b);
  const from = ca ? a : cb ? b : null, to = cb ? b : from;
  if (from) {
    pose.clipMin = lerp3(from.clipMin, to.clipMin, t);
    pose.clipMax = lerp3(from.clipMax, to.clipMax, t);
  }
  const ta = hasTf(a) ? a.tf : null, tb = hasTf(b) ? b.tf : null;
  if (ta || tb) pose.tf = interpolateTf(ta ?? tb, tb ?? ta, t);
  return pose;
}

/**
 * The axes a turntable can turn about. The volume is centred on the origin of the viewer's coordinates and its
 * x, y and z axes are the world axes, so every axis but "up" runs through the centre of the volume:
 *  - "up": the up axis the viewer is set to, through the point the camera looks at (what a turntable always did),
 *  - "x", "y", "z": the volume's axes,
 *  - "screen-up", "screen-right": the vertical and the horizontal of the screen in the current view,
 *  - "view": the line of sight of the current view (the picture spins like a wheel).
 */
export const TURN_AXES = ["up", "x", "y", "z", "screen-up", "screen-right", "view"];

/** The unit vector of a turntable axis (for the view axes, taken from the pose the turn starts at). */
export function turnAxisVector(axis, base, worldUp) {
  switch (axis) {
    case "x": return [1, 0, 0];
    case "y": return [0, 1, 0];
    case "z": return [0, 0, 1];
    case "screen-up": return normalize(base.up);
    case "screen-right": return normalize(cross(base.up, base.back)); // right = up x back
    case "view": return normalize(base.back);
    default: return normalize(worldUp);
  }
}

/**
 * The pose turned by `angle` radians about a turntable axis (see TURN_AXES): the camera circles the axis. A positive
 * angle is counter-clockwise seen from the positive end of the axis looking toward the volume. About an axis through
 * the centre of the volume the point the camera looks at circles it too, so a panned view keeps its place in the picture.
 */
export function turntablePose(base, worldUp, angle, axis = "up") {
  const k = turnAxisVector(axis, base, worldUp);
  const pose = { ...base, back: normalize(rotateAbout(base.back, k, angle)), up: normalize(rotateAbout(base.up, k, angle)) };
  if (axis !== "up") pose.target = rotateAbout(base.target, k, angle);
  return pose;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** When each key is reached (0..1 of a pass): its `at` if all keys have one, else evenly spread (a loop gives the way back as much room as any other leg). */
export function keyTimes(keys, loop = false) {
  const n = keys.length;
  if (n && keys.every((k) => Number.isFinite(k.at))) {
    let prev = 0;
    return keys.map((k) => (prev = Math.max(prev, clamp(k.at, 0, 1))));
  }
  return keys.map((_, i) => (loop ? i / n : n > 1 ? i / (n - 1) : 0));
}

/** The pose at frame i of `count` along a path of keyframes. */
export function pathPose(keys, i, count, { loop = false, ease = "smooth" } = {}) {
  return pathPoseAt(keys, loop ? i / count : count > 1 ? i / (count - 1) : 0, { loop, ease });
}

/**
 * The pose a fraction u (0..1) of the way along a path of keyframes. Before the first and after the last
 * key the path holds that key; `loop` closes it: the way from the last key back to the first runs from the
 * last key's time to the first key's time one cycle later.
 */
export function pathPoseAt(keys, u, { loop = false, ease = "smooth" } = {}) {
  const n = keys.length;
  const ez = (t) => (ease === "smooth" ? smooth(t) : t);
  if (n === 1) return interpolatePose(keys[0], keys[0], 0);
  const times = keyTimes(keys, loop);
  let x = clamp(u, 0, 1);
  if (!loop) {
    if (x <= times[0]) return interpolatePose(keys[0], keys[0], 0);
    if (x >= times[n - 1]) return interpolatePose(keys[n - 1], keys[n - 1], 0);
    let i = 0;
    while (i < n - 2 && x >= times[i + 1]) i++;
    const span = times[i + 1] - times[i];
    return interpolatePose(keys[i], keys[i + 1], ez(span > 1e-9 ? (x - times[i]) / span : 1));
  }
  if (x < times[0]) x += 1;
  for (let i = 0; i < n; i++) {
    const t0 = times[i], t1 = i < n - 1 ? times[i + 1] : times[0] + 1;
    if (x < t1 || i === n - 1) {
      const span = t1 - t0;
      return interpolatePose(keys[i], keys[(i + 1) % n], ez(span > 1e-9 ? clamp((x - t0) / span, 0, 1) : 1));
    }
  }
}

/** How far into one pass of an animation, 0..1, it is `t` seconds after it started (a back-and-forth pass is there and back). */
export function passFraction(spec, t) {
  const D = spec.duration;
  if (spec.end === "stop") return Math.min(1, t / D);
  if (spec.end === "pingpong") { const c = (t % (2 * D)) / D; return c < 1 ? c : 2 - c; }
  return (t % D) / D;
}

/**
 * The camera pose `t` seconds into a 3D animation described by a spec (see PlaybackSpec in the backend):
 * `end` "stop" runs once and holds the last pose, "return" loops (a path closes back to its first view, a
 * turntable ends where it began), "pingpong" runs there and back. `duration` is the time of one pass.
 */
export function playPose(spec, base, worldUp, t) {
  const u = passFraction(spec, t);
  if (spec.kind === "turntable") return turntablePose(base, worldUp, (spec.angle * Math.PI) / 180 * spec.direction * u, spec.turn_axis ?? "up");
  return pathPoseAt(spec.keys, u, { loop: spec.end === "return", ease: spec.ease });
}

/**
 * The camera as a pose. With the renderer (viewer.renderer) the pose also records the clipping box and with the
 * viewer the transfer function, so that writePose gives them back; without them the pose is the camera alone.
 */
export function readPose(camera, renderer = null, viewer = null) {
  if (!camera.back || !camera.up) throw new Error("3D animations need the free-rotation camera, which this build of the viewer does not have");
  const pose = { back: [...camera.back], up: [...camera.up], distance: camera.distance, target: [...camera.target] };
  if (renderer?.clipMin && renderer?.clipMax) {
    pose.clipMin = Array.from(renderer.clipMin, r4); // the box is stored as float32: keep the saved numbers short
    pose.clipMax = Array.from(renderer.clipMax, r4);
  }
  const tf = viewer ? readTf(viewer) : null;
  if (tf) pose.tf = tf;
  return pose;
}

/**
 * Turns the camera to a pose. With the renderer, a pose that has a clipping box also sets it, and with the viewer a
 * pose that has a transfer function sets that (the controls panel is told through "vg-clip-changed" and
 * "vg-tf-changed" events so that its sliders follow). What a pose leaves out is left alone.
 */
export function writePose(camera, p, renderer = null, viewer = null) {
  camera.back = [...p.back];
  camera.up = [...p.up];
  camera.distance = p.distance;
  camera.target = [...p.target];
  camera.updatePosition();
  camera.anglesFromOrientation?.();
  if (renderer?.clipMin && renderer?.clipMax && hasClip(p)) {
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const lo = clamp(Math.min(p.clipMin[i], p.clipMax[i]), 0, 1);
      const hi = clamp(Math.max(p.clipMin[i], p.clipMax[i]), 0, 1);
      if (renderer.clipMin[i] !== Math.fround(lo) || renderer.clipMax[i] !== Math.fround(hi)) changed = true;
      renderer.clipMin[i] = lo;
      renderer.clipMax[i] = hi;
    }
    if (changed) {
      renderer.markDirty?.();
      renderer.resetAccumulation?.();
      window.dispatchEvent(new CustomEvent("vg-clip-changed"));
    }
  }
  if (viewer && hasTf(p)) applyTf(viewer, p.tf);
}

/** The key a bookmark stands for: its camera pose plus its clipping box and transfer function (older bookmarks keep them in their options). */
export function poseOfBookmark(entry) {
  const pose = structuredClone(entry.spec.pose);
  const o = entry.spec.options ?? {};
  if (!hasClip(pose) && hasClip({ clipMin: o.clipMin, clipMax: o.clipMax })) {
    pose.clipMin = [...o.clipMin];
    pose.clipMax = [...o.clipMax];
  }
  if (!hasTf(pose) && Array.isArray(o.tfPoints) && o.tfPoints.length >= 2) {
    const preset = o.tfPreset === "custom" && o.tfColorStops?.length ? "custom" : TF_PRESETS.includes(o.tfPreset) ? o.tfPreset : null;
    if (preset) {
      pose.tf = { preset, points: o.tfPoints.map((p) => ({ x: p.x, y: p.y })) };
      if (preset === "custom") pose.tf.colorStops = o.tfColorStops.map((s) => ({ ...s }));
      for (const k of ["windowCenter", "windowWidth", "densityScale"]) if (Number.isFinite(o[k])) pose.tf[k] = o[k];
    }
  }
  return { ...pose, name: entry.name };
}

/** Slice indices of a sweep from `from` to `to` (either way) every `step`; `pingPong` goes back too. */
export function sweepIndices(from, to, step, pingPong = false) {
  step = Math.max(1, Math.round(step));
  const dir = to >= from ? 1 : -1;
  const out = [];
  for (let i = from; dir > 0 ? i <= to : i >= to; i += dir * step) out.push(i);
  if (out.at(-1) !== to && to !== from) out.push(to);
  if (pingPong && out.length > 2) out.push(...out.slice(1, -1).reverse());
  return out;
}

// ------------------------------------------------------------------------------- progress overlay

function showOverlay({ title, onCancel }) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);";
  el.innerHTML = `
    <div class="anim-card" style="background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:var(--radius);padding:1.2em 1.4em;width:min(420px,92vw);box-shadow:0 8px 28px rgba(0,0,0,.4)">
      <div style="font-weight:600;margin-bottom:0.6em" data-title></div>
      <canvas data-preview width="240" height="135" style="width:100%;max-height:200px;object-fit:contain;background:#000;border-radius:4px;display:none"></canvas>
      <div style="height:8px;background:var(--panel-raised);border-radius:4px;overflow:hidden;margin:0.8em 0 0.4em"><div data-bar style="height:100%;width:0;background:var(--accent)"></div></div>
      <div data-line style="font-size:0.9em"></div>
      <div data-sub class="dim" style="font-size:0.8em;margin-top:0.2em;min-height:1.2em"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:0.9em"><button type="button" data-cancel>Cancel</button></div>
    </div>`;
  document.body.append(el);
  const $ = (s) => el.querySelector(s);
  $("[data-title]").textContent = title;
  $("[data-cancel]").addEventListener("click", () => { $("[data-cancel]").disabled = true; $("[data-sub]").textContent = "Cancelling\u2026"; onCancel(); });
  return {
    update({ done, total, text, eta }) {
      $("[data-bar]").style.width = `${total ? (100 * done) / total : 0}%`;
      $("[data-line]").textContent = `Frame ${Math.min(done + 1, total)} of ${total}${eta ? ` \u00b7 about ${eta} left` : ""}`;
      if (text !== undefined) $("[data-sub]").textContent = text;
    },
    async preview(frame) {
      if (!frame.rgba) return;
      const c = $("[data-preview]");
      const bmp = await createImageBitmap(new ImageData(frame.rgba, frame.width, frame.height), { resizeWidth: 240, resizeQuality: "low" });
      c.height = Math.max(1, Math.round((240 * frame.height) / frame.width));
      c.style.display = "block";
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close();
    },
    finishing(text) { $("[data-line]").textContent = text; $("[data-sub]").textContent = ""; },
    close() { el.remove(); },
  };
}

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};


// ------------------------------------------------------------------------------------- rendering

export const SIZES = { current: "Current view size", "1280x720": "1280 \u00d7 720", "1920x1080": "1920 \u00d7 1080", "2560x1440": "2560 \u00d7 1440", "3840x2160": "3840 \u00d7 2160 (4K)" };

// Finishes the sink and downloads what it made; returns the file names.
async function saveFiles(sink) {
  const files = await sink.finish();
  sink.saved = true;
  const { downloadBlob } = await import("./export-image.js");
  for (const f of files) { downloadBlob(f.blob, f.filename); await new Promise((r) => setTimeout(r, 400)); }
  return files.map((f) => f.filename).join(", ");
}

/**
 * Renders an animation frame by frame and saves it as an MP4 video or a zip of images. Resolves with
 * { text, error } to show to the person (it never rejects: a failure keeps the frames rendered so far).
 *
 * @param {object} o
 * @param {"slices"|"turntable"|"path"} o.kind
 * @param {{count: number, fps: number, indices?: number[], axis?: string}} o.plan   frames to render
 * @param {object} [o.spec]        the PlaybackSpec of a 3D animation (see backend PlaybackSpec)
 * @param {{width: number, height: number}} o.size   size of the images, in pixels
 * @param {string} o.sizeKey       "current" or "WIDTHxHEIGHT" (3D: what the canvas is set to)
 * @param {"mp4"|"zip"} o.out
 * @param {string} o.quality       video quality: medium | high | max
 * @param {string} o.format        image format of a zip: png | tiff | jpeg
 * @param {string} o.area          slices: "whole" | "visible"
 * @param {string} o.baseName
 * @param {string} o.description
 * @param {() => object|null} o.getViewer       the KilnViewer
 * @param {() => object|null} o.getSlices       the SliceViews
 * @param {() => HTMLCanvasElement} o.getCanvas  the render canvas (it is replaced when the volume reloads)
 * @param {HTMLElement} o.pane                  the element holding the canvas
 * @param {object} [o.access]  keeps the data access token valid while 3D frames are rendered:
 *   expiresAt() -> ms timestamp or null, ttlMs() -> token lifetime, renew() -> Promise<new viewer> (reloads the
 *   volume with a fresh token, carrying the view over), onExpired(fn) -> unsubscribe (fn runs when bricks are refused)
 * @param {() => void} [o.onStart]   called when the render takes over (the player should stop)
 */
export async function renderAnimation(o) {
  const { kind, plan: p, size, getViewer, getSlices, getCanvas, pane, access = null, baseName, description } = o;
  const toVideo = o.out === "mp4";
  o.onStart?.();
  const abort = new AbortController();
  let sink;
  let overlay;
  let wakeLock = null;
  const restore = [];
  let framesDone = 0;
  let result = { text: "" };
  try {
    if (toVideo) {
      if (!(await canEncodeVideo(size.width, size.height, p.fps))) throw new Error("This browser cannot write H.264 video at this size. Save an image sequence instead, or choose a smaller size.");
      sink = new Mp4Sink({ width: size.width, height: size.height, fps: p.fps, quality: o.quality, baseName });
    } else {
      sink = new ZipSink({ format: o.format, quality: 0.95, baseName: `${baseName}_${kind}`, description });
    }
    overlay = showOverlay({ title: { slices: "Rendering the slice sweep", turntable: "Rendering the turntable", path: "Rendering the camera path" }[kind], onCancel: () => abort.abort() });
    try { wakeLock = (await navigator.wakeLock?.request("screen")) ?? null; } catch (_) { /* optional */ }

    let renderFrame;
    if (kind === "slices") {
      const views = getSlices();
      renderFrame = (i) => views.exportSlice(p.axis, { area: o.area, index: p.indices[i] });
    } else {
      // The 3D view. Its data access token is short-lived. The page renews it in the background (data-access.js);
      // only if that has failed does the animation fall back to reloading the volume (the view carries over).
      let viewer = getViewer();
      const base = readPose(viewer.camera, viewer.renderer, viewer); // with the clipping box and transfer function: restored afterwards
      const wasFree = viewer.camera.isFreeRotation?.();
      const orbit = viewer.camera.getOrbitState?.();
      const scale = viewer.renderScale;
      const [outW, outH] = o.sizeKey === "current" ? [0, 0] : [size.width, size.height];
      let sizeRestore = null;
      let expired = false;
      resetTfSignature(viewer);
      if (access) { const off = access.onExpired(() => { expired = true; }); restore.push(async () => off()); } // undone last
      restore.push(async () => {
        const v = getViewer();
        if (!v) return;
        v.renderScale = scale;
        resetTfSignature(v);
        writePose(v.camera, base, v.renderer, v);
        v.camera.setFreeRotation?.(wasFree);
        if (!wasFree && orbit) v.camera.setOrbitState(orbit);
        window.dispatchEvent(new CustomEvent("vg-tf-changed", { detail: { settled: true } }));
      });
      restore.push(async () => { await sizeRestore?.(); });

      const attach = async (v) => {
        viewer = v;
        v.camera.setFreeRotation?.(true);
        v.renderScale = 1;
        sizeRestore = null;
        if (outW) sizeRestore = await resizeCanvasTo(getCanvas(), pane, outW, outH);
      };
      await attach(viewer);

      const renew = async (onProgress) => {
        if (!access) throw accessExpiredError();
        onProgress("Renewing access to the data\u2026");
        const v = await access.renew();
        if (!v) throw new Error("Access to the volume\u2019s data could not be renewed");
        expired = false;
        await attach(v);
      };
      const dueForRenewal = () => {
        const at = access?.expiresAt();
        return expired || (at != null && at - Date.now() < Math.min(60000, (access.ttlMs() || 0) / 10));
      };

      const worldUp = viewer.camera.upVector ?? [0, 1, 0];
      const spec = prepareSpec(o.spec, viewer);
      const origin = spec.start ?? base; // a turntable can begin from a bookmark
      const cycle = spec.end === "pingpong" ? 2 * spec.duration : spec.duration;
      renderFrame = async (i, onProgress) => {
        for (let attempt = 0; ; attempt++) {
          try {
            if (dueForRenewal()) await renew(onProgress);
            const v = viewer;
            const t = spec.end === "stop" ? (i / Math.max(1, p.count - 1)) * spec.duration : (i / p.count) * cycle;
            const pose = playPose(spec, origin, worldUp, t);
            writePose(v.camera, pose, v.renderer, v);
            await afterFrames();
            await waitForRefined(v, { isCurrent: () => getViewer() === v, onProgress, minMs: 300, expired: () => expired });
            const frame = await captureRgba(v);
            if (expired) throw accessExpiredError(); // bricks were refused while this frame was drawn
            return frame;
          } catch (err) {
            if (!err.expired || attempt >= 3) throw err.expired ? new Error("Access to the volume\u2019s data kept expiring; it could not be renewed") : err;
            expired = true; // renew, then draw this frame again
          }
        }
      };
    }

    const started = performance.now();
    for (let i = 0; i < p.count; i++) {
      if (abort.signal.aborted) throw Object.assign(new Error("Cancelled"), { cancelled: true });
      const done = performance.now() - started;
      overlay.update({ done: i, total: p.count, eta: i >= 2 ? fmtDuration((done / i) * (p.count - i)) : "", text: "" });
      const frame = await renderFrame(i, (text) => overlay.update({ done: i, total: p.count, eta: i >= 2 ? fmtDuration((done / i) * (p.count - i)) : "", text }));
      if (abort.signal.aborted) throw Object.assign(new Error("Cancelled"), { cancelled: true });
      await sink.add(frame, i);
      framesDone = i + 1;
      if (i % 4 === 0) overlay.preview(frame).catch(() => {});
    }
    overlay.finishing(toVideo ? "Finishing the video\u2026" : "Packing the images\u2026");
    const names = await saveFiles(sink);
    result = { text: `Saved ${names} (${p.count} frames).` };
  } catch (err) {
    if (err.cancelled) {
      sink?.abort();
      result = { text: "Cancelled." };
    } else {
      console.error("[animate]", err);
      // Something stopped the run (access that could not be renewed, a full disk, ...): keep what was rendered.
      let kept = "";
      if (sink && framesDone > 0 && !sink.saved) {
        try { kept = ` The ${framesDone} frames rendered so far were saved as ${await saveFiles(sink)}.`; } catch (_) { sink.abort(); }
      } else sink?.abort();
      result = { text: `Stopped at frame ${framesDone + 1} of ${p.count}: ${err.message || err}.${kept}`, error: true };
    }
  } finally {
    for (const fn of restore.reverse()) { try { await fn(); } catch (e) { console.error("[animate] restore", e); } }
    try { await wakeLock?.release(); } catch (_) { /* already released */ }
    overlay?.close();
  }
  return result;
}
