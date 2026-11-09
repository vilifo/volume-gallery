// The animation timeline: a panel docked to the bottom of the viewer page. A camera path is laid out in time:
// the views (keys) sit on a time axis, each can carry the camera, the clipping planes and the transfer function,
// and they can be moved, added at the playhead, replaced from the current view and removed. The playhead plays
// the animation and scrubs it (showing the view at that time). Turntables and slice sweeps use the same
// transport. Rendering to a video / image sequence, saved paths and links to an animation are in the side columns.
//
// The panel keeps its state while it is hidden (the keys, the settings), so reopening it picks up where it was.

import {
  hasClip, hasTf, isClipped, passFraction, playPose, poseOfBookmark, prepareSpec, readPose, readTf,
  renderAnimation, resetTfSignature, SIZES, sweepIndices, writePose, keyTimes,
} from "/js/animate.js?v=tl1";
import { ANIM_MAX_CHARS, ANIM_PARAM, encodeSpec } from "/js/anim-url.js?v=tl1";

const esc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const MIN_GAP = 0.002; // closest two keys can be, as a fraction of a pass
const KIND_LABEL = { path: "Camera path", turntable: "Turntable", slices: "Slice sweep" };
const LANES = [
  ["view", "View", () => true],
  ["clip", "Clipping", hasClip],
  ["tf", "Transfer function", hasTf],
];

let keys = []; // the views of the camera path, kept while the page is open (each has `at`)

const STYLE = `
.tl { position: relative; flex: 0 0 auto; background: var(--panel); border-top: 1px solid var(--line); color: var(--text); font-size: 12px; max-height: 46vh; overflow: auto; }
.tl[hidden] { display: none; }
.tl button { font-size: 12px; padding: 0.2em 0.6em; }
.tl input, .tl select { font-size: 12px; min-width: 0; }
.tl-head { display: flex; align-items: center; gap: 0.6em; padding: 0.35em 0.8em; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tl-head .grow { flex: 1 1 auto; min-width: 0; }
.tl-time { font-family: var(--mono); color: var(--text-dim); white-space: nowrap; }
.tl-status { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-status.error { color: var(--danger); }
.tl-grid { display: grid; grid-template-columns: 15.5rem minmax(0, 1fr) 17rem; }
@media (max-width: 1150px) { .tl-grid { grid-template-columns: minmax(0, 1fr); } .tl-col + .tl-col { border-top: 1px solid var(--line); border-left: 0 !important; } }
.tl-col { padding: 0.5em 0.8em; min-width: 0; }
.tl-col + .tl-col { border-left: 1px solid var(--line); }
.tl-f { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4em 0.6em; }
.tl-f label { display: flex; flex-direction: column; gap: 0.15em; color: var(--text-dim); }
.tl-f label.wide { grid-column: 1 / -1; }
.tl-f label.check { flex-direction: row; align-items: center; gap: 0.4em; }
.tl-f input[type="checkbox"] { width: auto; }
.tl [hidden] { display: none !important; }
.tl-sub { color: var(--text-dim); font-size: 11px; margin: 0.4em 0 0; }
.tl-h { margin: 0 0 0.35em; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
.tl-bar { display: flex; flex-wrap: wrap; gap: 0.4em; align-items: center; margin-bottom: 0.5em; }
.tl-tracks { position: relative; user-select: none; -webkit-user-select: none; touch-action: none; cursor: col-resize; }
.tl-row { display: grid; grid-template-columns: 7.2rem minmax(0, 1fr); align-items: center; min-height: 24px; }
.tl-row > .tl-lbl { color: var(--text-dim); font-size: 11px; padding-right: 0.5em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-axis { position: relative; height: 24px; margin: 0 12px; border-bottom: 1px solid var(--line); }
.tl-row.ruler .tl-axis { height: 20px; border-bottom: 1px solid var(--line-strong, var(--line)); }
.tl-tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--line); }
.tl-tick span { position: absolute; top: 1px; left: 3px; font: 10px var(--mono); color: var(--text-dim); white-space: nowrap; }
.tl-seg { position: absolute; top: 50%; height: 4px; margin-top: -2px; background: var(--accent); opacity: 0.45; border-radius: 2px; }
.tl-key { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; padding: 0 !important; transform: rotate(45deg); background: var(--panel-raised); border: 2px solid var(--text-dim); border-radius: 2px; cursor: ew-resize; }
.tl-key.on { background: var(--accent); border-color: var(--accent); }
.tl-key.sel { outline: 2px solid var(--accent); outline-offset: 2px; }
.tl-key.cut { background: var(--danger); border-color: var(--danger); }
.tl-over { position: absolute; left: 7.2rem; right: 0; top: 0; bottom: 0; pointer-events: none; }
.tl-over > div { position: absolute; top: 0; bottom: 0; left: 12px; right: 12px; }
.tl-playhead { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px solid var(--accent); }
.tl-playhead::before { content: ""; position: absolute; top: 0; left: -6px; border: 5px solid transparent; border-top: 7px solid var(--accent); }
.tl-ins { margin-top: 0.6em; padding-top: 0.5em; border-top: 1px solid var(--line); }
.tl-ins .tl-f { grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); }
.tl-ins .acts { display: flex; flex-wrap: wrap; gap: 0.4em; align-items: center; margin-top: 0.4em; }
.tl-ins .acts .lbl { color: var(--text-dim); min-width: 8rem; }
.tl-saved .acts { display: flex; flex-wrap: wrap; gap: 0.35em; margin: 0.35em 0; }
.tl-hr { border: 0; border-top: 1px solid var(--line); margin: 0.6em 0; }
`;

