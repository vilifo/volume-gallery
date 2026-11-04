// Animations of a volume: a sweep through the slices of one axis, a 3D turntable, or a 3D camera path
// through saved views. Every frame is rendered completely (the 3D view is waited for until all the data it
// needs has streamed in and the image has converged) and goes to an MP4 video or a zip of images.

import { openFloatingPanel } from "/js/floating-panel.js?v=org2";
import { Mp4Sink, ZipSink, canEncodeVideo } from "/js/animate-io.js?v=org3";
import { waitForRefined, captureRgba, afterFrames, resizeCanvasTo, accessExpiredError } from "/js/render-capture.js?v=org3";

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

/** A camera pose: where the eye is (target + back * distance) and how it is turned. */
export function interpolatePose(a, b, t) {
  const q = slerp(quatFromAxes(a.up, a.back), quatFromAxes(b.up, b.back), t);
  const { up, back } = axesFromQuat(q);
  return {
    back: normalize(back),
    up: normalize(up),
    distance: Math.exp(lerp(Math.log(a.distance), Math.log(b.distance), t)), // zoom feels even in log space
    target: lerp3(a.target, b.target, t),
  };
}

/** The pose turned by `angle` radians about the world up axis (the camera circles the volume). */
export function turntablePose(base, worldUp, angle) {
  return { ...base, back: normalize(rotateAbout(base.back, worldUp, angle)), up: normalize(rotateAbout(base.up, worldUp, angle)) };
}

const smooth = (t) => t * t * (3 - 2 * t);

/** The pose at frame i of `count` along a path of keyframes. */
export function pathPose(keys, i, count, { loop = false, ease = "smooth" } = {}) {
  const segments = loop ? keys.length : keys.length - 1;
  const u = loop ? i / count : count > 1 ? i / (count - 1) : 0;
  const s = u * segments;
  const seg = Math.min(Math.floor(s), segments - 1);
  const t = s - seg;
  return interpolatePose(keys[seg], keys[(seg + 1) % keys.length], ease === "smooth" ? smooth(t) : t);
}

export function readPose(camera) {
  if (!camera.back || !camera.up) throw new Error("3D animations need the free-rotation camera, which this build of the viewer does not have");
  return { back: [...camera.back], up: [...camera.up], distance: camera.distance, target: [...camera.target] };
}

