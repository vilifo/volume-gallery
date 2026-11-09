// An animation (a PlaybackSpec) as text for a link: ?anim=1.<deflated JSON in base64url>. Anyone who opens
// the link plays the animation, without it having been saved anywhere. The text is untrusted input, so
// decodeSpec only returns a spec that passed sanitizeSpec: known fields, numbers in range, nothing else.

export const ANIM_VERSION = "1";
export const ANIM_PARAM = "anim";
export const ANIM_MAX_CHARS = 8000;        // longer links are refused by too many servers and chat programs
const MAX_INFLATED = 400_000;              // bytes of JSON accepted from a link
const PRESETS = ["coolwarm", "grayscale", "grayscale-inverted", "hot", "cool", "viridis", "plasma", "seismic", "custom"];
const HEX = /^#[0-9a-fA-F]{6}$/;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const vec3 = (v, lo = -1e9, hi = 1e9) => Array.isArray(v) && v.length === 3 && v.every((x) => isNum(x) && x >= lo && x <= hi) ? v.slice() : null;
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);

function sanitizeTf(raw) {
  if (!raw || typeof raw !== "object" || !PRESETS.includes(raw.preset)) return null;
  const points = Array.isArray(raw.points) ? raw.points.slice(0, 64).filter((p) => p && isNum(p.x) && isNum(p.y)).map((p) => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) })) : [];
  if (points.length < 2) return null;
  const tf = { preset: raw.preset, points };
  if (raw.preset === "custom") {
    const stops = Array.isArray(raw.colorStops) ? raw.colorStops.slice(0, 64).filter((s) => s && isNum(s.pos) && typeof s.color === "string" && HEX.test(s.color)).map((s) => ({ pos: clamp(s.pos, 0, 1), color: s.color.toLowerCase() })) : [];
    if (stops.length < 2) return null;
    tf.colorStops = stops;
  }
  if (isNum(raw.windowCenter)) tf.windowCenter = clamp(raw.windowCenter, 0, 1);
  if (isNum(raw.windowWidth)) tf.windowWidth = clamp(raw.windowWidth, 0.001, 1);
  if (isNum(raw.densityScale)) tf.densityScale = clamp(raw.densityScale, 0.01, 100);
  return tf;
}

function sanitizePose(raw) {
  if (!raw || typeof raw !== "object") return null;
  const back = vec3(raw.back), up = vec3(raw.up), target = vec3(raw.target);
  if (!back || !up || !target || !isNum(raw.distance) || raw.distance <= 0 || raw.distance > 1e9) return null;
  if (Math.hypot(...back) < 1e-6 || Math.hypot(...up) < 1e-6) return null;
  const pose = { back, up, distance: raw.distance, target };
  const name = text(raw.name, 80);
  if (name) pose.name = name;
  if (isNum(raw.at)) pose.at = clamp(raw.at, 0, 1);
  const clip3 = (v) => (Array.isArray(v) && v.length === 3 && v.every(isNum) ? v.map((x) => clamp(x, 0, 1)) : null);
  const cmin = clip3(raw.clipMin), cmax = clip3(raw.clipMax);
  if (cmin && cmax) {
    pose.clipMin = cmin.map((lo, i) => Math.min(lo, cmax[i]));
    pose.clipMax = cmax.map((hi, i) => Math.max(hi, cmin[i]));
  }
  const tf = sanitizeTf(raw.tf);
  if (tf) pose.tf = tf;
  return pose;
}

/** The spec if `raw` is a usable PlaybackSpec (everything out of range is brought into range), else null. */
export function sanitizeSpec(raw) {
  if (!raw || typeof raw !== "object" || !["turntable", "path", "slices"].includes(raw.kind)) return null;
  const spec = {
    kind: raw.kind,
    duration: isNum(raw.duration) ? clamp(raw.duration, 1, 3600) : 20,
    end: ["stop", "return", "pingpong"].includes(raw.end) ? raw.end : "return",
    ease: raw.ease === "linear" ? "linear" : "smooth",
    angle: isNum(raw.angle) ? clamp(raw.angle, 1, 3600) : 360,
    direction: raw.direction === -1 ? -1 : 1,
    keys: [],
    step: isNum(raw.step) ? clamp(Math.round(raw.step), 1, 100000) : 1,
    speed: isNum(raw.speed) ? clamp(raw.speed, 0.1, 240) : 10,
    from_index: isNum(raw.from_index) ? clamp(Math.round(raw.from_index), 0, 1e6) : 0,
    to_index: isNum(raw.to_index) ? clamp(Math.round(raw.to_index), 0, 1e6) : 0,
    preload: raw.preload !== false,
    pause_on_touch: raw.pause_on_touch !== false,
  };
  if (["xy", "xz", "yz"].includes(raw.axis)) spec.axis = raw.axis;
  if (Array.isArray(raw.keys)) {
    for (const k of raw.keys.slice(0, 200)) {
      const pose = sanitizePose(k);
      if (!pose) return null; // a broken view would silently change the path: refuse it all
      spec.keys.push(pose);
    }
    if (!spec.keys.every((k) => isNum(k.at))) for (const k of spec.keys) delete k.at;
    else { let prev = 0; for (const k of spec.keys) { k.at = Math.max(prev, k.at); prev = k.at; } }
  }
  if (raw.start) {
    const start = sanitizePose(raw.start);
    if (start) spec.start = start;
  }
  if (spec.kind === "path" && spec.keys.length < 2) return null;
  if (spec.kind === "slices" && !spec.axis) return null;
  return spec;
}

// ---------------------------------------------------------------------------------------- the text
const b64 = {
  encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

async function pipe(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) { await reader.cancel(); throw new Error("too large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** The link text for a spec ("1.…"). Numbers are rounded to 5 decimals to keep it short. */
export async function encodeSpec(spec) {
  const json = JSON.stringify(spec, (k, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : k === "rgb" || k === "blend" ? undefined : v));
  const packed = await pipe(new TextEncoder().encode(json), new CompressionStream("deflate-raw"));
  return `${ANIM_VERSION}.${b64.encode(packed)}`;
}

/** The spec a link text stands for, or null if it is not one (wrong version, damaged, too large, not a valid spec). */
export async function decodeSpec(textValue) {
  try {
    if (typeof textValue !== "string" || textValue.length > ANIM_MAX_CHARS * 2) return null;
    const [version, data] = textValue.split(".");
    if (version !== ANIM_VERSION || !data || !/^[A-Za-z0-9_-]+$/.test(data)) return null;
    const json = await pipe(b64.decode(data), new DecompressionStream("deflate-raw"), MAX_INFLATED);
    return sanitizeSpec(JSON.parse(new TextDecoder().decode(json)));
  } catch (_) {
    return null;
  }
}