/**
 * @param {object} o
 * @param {HTMLElement} o.dock           the element the timeline goes into (below the viewer panes)
 * @param {string} o.baseName
 * @param {string} o.description
 * @param {() => object|null} o.getViewer       the KilnViewer
 * @param {() => object|null} o.getSlices       the SliceViews, once the slice service is up
 * @param {() => HTMLCanvasElement} o.getCanvas  the render canvas (it is replaced when the volume reloads)
 * @param {HTMLElement} o.pane                  the element holding the canvas
 * @param {object} [o.player]  plays an animation on screen (playback.js)
 * @param {object} [o.store]   saved paths (saved-paths.js)
 * @param {object} [o.bookmarks] bookmarks (saved-paths.js): their views can be keys / the turntable's start
 * @param {object} [o.access]  keeps the data access token valid while 3D frames are rendered (see renderAnimation)
 * @param {() => void} [o.onToggle]  called when the panel is shown or hidden
 * @param {Function} [o.render]  renders an animation (default renderAnimation)
 * @param {() => string} [o.pageUrl]  the address of the page, for links (default location.href)
 */
export function createTimeline({
  dock, baseName, description, getViewer, getSlices, getCanvas, pane, access = null, player = null, store = null,
  bookmarks = null, onToggle = () => {}, render = renderAnimation, pageUrl = () => location.href,
}) {
  if (!document.getElementById("tl-style")) {
    const st = document.createElement("style");
    st.id = "tl-style";
    st.textContent = STYLE;
    document.head.append(st);
  }
  const root = document.createElement("div");
  root.className = "tl";
  root.hidden = true;
  const sizeOptions = Object.entries(SIZES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  root.innerHTML = `
    <div class="tl-head">
      <strong>Animation</strong>
      <select id="tl-kind" aria-label="Kind of animation">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <button type="button" class="primary" id="tl-play" title="Play from the playhead">\u25b6</button>
      <button type="button" id="tl-stop" title="Stop and go back to the view you had">\u23f9</button>
      <span class="tl-time" id="tl-time">0:00.0 / 0:10.0</span>
      <button type="button" id="tl-back" hidden title="Put the view back as it was before you scrubbed">Back to my view</button>
      <span class="tl-status grow" id="tl-status" role="status"></span>
      <button type="button" id="tl-close" title="Close the timeline (it keeps its settings)">\u2715</button>
    </div>
    <div class="tl-grid">
      <div class="tl-col tl-left">
        <h3 class="tl-h">Settings</h3>
        <div class="tl-f">
          <label data-for="path turntable"><span>Duration (s)</span><input id="tl-duration" type="number" min="1" max="600" step="1" value="10" /></label>
          <label data-for="path"><span>At the end</span><select id="tl-loop"><option value="stop">Stop at the last view</option><option value="return">Return to the first</option><option value="pingpong">Back and forth</option></select></label>
          <label data-for="path"><span>Movement</span><select id="tl-ease"><option value="smooth">Ease in and out</option><option value="linear">Constant speed</option></select></label>
          <label data-for="turntable"><span>Turn (degrees)</span><input id="tl-angle" type="number" min="1" max="3600" value="360" /></label>
          <label data-for="turntable"><span>Direction</span><select id="tl-dir"><option value="1">Counter-clockwise</option><option value="-1">Clockwise</option></select></label>
          <label data-for="turntable"><span>Each pass</span><select id="tl-tend"><option value="return">Full turn, then again</option><option value="pingpong">Back and forth</option></select></label>
          <label data-for="turntable" class="wide" id="tl-start-wrap"><span>Start from</span><select id="tl-start"><option value="">The current view</option></select></label>
          <label data-for="slices" class="wide"><span>Slice view</span><select id="tl-slice"></select></label>
          <label data-for="slices"><span>From</span><input id="tl-from" type="number" min="0" value="0" /></label>
          <label data-for="slices"><span>To</span><input id="tl-to" type="number" min="0" value="0" /></label>
          <label data-for="slices"><span>Every</span><input id="tl-step" type="number" min="1" value="1" /></label>
          <label data-for="slices"><span>Slices per second</span><input id="tl-speed" type="number" min="1" max="240" value="10" /></label>
          <label data-for="slices"><span>Direction</span><select id="tl-pingpong"><option value="0">One way</option><option value="1">Back and forth</option></select></label>
          <label data-for="slices"><span>Area (render)</span><select id="tl-area"><option value="whole">Whole slice</option><option value="visible">Visible area</option></select></label>
          <label class="check wide" data-for="path turntable"><input type="checkbox" id="tl-preload" checked /> <span>Load the data of the whole path first</span></label>
          <label class="check wide"><input type="checkbox" id="tl-touch" checked /> <span>Pause when I touch the view</span></label>
        </div>
        <p class="tl-sub" data-for="turntable">Circles the volume about the up axis from the view you have now, with the clipping and transfer function it has now. A full turn ends where it began, so it loops.</p>
        <p class="tl-sub" data-for="slices">Rendered slices are drawn at one pixel per voxel with the window and colours of the slice view. Slices are fetched one at a time while a sweep plays.</p>
      </div>

      <div class="tl-col tl-center">
        <div class="tl-bar" data-for="path">
          <button type="button" id="tl-addkey" title="Add the view you see now at the playhead">+ Add current view</button>
          <label style="display:inline-flex;gap:0.3em;align-items:center"><input type="checkbox" id="tl-inc-clip" checked style="width:auto" /> Clipping</label>
          <label style="display:inline-flex;gap:0.3em;align-items:center"><input type="checkbox" id="tl-inc-tf" checked style="width:auto" /> Transfer function</label>
          <span id="tl-bm-wrap" style="display:inline-flex;gap:0.3em"><select id="tl-bm" style="max-width:11em"></select><button type="button" id="tl-addbm">+ Bookmark</button></span>
          <button type="button" id="tl-clearkeys">Clear</button>
        </div>
        <div class="tl-tracks" id="tl-tracks">
          <div class="tl-row ruler"><span class="tl-lbl" id="tl-rlbl">Time</span><div class="tl-axis" id="tl-ruler"></div></div>
          <div id="tl-lanes"></div>
          <div class="tl-over"><div><div class="tl-playhead" id="tl-playhead" style="left:0%"></div></div></div>
        </div>
        <p class="tl-sub" id="tl-hint"></p>
        <div class="tl-ins" id="tl-inspector" hidden></div>
      </div>

      <div class="tl-col tl-right">
        <h3 class="tl-h">Render</h3>
        <div class="tl-f">
          <label data-for="path turntable"><span>Image size</span><select id="tl-size">${sizeOptions}</select></label>
          <label><span>Frames per second</span><select id="tl-fps"><option>24</option><option>25</option><option selected>30</option><option>60</option></select></label>
          <label><span>Save as</span><select id="tl-out"><option value="mp4">MP4 video (H.264)</option><option value="zip">Image sequence (zip)</option></select></label>
          <label id="tl-q-wrap"><span>Video quality</span><select id="tl-quality"><option value="medium">Medium</option><option value="high" selected>High</option><option value="max">Very high</option></select></label>
          <label id="tl-fmt-wrap" hidden><span>Image format</span><select id="tl-fmt"><option value="png">PNG</option><option value="tiff">TIFF</option><option value="jpeg">JPEG</option></select></label>
        </div>
        <p class="tl-sub" id="tl-info"></p>
        <div class="tl-bar"><button type="button" class="primary" id="tl-go">Render animation</button><button type="button" id="tl-copylink" title="A link that plays this animation, without saving it">Copy link to this animation</button></div>
        <div class="tl-saved" id="tl-saved-box">
          <hr class="tl-hr" />
          <h3 class="tl-h">Saved paths</h3>
          <select id="tl-saved" aria-label="Saved paths" style="width:100%"></select>
          <div class="acts"><button type="button" id="tl-load">Load</button><button type="button" id="tl-playsaved">Play</button><button type="button" id="tl-link">Copy link</button><button type="button" id="tl-delete">Delete</button></div>
          <input id="tl-name" maxlength="80" placeholder="Name" style="width:100%" aria-label="Name for saving" />
          <div class="acts"><button type="button" id="tl-save-local">Save in this browser</button><button type="button" id="tl-save-shared">Save for everyone</button></div>
          <p class="tl-sub" id="tl-save-hint"></p>
        </div>
      </div>
    </div>`;
  dock.append(root);
  const $ = (id) => root.querySelector(`#${id}`);
  const num = (id) => Number($(id).value);

  const slicesList = () => getSlices()?.visibleSlices() ?? [];
  const sliceInfo = () => slicesList().find((s) => s.axis === $("tl-slice").value);
  const threeDVisible = () => pane.dataset.visible === "1" && !!getViewer();
  const kind = () => $("tl-kind").value;
  const duration = () => Math.max(1, num("tl-duration") || 10);
  const setStatus = (text, error = false) => { $("tl-status").textContent = text; $("tl-status").classList.toggle("error", error); };

  let playheadU = 0;
  let sel = -1; // the selected key
  let running = false; // a render is in progress
  let savedStart = null; // the turntable's start view that came with a loaded path
  let preparedFor = null; // [signature, prepared spec]: the colours of the keys, sampled once per change of the keys

  // ------------------------------------------------------------------------------------ keys
  const ensureTimes = () => {
    if (keys.length && !keys.every((k) => Number.isFinite(k.at))) {
      const t = keyTimes(keys.map((k) => ({ ...k, at: undefined })), $("tl-loop").value === "return");
      keys.forEach((k, i) => { k.at = Math.round(t[i] * 1000) / 1000; });
    }
  };
  /** Where a view added now goes: at the playhead, or after the last key if the playhead sits on one. */
  function nextTime() {
    if (!keys.length) return 0;
    const last = Math.max(...keys.map((k) => k.at));
    const free = !keys.some((k) => Math.abs(k.at - playheadU) < 0.004);
    return Math.round((free ? playheadU : Math.min(1, last + Math.max(0.05, (1 - last) / 2))) * 1000) / 1000;
  }
  function addKey(pose) {
    ensureTimes();
    pose.at = nextTime();
    let i = keys.findIndex((k) => k.at > pose.at);
    if (i < 0) i = keys.length;
    keys.splice(i, 0, pose);
    sel = i;
    changed();
  }
  const invalidate = () => { preparedFor = null; };
  function changed() {
    invalidate();
    renderLanes();
    renderInspector();
    refresh();
  }

  // ----------------------------------------------------------------------------- the time axis
  function renderRuler() {
    const D = duration();
    const width = $("tl-ruler").clientWidth || 600;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => (s / D) * width >= 56) ?? steps[steps.length - 1];
    let html = "";
    for (let t = 0; t <= D + 1e-9; t += step) html += `<div class="tl-tick" style="left:${(t / D) * 100}%"><span>${t % 1 ? t.toFixed(1) : t}s</span></div>`;
    $("tl-ruler").innerHTML = html;
  }

  function renderLanes() {
    const isPath = kind() === "path";
    $("tl-lanes").hidden = !isPath;
    renderRuler();
    $("tl-rlbl").textContent = isPath ? "Time" : KIND_LABEL[kind()];
    if (!isPath) { $("tl-lanes").innerHTML = ""; return; }
    const D = duration();
    $("tl-lanes").innerHTML = LANES.map(([lane, label, has]) => {
      const mine = keys.map((k, i) => [k, i]).filter(([k]) => has(k));
      const segs = lane === "view" ? [] : mine.slice(1).map(([k], j) => {
        const a = mine[j][0];
        return `<div class="tl-seg" style="left:${a.at * 100}%;width:${Math.max(0, k.at - a.at) * 100}%"></div>`;
      });
      const marks = mine.map(([k, i]) => {
        const cls = ["tl-key", lane === "view" ? "" : "on", i === sel ? "sel" : "", lane === "clip" && isClipped(k) ? "cut" : ""].filter(Boolean).join(" ");
        const title = `${k.name ? `${k.name} \u2014 ` : ""}View ${i + 1} at ${fmtTime(k.at * D)}${lane === "clip" ? (isClipped(k) ? " (cuts the volume)" : " (whole volume)") : ""}`;
        return `<button type="button" class="${cls}" data-i="${i}" data-lane="${lane}" style="left:${k.at * 100}%" title="${esc(title)}" aria-label="${esc(title)}"></button>`;
      });
      return `<div class="tl-row" data-lane="${lane}"><span class="tl-lbl">${label}</span><div class="tl-axis">${segs.join("")}${marks.join("")}</div></div>`;
    }).join("");
    $("tl-hint").textContent = keys.length ? "Click the strip to move the playhead (the view follows); drag a diamond to retime it; Delete removes the selected view."
      : "Turn the 3D view to where the path should start and add it; move the playhead, change the view and add the next one. Two or more views make a path.";
  }

  function setPlayhead(u) {
    playheadU = clamp(u, 0, 1);
    $("tl-playhead").style.left = `${playheadU * 100}%`;
    const D = duration();
    $("tl-time").textContent = `${fmtTime(playheadU * D)} / ${fmtTime(D)}`;
  }

  // -------------------------------------------------------------------- the selected key
  function renderInspector() {
    const box = $("tl-inspector");
    const k = keys[sel];
    box.hidden = kind() !== "path" || !k;
    if (box.hidden) return;
    const D = duration();
    box.innerHTML = `
      <div class="tl-f">
        <label><span>View ${sel + 1} of ${keys.length}</span><input id="tl-k-name" maxlength="80" placeholder="Name (optional)" value="${esc(k.name || "")}" /></label>
        <label><span>Time (s)</span><input id="tl-k-time" type="number" min="0" max="${D}" step="0.1" value="${(k.at * D).toFixed(2)}" /></label>
      </div>
      <div class="acts"><span class="lbl">View</span><button type="button" id="tl-k-view" title="Replace this view's camera with the one you see now">Take current view</button>
        <button type="button" id="tl-k-rm">Remove view</button></div>
      <div class="acts"><span class="lbl">Clipping planes ${hasClip(k) ? (isClipped(k) ? "(cutting)" : "(whole volume)") : "(left alone)"}</span>
        <button type="button" id="tl-k-clip">Take current</button><button type="button" id="tl-k-clip-x" ${hasClip(k) ? "" : "disabled"}>Clear</button></div>
      <div class="acts"><span class="lbl">Transfer function ${hasTf(k) ? `(${esc(k.tf.preset)})` : "(left alone)"}</span>
        <button type="button" id="tl-k-tf">Take current</button><button type="button" id="tl-k-tf-x" ${hasTf(k) ? "" : "disabled"}>Clear</button></div>`;
    const viewer = () => getViewer();
    const withViewer = (fn) => { try { fn(viewer()); acceptView(); changed(); } catch (err) { setStatus(err.message || String(err), true); } };
    $("tl-k-name").addEventListener("change", (e) => { keys[sel].name = e.target.value.trim().slice(0, 80) || undefined; if (!keys[sel].name) delete keys[sel].name; changed(); });
    $("tl-k-time").addEventListener("change", (e) => moveKey(sel, Number(e.target.value) / D));
    $("tl-k-rm").addEventListener("click", () => removeKey(sel));
    $("tl-k-view").addEventListener("click", () => withViewer((v) => {
      const now = readPose(v.camera);
      Object.assign(keys[sel], { back: now.back, up: now.up, distance: now.distance, target: now.target });
    }));
    $("tl-k-clip").addEventListener("click", () => withViewer((v) => { const n = readPose(v.camera, v.renderer); keys[sel].clipMin = n.clipMin; keys[sel].clipMax = n.clipMax; }));
    $("tl-k-clip-x").addEventListener("click", () => { delete keys[sel].clipMin; delete keys[sel].clipMax; changed(); });
    $("tl-k-tf").addEventListener("click", () => withViewer((v) => { const tf = readTf(v); if (!tf) throw new Error("This view has no transfer function"); keys[sel].tf = tf; }));
    $("tl-k-tf-x").addEventListener("click", () => { delete keys[sel].tf; changed(); });
  }

  function moveKey(i, at) {
    if (!keys[i] || !Number.isFinite(at)) return;
    const lo = i > 0 ? keys[i - 1].at + MIN_GAP : 0;
    const hi = i < keys.length - 1 ? keys[i + 1].at - MIN_GAP : 1;
    keys[i].at = Math.round(clamp(at, lo, Math.max(lo, hi)) * 1000) / 1000;
    changed();
  }
  function removeKey(i) {
    if (!keys[i]) return;
    keys.splice(i, 1);
    sel = Math.min(sel, keys.length - 1);
    changed();
  }

  // ---------------------------------------------------------------- scrubbing (showing a time)
  let scrub = null; // while the view shows a time of the animation: what it was before
  function prepared(spec) {
    const sig = JSON.stringify(spec);
    if (preparedFor?.[0] === sig) return preparedFor[1];
    const out = prepareSpec(spec, getViewer());
    preparedFor = [sig, out];
    return out;
  }
  async function backToMyView() {
    if (!scrub) return;
    const s = scrub;
    scrub = null;
    $("tl-back").hidden = true;
    try {
      if (s.slices) s.slices.views.state.setCursor({ [s.slices.normal]: s.slices.index }, "play");
      else {
        const v = getViewer();
        if (v) {
          resetTfSignature(v);
          writePose(v.camera, s.base, v.renderer, v);
          v.camera.setFreeRotation?.(s.wasFree);
          if (!s.wasFree && s.orbit) v.camera.setOrbitState(s.orbit);
        }
      }
    } catch (err) { console.error("[timeline] back", err); }
  }

  /** What is on screen now is what the person wants (they add or take it as a view): there is nothing to go back to. */
  function acceptView() {
    scrub = null;
    $("tl-back").hidden = true;
  }

  /** Shows the animation at the fraction u of a pass: the playing one jumps there, an idle one is previewed. */
  function seek(u) {
    u = clamp(u, 0, 1);
    setPlayhead(u);
    if (player && player.state !== "idle") { player.seek(u); return; }
    const built = buildSpec();
    if (built.error) return;
    const { spec } = built;
    if (spec.kind === "slices") {
      const views = getSlices();
      const info = sliceInfo();
      if (!views || !info) return;
      if (!scrub) { scrub = { slices: { views, normal: info.normal, index: info.index } }; $("tl-back").hidden = false; }
      const idx = sweepIndices(Math.min(info.count - 1, spec.from_index), Math.min(info.count - 1, spec.to_index), spec.step, spec.end === "pingpong");
      views.state.setCursor({ [info.normal]: idx[Math.min(idx.length - 1, Math.floor(Math.min(0.9999, u) * idx.length))] }, "play");
      return;
    }
    const v = getViewer();
    if (!v || !threeDVisible()) return;
    try {
      if (!scrub) {
        scrub = { base: readPose(v.camera, v.renderer, v), wasFree: v.camera.isFreeRotation?.(), orbit: v.camera.getOrbitState?.() };
        $("tl-back").hidden = false;
      }
      v.camera.setFreeRotation?.(true);
      const base = spec.kind === "turntable" && spec.start ? spec.start : scrub.base;
      const pose = playPose(prepared(spec), base, v.camera.upVector ?? [0, 1, 0], (spec.end === "stop" ? u : Math.min(u, 0.9999)) * spec.duration);
      writePose(v.camera, pose, v.renderer, v);
    } catch (err) { setStatus(err.message || String(err), true); }
  }

  // ---------------------------------------------------------------------------------- the spec
  function plan() {
    const k = kind();
    const fps = num("tl-fps");
    if (k === "slices") {
      const s = sliceInfo();
      if (!s) return { error: "Open a slice view first" };
      const indices = sweepIndices(Math.round(num("tl-from")), Math.round(num("tl-to")), num("tl-step"), $("tl-pingpong").value === "1");
      if (!indices.length) return { error: "Nothing to render" };
      return { kind: k, count: indices.length, indices, axis: s.axis, fps };
    }
    if (!threeDVisible()) return { error: "Switch to the 3D or quad layout first" };
    if (k === "path" && keys.length < 2) return { error: "Add at least two views to the path" };
    const spec = buildSpec().spec;
    const count = Math.max(2, Math.round(duration() * fps * (spec.end === "pingpong" ? 2 : 1)));
    return { kind: k, count, fps };
  }

  /** The settings as a PlaybackSpec (the form that is saved, played and put in links). */
  function buildSpec() {
    const k = kind();
    const spec = {
      kind: k,
      duration: duration(),
      end: "return",
      ease: $("tl-ease").value,
      angle: Math.max(1, num("tl-angle") || 360),
      direction: Number($("tl-dir").value),
      keys: k === "path" ? (ensureTimes(), keys.map((x) => structuredClone(x))) : [],
      step: Math.max(1, Math.round(num("tl-step") || 1)),
      speed: Math.min(240, Math.max(0.5, num("tl-speed") || 10)),
      preload: k !== "slices" && $("tl-preload").checked, // slices are never preloaded
      pause_on_touch: $("tl-touch").checked,
    };
    if (k === "turntable") {
      spec.end = $("tl-tend").value;
      const start = $("tl-start").value;
      if (start === "saved" && savedStart) spec.start = structuredClone(savedStart);
      else if (start) {
        const e = bookmarkList.find((b) => bmKey(b) === start);
        if (e) spec.start = poseOfBookmark(e);
      }
    }
    if (k === "path") spec.end = $("tl-loop").value;
    if (k === "slices") {
      const s = sliceInfo();
      if (!s) return { error: "Open a slice view first" };
      spec.axis = s.axis;
      spec.from_index = Math.max(0, Math.round(num("tl-from")));
      spec.to_index = Math.max(0, Math.round(num("tl-to")));
      spec.end = $("tl-pingpong").value === "1" ? "pingpong" : "return";
    }
    if (k === "path" && spec.keys.length < 2) return { error: "Add at least two views to the path" };
    return { spec };
  }

  /** Puts a spec (saved, or from a link) into the panel. */
  function applySpec(spec) {
    $("tl-kind").value = spec.kind;
    $("tl-duration").value = spec.duration;
    $("tl-ease").value = spec.ease;
    $("tl-angle").value = spec.angle;
    $("tl-dir").value = String(spec.direction);
    $("tl-step").value = spec.step;
    $("tl-speed").value = spec.speed;
    $("tl-preload").checked = spec.preload;
    $("tl-touch").checked = spec.pause_on_touch;
    if (spec.kind === "turntable") {
      $("tl-tend").value = spec.end === "pingpong" ? "pingpong" : "return";
      $("tl-start").querySelector('option[value="saved"]')?.remove();
      savedStart = spec.start ? structuredClone(spec.start) : null;
      if (savedStart) $("tl-start").insertBefore(new Option(`${savedStart.name || "A saved view"} (saved with the path)`, "saved"), $("tl-start").options[1] ?? null);
      $("tl-start").value = savedStart ? "saved" : "";
    }
    if (spec.kind === "path") {
      keys = spec.keys.map((k) => structuredClone(k));
      $("tl-loop").value = spec.end;
      ensureTimes();
      sel = keys.length ? 0 : -1;
    }
    if (spec.kind === "slices") {
      fillSlices();
      if (spec.axis && slicesList().some((s) => s.axis === spec.axis)) $("tl-slice").value = spec.axis;
      $("tl-from").value = spec.from_index;
      $("tl-to").value = spec.to_index;
      $("tl-pingpong").value = spec.end === "pingpong" ? "1" : "0";
      root.dataset.rangeFor = spec.axis || "";
    }
    setPlayhead(0);
    changed();
  }

  function fillSlices() {
    const keep = $("tl-slice").value;
    const list = slicesList();
    $("tl-slice").innerHTML = list.length ? list.map((s) => `<option value="${s.axis}">${esc(s.label)}</option>`).join("") : `<option value="">No slice view is open</option>`;
    if (list.some((s) => s.axis === keep)) $("tl-slice").value = keep;
    const s = sliceInfo();
    if (s) {
      for (const id of ["tl-from", "tl-to"]) $(id).max = s.count - 1;
      if (!root.dataset.rangeSet || root.dataset.rangeFor !== s.axis) {
        $("tl-from").value = 0;
        $("tl-to").value = s.count - 1;
        root.dataset.rangeSet = "1";
        root.dataset.rangeFor = s.axis;
      }
    }
  }

  // --------------------------------------------------------------------------------- bookmarks
  let bookmarkList = [];
  const bmKey = (e) => `${e.scope}:${e.id}`;
  async function refreshBookmarks() {
    bookmarkList = bookmarks ? (await bookmarks.list()).filter((e) => e.spec.pose) : [];
    const label = (e) => `${esc(e.name)}${e.scope === "local" ? " (this browser)" : ""}`;
    $("tl-bm").innerHTML = bookmarkList.length ? bookmarkList.map((e) => `<option value="${bmKey(e)}">${label(e)}</option>`).join("") : `<option value="">No bookmarks</option>`;
    $("tl-addbm").disabled = !bookmarkList.length;
    const keep = $("tl-start").value;
    const saved = $("tl-start").querySelector('option[value="saved"]');
    $("tl-start").innerHTML = `<option value="">The current view</option>` + (saved ? saved.outerHTML : "") + bookmarkList.map((e) => `<option value="${bmKey(e)}">${label(e)}</option>`).join("");
    if ([...$("tl-start").options].some((o) => o.value === keep)) $("tl-start").value = keep;
  }

  // ------------------------------------------------------------------------------ the right column
  function sizeOfRun() {
    if (!threeDVisible() && kind() !== "slices") return null;
    if (kind() === "slices") {
      const s = sliceInfo();
      const r = s ? getSlices().exportRegion(s.axis, $("tl-area").value) : null;
      return r ? { width: r.width, height: r.height } : null;
    }
    const v = $("tl-size").value;
    if (v === "current") return { width: getCanvas().width, height: getCanvas().height };
    const [w, h] = v.split("x").map(Number);
    return { width: w, height: h };
  }

  function refresh() {
    const k = kind();
    root.querySelectorAll("[data-for]").forEach((el) => { el.hidden = !el.dataset.for.split(" ").includes(k); });
    if (!bookmarks) $("tl-start-wrap").hidden = true;
    $("tl-q-wrap").hidden = $("tl-out").value !== "mp4";
    $("tl-fmt-wrap").hidden = $("tl-out").value !== "zip";
    const p = plan();
    const size = sizeOfRun();
    $("tl-go").disabled = !!p.error || running;
    $("tl-play").disabled = !!buildSpec().error && !(player && player.state !== "idle");
    $("tl-info").textContent = p.error ? p.error
      : `${p.count} frames, ${(p.count / p.fps).toFixed(p.count / p.fps < 10 ? 1 : 0)} s at ${p.fps} per second${size ? `, ${size.width} \u00d7 ${size.height} px` : ""}.${k === "slices" ? "" : " Each frame waits until its data is loaded and the image is clean, so this takes a while."}`;
    $("tl-copylink").disabled = !!buildSpec().error;
  }

  async function start() {
    const p = plan();
    if (p.error || running) return;
    await backToMyView();
    const built = buildSpec();
    if (built.error) return;
    running = true;
    refresh();
    setStatus("");
    const size = sizeOfRun();
    try {
      const result = await render({
        kind: p.kind, plan: p, spec: built.spec, size, sizeKey: $("tl-size").value, out: $("tl-out").value,
        quality: $("tl-quality").value, format: $("tl-fmt").value, area: $("tl-area").value,
        baseName, description, getViewer, getSlices, getCanvas, pane, access, onStart: () => player?.stop(),
      });
      setStatus(result.text, !!result.error);
    } finally {
      running = false;
      refresh();
    }
  }

  async function playSpec(spec, startAt = 0) {
    if (!player) return;
    await backToMyView();
    setStatus(spec.preload && spec.kind !== "slices" ? "Loading the data first\u2026" : "");
    try {
      await player.play(spec, { startAt });
      setStatus(player.state === "idle" ? "" : "Playing. Drag along the timeline to jump; the bar over the view pauses or stops it.");
    } catch (err) {
      console.error("[play]", err);
      setStatus(err.message || String(err), true);
    }
  }

  async function copy(url, message) {
    try { await navigator.clipboard.writeText(url); setStatus(message); } catch (_) { window.prompt("Copy this link", url); }
  }

  // ------------------------------------------------------------------------------------ saved
  let saved = [];
  const skey = (e) => `${e.scope}:${e.id}`;
  const selected = () => saved.find((e) => skey(e) === $("tl-saved").value);
  async function refreshSaved(select) {
    saved = store ? await store.list() : [];
    const opt = (e) => `<option value="${skey(e)}">${esc(e.name)}${e.scope === "shared" && e.author ? ` (${esc(e.author)})` : ""}</option>`;
    const group = (label, scope) => { const list = saved.filter((e) => e.scope === scope); return list.length ? `<optgroup label="${label}">${list.map(opt).join("")}</optgroup>` : ""; };
    $("tl-saved").innerHTML = saved.length ? group("For everyone", "shared") + group("In this browser", "local") : `<option value="">No saved paths yet</option>`;
    if (select && saved.some((e) => skey(e) === select)) $("tl-saved").value = select;
    updateSavedButtons();
  }
  function updateSavedButtons() {
    const e = selected();
    for (const id of ["tl-load", "tl-playsaved", "tl-delete"]) $(id).disabled = !e;
    $("tl-link").disabled = !e || e.scope !== "shared";
    $("tl-delete").disabled = !e || (e.scope === "shared" && !store?.canShare);
    $("tl-playsaved").hidden = !player;
  }

  // ---------------------------------------------------------------------------------- the events
  root.addEventListener("change", () => { invalidate(); refresh(); if (kind() === "path") renderLanes(); });
  root.addEventListener("input", (e) => { if (e.target.type === "number") { invalidate(); refresh(); } });
  $("tl-duration").addEventListener("input", () => { renderLanes(); renderInspector(); setPlayhead(playheadU); });
  $("tl-kind").addEventListener("change", () => {
    backToMyView();
    if (kind() === "slices") fillSlices();
    setPlayhead(0);
    renderLanes();
    renderInspector();
    refresh();
  });
  $("tl-slice").addEventListener("pointerdown", fillSlices);
  for (const id of ["tl-bm", "tl-start"]) $(id).addEventListener("pointerdown", () => { refreshBookmarks(); });
  $("tl-bm-wrap").style.display = bookmarks ? "inline-flex" : "none";
  $("tl-start-wrap").hidden = !bookmarks;

  $("tl-addkey").addEventListener("click", () => {
    try {
      const v = getViewer();
      const pose = readPose(v.camera, $("tl-inc-clip").checked ? v.renderer : null, $("tl-inc-tf").checked ? v : null);
      acceptView();
      addKey(pose);
    } catch (err) { setStatus(err.message || String(err), true); }
  });
  $("tl-addbm").addEventListener("click", () => {
    const e = bookmarkList.find((b) => bmKey(b) === $("tl-bm").value);
    if (!e) return;
    const key = poseOfBookmark(e);
    if (!$("tl-inc-clip").checked) { delete key.clipMin; delete key.clipMax; }
    if (!$("tl-inc-tf").checked) delete key.tf;
    addKey(key);
  });
  $("tl-clearkeys").addEventListener("click", () => { keys = []; sel = -1; changed(); });
  $("tl-go").addEventListener("click", start);
  $("tl-back").addEventListener("click", backToMyView);
  $("tl-close").addEventListener("click", () => api.hide());
  $("tl-copylink").addEventListener("click", async () => {
    const built = buildSpec();
    if (built.error) { setStatus(built.error, true); return; }
    try {
      const text = await encodeSpec(built.spec);
      const url = new URL(pageUrl());
      url.searchParams.delete("play");
      url.searchParams.set(ANIM_PARAM, text);
      if (url.href.length > ANIM_MAX_CHARS) { setStatus(`This animation is too long for a link (${url.href.length} characters). Save it for everyone and copy that link instead.`, true); return; }
      await copy(url.href, "Link copied. Opening it plays this animation.");
    } catch (err) { setStatus(err.message || String(err), true); }
  });

  // transport
  $("tl-play").addEventListener("click", () => {
    if (player?.state === "preloading") { player.stop(); return; }
    if (player?.state === "playing") { player.pause(); return; }
    if (player?.state === "paused") { player.resume(); return; }
    const built = buildSpec();
    if (built.error) { setStatus(built.error, true); return; }
    playSpec(built.spec, playheadU >= 0.999 ? 0 : playheadU);
  });
  $("tl-stop").addEventListener("click", () => { player?.stop(); setPlayhead(0); });
  if (!player) { $("tl-play").hidden = true; $("tl-stop").hidden = true; }
  const syncPlay = (state) => {
    $("tl-play").textContent = state === "playing" ? "\u23f8" : "\u25b6";
    $("tl-play").title = state === "playing" ? "Pause" : state === "paused" ? "Continue" : "Play from the playhead";
    if (state === "idle") setStatus("");
    refresh();
  };
  player?.onChange(syncPlay);
  player?.onProgress(({ u }) => setPlayhead(u));

  // the time axis: scrub, select, retime
  const tracks = $("tl-tracks");
  const uOf = (e) => {
    const r = tracks.querySelector(".tl-over > div").getBoundingClientRect();
    return r.width > 0 ? clamp((e.clientX - r.left) / r.width, 0, 1) : 0;
  };
  let drag = null; // { type: "scrub" } | { type: "key", i, moved }
  tracks.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const keyEl = e.target.closest?.(".tl-key");
    tracks.setPointerCapture?.(e.pointerId);
    if (keyEl) {
      const i = Number(keyEl.dataset.i);
      sel = i;
      drag = { type: "key", i, moved: false, x: e.clientX };
      renderLanes();
      renderInspector();
    } else {
      drag = { type: "scrub" };
      seek(uOf(e));
    }
    e.preventDefault();
  });
  tracks.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.type === "scrub") { seek(uOf(e)); return; }
    if (!drag.moved && Math.abs(e.clientX - drag.x) < 3) return;
    drag.moved = true;
    const at = uOf(e);
    const i = drag.i;
    const lo = i > 0 ? keys[i - 1].at + MIN_GAP : 0;
    const hi = i < keys.length - 1 ? keys[i + 1].at - MIN_GAP : 1;
    keys[i].at = Math.round(clamp(at, lo, Math.max(lo, hi)) * 1000) / 1000;
    invalidate();
    for (const el of tracks.querySelectorAll(`.tl-key[data-i="${i}"]`)) el.style.left = `${keys[i].at * 100}%`;
    const t = root.querySelector("#tl-k-time");
    if (t) t.value = (keys[i].at * duration()).toFixed(2);
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.type === "key") {
      if (d.moved) { renderLanes(); refresh(); } // segments between the keys follow
      else if (keys[d.i]) seek(keys[d.i].at); // a click: show that view
    }
  };
  tracks.addEventListener("pointerup", endDrag);
  tracks.addEventListener("pointercancel", () => { drag = null; });
  root.addEventListener("keydown", (e) => {
    if (kind() !== "path" || !keys[sel] || e.target.closest("input, select, textarea")) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeKey(sel); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      moveKey(sel, keys[sel].at + (e.shiftKey ? 0.05 : 0.01) * (e.key === "ArrowLeft" ? -1 : 1));
    }
  });

  // saved paths
  if (store) {
    $("tl-save-shared").hidden = !store.canShare;
    $("tl-save-hint").textContent = store.canShare
      ? "A path saved in this browser is private to you. A path saved for everyone is kept on the server: everybody who can see this volume can play it, and it has a link that starts it by itself."
      : "A path saved here stays in this browser. Editors can also save paths for everybody.";
    $("tl-saved").addEventListener("change", updateSavedButtons);
    $("tl-load").addEventListener("click", () => { const e = selected(); if (!e) return; applySpec(e.spec); $("tl-name").value = e.name; setStatus(`Loaded \u201c${e.name}\u201d.`); });
    $("tl-playsaved").addEventListener("click", () => { const e = selected(); if (e) { applySpec(e.spec); playSpec(e.spec); } });
    $("tl-link").addEventListener("click", () => { const e = selected(); const url = e && store.link(e); if (url) copy(url, "Link copied. Opening it plays this path."); });
    $("tl-delete").addEventListener("click", async () => {
      const e = selected();
      if (!e || !confirm(`Delete the saved path \u201c${e.name}\u201d${e.scope === "shared" ? " for everybody" : ""}?`)) return;
      try { await store.remove(e); await refreshSaved(); setStatus("Deleted."); } catch (err) { setStatus(err.message, true); }
    });
    for (const scope of ["local", "shared"]) {
      $(`tl-save-${scope}`).addEventListener("click", async () => {
        const built = buildSpec();
        if (built.error) { setStatus(built.error, true); return; }
        try {
          const entry = await store.save(scope, $("tl-name").value, built.spec);
          await refreshSaved(skey(entry));
          setStatus(`Saved \u201c${entry.name}\u201d ${scope === "shared" ? "for everyone" : "in this browser"}.`);
        } catch (err) { setStatus(err.message || String(err), true); }
      });
    }
  } else $("tl-saved-box").hidden = true;

  // ------------------------------------------------------------------------------- show / hide
  const api = {
    el: root,
    get visible() { return !root.hidden; },
    show() {
      if (!root.hidden) return;
      root.hidden = false;
      fillSlices();
      refreshSaved();
      refreshBookmarks();
      // start on what is on screen: a slice sweep when only slices are shown
      if (!keys.length && !threeDVisible() && slicesList().length) $("tl-kind").value = "slices";
      else if (!keys.length && threeDVisible() && !slicesList().length && kind() === "slices") $("tl-kind").value = "turntable";
      renderLanes();
      renderInspector();
      setPlayhead(playheadU);
      refresh();
      onToggle(true);
    },
    hide() {
      if (root.hidden) return;
      backToMyView();
      root.hidden = true;
      onToggle(false);
    },
    toggle() { if (root.hidden) api.show(); else api.hide(); },
    /** Loads a spec into the panel (and plays it if `play`). */
    load(spec, { play = false } = {}) { applySpec(spec); if (play) playSpec(spec); },
    seek,
    get keys() { return keys; },
    get playhead() { return playheadU; },
    destroy() { root.remove(); },
  };
  return api;
}