export function writePose(camera, p) {
  camera.back = [...p.back];
  camera.up = [...p.up];
  camera.distance = p.distance;
  camera.target = [...p.target];
  camera.updatePosition();
  camera.anglesFromOrientation?.();
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

// ------------------------------------------------------------------------------------- the panel

const SIZES = { current: "Current view size", "1280x720": "1280 \u00d7 720", "1920x1080": "1920 \u00d7 1080", "2560x1440": "2560 \u00d7 1440", "3840x2160": "3840 \u00d7 2160 (4K)" };
let savedKeyframes = []; // camera poses, kept while the page is open

/**
 * @param {object} o
 * @param {Element} o.anchor
 * @param {string} o.baseName
 * @param {string} o.description
 * @param {() => object|null} o.getViewer       the KilnViewer
 * @param {() => object|null} o.getSlices       the SliceViews, once the slice service is up
 * @param {() => HTMLCanvasElement} o.getCanvas  the render canvas (it is replaced when the volume reloads)
 * @param {HTMLElement} o.pane                  the element holding the canvas
 * @param {object} [o.access]  keeps the data access token valid while 3D frames are rendered:
 *   expiresAt() -> ms timestamp or null, ttlMs() -> token lifetime, renew() -> Promise<new viewer> (reloads the
 *   volume with a fresh token, carrying the view over), onExpired(fn) -> unsubscribe (fn runs when bricks are refused)
 */
export function openAnimatePanel({ anchor, baseName, description, getViewer, getSlices, getCanvas, pane, access = null, onClose }) {
  const root = document.createElement("div");
  root.className = "export-form";
  const sizeOptions = Object.entries(SIZES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  root.innerHTML = `
    <div class="field"><label for="an-kind">Animation</label>
      <select id="an-kind"><option value="slices">Sweep through the slices</option><option value="turntable">3D turntable</option><option value="path">3D camera path</option></select></div>

    <div data-for="slices">
      <div class="field"><label for="an-slice">Slice view</label><select id="an-slice"></select></div>
      <div class="row">
        <div class="field"><label for="an-from">From</label><input id="an-from" type="number" min="0" value="0" /></div>
        <div class="field"><label for="an-to">To</label><input id="an-to" type="number" min="0" value="0" /></div>
        <div class="field"><label for="an-step">Every</label><input id="an-step" type="number" min="1" value="1" /></div>
      </div>
      <div class="row">
        <div class="field"><label for="an-pingpong">Direction</label><select id="an-pingpong"><option value="0">One way</option><option value="1">Back and forth</option></select></div>
        <div class="field"><label for="an-area">Area</label><select id="an-area"><option value="whole">Whole slice</option><option value="visible">Visible area</option></select></div>
      </div>
      <p class="hint">Slices are drawn at one pixel per voxel with the window and colours of the slice view.</p>
    </div>

    <div data-for="turntable">
      <div class="row">
        <div class="field"><label for="an-angle">Turn (degrees)</label><input id="an-angle" type="number" min="1" max="3600" value="360" /></div>
        <div class="field"><label for="an-dir">Direction</label><select id="an-dir"><option value="1">Counter-clockwise</option><option value="-1">Clockwise</option></select></div>
      </div>
      <p class="hint">The camera circles the volume about the up axis, from the view you have now. A full turn ends where it began, so it loops.</p>
    </div>

    <div data-for="path">
      <div class="field"><label>Views on the path</label><div id="an-keys" class="hint" style="margin:0"></div>
        <div class="actions" style="margin-top:0.4em"><button type="button" id="an-addkey">Add current view</button><button type="button" id="an-clearkeys">Clear</button></div></div>
      <div class="row">
        <div class="field"><label for="an-ease">Movement</label><select id="an-ease"><option value="smooth">Ease in and out</option><option value="linear">Constant speed</option></select></div>
        <div class="field"><label for="an-loop">At the end</label><select id="an-loop"><option value="0">Stop at the last view</option><option value="1">Return to the first view</option></select></div>
      </div>
    </div>

    <div data-for="turntable path" class="row">
      <div class="field"><label for="an-duration">Duration (s)</label><input id="an-duration" type="number" min="1" max="600" step="1" value="10" /></div>
      <div class="field"><label for="an-size">Image size</label><select id="an-size">${sizeOptions}</select></div>
    </div>

    <div class="row">
      <div class="field"><label for="an-fps">Frames per second</label><select id="an-fps"><option>24</option><option>25</option><option selected>30</option><option>60</option></select></div>
      <div class="field"><label for="an-out">Save as</label><select id="an-out"><option value="mp4">MP4 video (H.264)</option><option value="zip">Image sequence (zip)</option></select></div>
    </div>
    <div class="row">
      <div class="field" id="an-q-wrap"><label for="an-quality">Video quality</label><select id="an-quality"><option value="medium">Medium</option><option value="high" selected>High</option><option value="max">Very high</option></select></div>
      <div class="field" id="an-fmt-wrap" hidden><label for="an-fmt">Image format</label><select id="an-fmt"><option value="png">PNG</option><option value="tiff">TIFF</option><option value="jpeg">JPEG</option></select></div>
    </div>

    <p class="hint" id="an-info"></p>
    <div class="actions"><button type="button" class="primary" id="an-go">Render animation</button><span class="status" id="an-status" role="status"></span></div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const num = (id) => Number($(id).value);

  const slicesList = () => getSlices()?.visibleSlices() ?? [];
  const sliceInfo = () => slicesList().find((s) => s.axis === $("an-slice").value);
  const threeDVisible = () => pane.dataset.visible === "1" && !!getViewer();

  function fillSlices() {
    const keep = $("an-slice").value;
    const list = slicesList();
    $("an-slice").innerHTML = list.length ? list.map((s) => `<option value="${s.axis}">${s.label.replace(/</g, "&lt;")}</option>`).join("") : `<option value="">No slice view is open</option>`;
    if (list.some((s) => s.axis === keep)) $("an-slice").value = keep;
    const s = sliceInfo();
    if (s) {
      for (const id of ["an-from", "an-to"]) $(id).max = s.count - 1;
      if (!root.dataset.rangeSet || root.dataset.rangeFor !== s.axis) {
        $("an-from").value = 0;
        $("an-to").value = s.count - 1;
        root.dataset.rangeSet = "1";
        root.dataset.rangeFor = s.axis;
      }
    }
  }

  function renderKeys() {
    $("an-keys").innerHTML = savedKeyframes.length
      ? savedKeyframes.map((_, i) => `<div style="display:flex;align-items:center;gap:0.5em">View ${i + 1} <button type="button" data-rm="${i}" style="padding:0 0.5em">Remove</button></div>`).join("")
      : "Turn the 3D view to where the path should start, then add it; repeat for each view the camera should pass through. Two or more are needed.";
    $("an-keys").querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { savedKeyframes.splice(Number(b.dataset.rm), 1); renderKeys(); refresh(); }));
  }

  function sizeOfRun() {
    if (!threeDVisible() && $("an-kind").value !== "slices") return null;
    if ($("an-kind").value === "slices") {
      const s = sliceInfo();
      const r = s ? getSlices().exportRegion(s.axis, $("an-area").value) : null;
      return r ? { width: r.width, height: r.height } : null;
    }
    const v = $("an-size").value;
    if (v === "current") return { width: getCanvas().width, height: getCanvas().height };
    const [w, h] = v.split("x").map(Number);
    return { width: w, height: h };
  }

  function plan() {
    const kind = $("an-kind").value;
    const fps = num("an-fps");
    if (kind === "slices") {
      const s = sliceInfo();
      if (!s) return { error: "Open a slice view first" };
      const indices = sweepIndices(Math.round(num("an-from")), Math.round(num("an-to")), num("an-step"), $("an-pingpong").value === "1");
      if (!indices.length) return { error: "Nothing to render" };
      return { kind, count: indices.length, indices, axis: s.axis, fps };
    }
    if (!threeDVisible()) return { error: "Switch to the 3D or quad layout first" };
    const count = Math.max(2, Math.round(num("an-duration") * fps));
    if (kind === "path" && savedKeyframes.length < 2) return { error: "Add at least two views to the path" };
    return { kind, count, fps };
  }

  function refresh() {
    const kind = $("an-kind").value;
    root.querySelectorAll("[data-for]").forEach((el) => { el.hidden = !el.dataset.for.split(" ").includes(kind); });
    $("an-q-wrap").hidden = $("an-out").value !== "mp4";
    $("an-fmt-wrap").hidden = $("an-out").value !== "zip";
    const p = plan();
    const size = sizeOfRun();
    $("an-go").disabled = !!p.error;
    $("an-info").textContent = p.error ? p.error
      : `${p.count} frames, ${(p.count / p.fps).toFixed(p.count / p.fps < 10 ? 1 : 0)} s at ${p.fps} per second${size ? `, ${size.width} \u00d7 ${size.height} px` : ""}.${kind === "slices" ? "" : " Each frame waits until its data is loaded and the image is clean, so this takes a while."}`;
  }

  let running = false;
  const setStatus = (text, error = false) => { $("an-status").textContent = text; $("an-status").classList.toggle("error", error); };

  // Finishes the sink and downloads what it made; returns the file names.
  async function saveFiles(sink) {
    const files = await sink.finish();
    sink.saved = true;
    const { downloadBlob } = await import("/js/export-image.js?v=org2");
    for (const f of files) { downloadBlob(f.blob, f.filename); await new Promise((r) => setTimeout(r, 400)); }
    return files.map((f) => f.filename).join(", ");
  }


  async function start() {
    const p = plan();
    if (p.error || running) return;
    const kind = p.kind;
    const size = sizeOfRun();
    const toVideo = $("an-out").value === "mp4";
    const abort = new AbortController();
    let sink;
    let overlay;
    let wakeLock = null;
    const restore = [];
    let framesDone = 0;
    running = true;
    $("an-go").disabled = true;
    setStatus("");
    try {
      if (toVideo) {
        if (!(await canEncodeVideo(size.width, size.height, p.fps))) throw new Error("This browser cannot write H.264 video at this size. Save an image sequence instead, or choose a smaller size.");
        sink = new Mp4Sink({ width: size.width, height: size.height, fps: p.fps, quality: $("an-quality").value, baseName });
      } else {
        sink = new ZipSink({ format: $("an-fmt").value, quality: 0.95, baseName: `${baseName}_${kind}`, description });
      }
      overlay = showOverlay({ title: { slices: "Rendering the slice sweep", turntable: "Rendering the turntable", path: "Rendering the camera path" }[kind], onCancel: () => abort.abort() });
      try { wakeLock = (await navigator.wakeLock?.request("screen")) ?? null; } catch (_) { /* optional */ }

      let renderFrame;
      if (kind === "slices") {
        const views = getSlices();
        const area = $("an-area").value;
        renderFrame = (i) => views.exportSlice(p.axis, { area, index: p.indices[i] });
      } else {
        // The 3D view. Its data access token is short-lived: a long animation renews it (reloading the volume,
        // which carries the view over) shortly before it runs out, or at once if bricks start being refused.
        let viewer = getViewer();
        const base = readPose(viewer.camera);
        const wasFree = viewer.camera.isFreeRotation?.();
        const orbit = viewer.camera.getOrbitState?.();
        const scale = viewer.renderScale;
        const [outW, outH] = $("an-size").value === "current" ? [0, 0] : [size.width, size.height];
        let sizeRestore = null;
        let expired = false;
        if (access) { const off = access.onExpired(() => { expired = true; }); restore.push(async () => off()); } // undone last
        restore.push(async () => {
          const v = getViewer();
          if (!v) return;
          v.renderScale = scale;
          writePose(v.camera, base);
          v.camera.setFreeRotation?.(wasFree);
          if (!wasFree && orbit) v.camera.setOrbitState(orbit);
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
          return expired || (at != null && at - Date.now() < Math.min(3 * 60000, (access.ttlMs() || 0) / 4));
        };

        const worldUp = viewer.camera.upVector ?? [0, 1, 0];
        const angle = (num("an-angle") * Math.PI) / 180 * Number($("an-dir").value);
        const loop = $("an-loop").value === "1";
        const ease = $("an-ease").value;
        const keys = savedKeyframes.map((k) => structuredClone(k));
        renderFrame = async (i, onProgress) => {
          for (let attempt = 0; ; attempt++) {
            try {
              if (dueForRenewal()) await renew(onProgress);
              const v = viewer;
              const pose = kind === "turntable" ? turntablePose(base, worldUp, (angle * i) / p.count) : pathPose(keys, i, p.count, { loop, ease });
              writePose(v.camera, pose);
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
      setStatus(`Saved ${names} (${p.count} frames).`);
    } catch (err) {
      if (err.cancelled) {
        sink?.abort();
        setStatus("Cancelled.");
      } else {
        console.error("[animate]", err);
        // Something stopped the run (access that could not be renewed, a full disk, ...): keep what was rendered.
        let kept = "";
        if (sink && framesDone > 0 && !sink.saved) {
          try { kept = ` The ${framesDone} frames rendered so far were saved as ${await saveFiles(sink)}.`; } catch (_) { sink.abort(); }
        } else sink?.abort();
        setStatus(`Stopped at frame ${framesDone + 1} of ${p.count}: ${err.message || err}.${kept}`, true);
      }
    } finally {
      for (const fn of restore.reverse()) { try { await fn(); } catch (e) { console.error("[animate] restore", e); } }
      try { await wakeLock?.release(); } catch (_) { /* already released */ }
      overlay?.close();
      running = false;
      refresh();
    }
  }

  root.addEventListener("change", refresh);
  root.addEventListener("input", (e) => { if (e.target.type === "number") refresh(); });
  $("an-slice").addEventListener("pointerdown", fillSlices);
  $("an-kind").addEventListener("change", () => { fillSlices(); refresh(); });
  $("an-addkey").addEventListener("click", () => {
    try { savedKeyframes.push(readPose(getViewer().camera)); } catch (err) { setStatus(err.message, true); return; }
    renderKeys();
    refresh();
  });
  $("an-clearkeys").addEventListener("click", () => { savedKeyframes = []; renderKeys(); refresh(); });
  $("an-go").addEventListener("click", start);

  const panel = openFloatingPanel({ id: "animate", title: "Animation", content: root, anchor, align: "right", width: 360, onClose });
  if (panel) {
    fillSlices();
    renderKeys();
    // start on what is on screen: a slice sweep when only slices are shown
    if (!threeDVisible() && slicesList().length) $("an-kind").value = "slices";
    else if (threeDVisible() && !slicesList().length) $("an-kind").value = "turntable";
    refresh();
  }
  return panel;
}
