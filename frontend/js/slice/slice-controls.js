// The "Slice views" section of the viewer's control panel. It is inserted before the Info
// section and reuses the panel's own CSS classes. The panel is recreated on every viewer
// reload, so this section keeps no state of its own: everything lives in SliceState.

import { textureFormatFor } from "./geometry.js";
import { ANGLE_LIMITS } from "./cursor.js?v=mpr2";
import { TF_LABELS, TF_PRESET_NAMES, insertStop } from "./transfer-function.js";
import { mountCurveEditor } from "./opacity-curve.js";
import { resampleHistogram } from "../histogram.js";

const toggle = (role, label, checked, title = "") => `
  <label class="ctl-toggle-row" ${title ? `title="${title}"` : ""}>
    <span class="ctl-row-label ctl-toggle-label">${label}</span>
    <input type="checkbox" class="ctl-toggle-input" data-role="${role}" ${checked ? "checked" : ""}>
    <span class="ctl-toggle-track"></span>
  </label>`;

const ANGLE_AXES = [
  ["rx", "X", "Rotation about the X axis"],
  ["ry", "Y", "Rotation about the Y axis"],
  ["rz", "Z", "Rotation about the Z axis"],
];

const angleRow = (key, label, value, title) => {
  const lim = ANGLE_LIMITS[key];
  return `
  <div class="ctl-slider-row" title="${title}">
    <span class="ctl-row-label ctl-slider-label">Angle ${label}</span>
    <div class="ctl-slider-track">
      <div class="ctl-slider-fill" data-role="fill-${key}" style="width:${((value + lim) / (2 * lim)) * 100}%"></div>
      <input type="range" class="ctl-slider-input" data-role="slider-${key}" min="${-lim}" max="${lim}" step="1" value="${value}">
    </div>
    <input type="number" class="ctl-select-input slice-num slice-angle-num" data-role="angle-${key}" value="${value}" min="${-lim}" max="${lim}" step="1" aria-label="${title} (degrees)">
  </div>`;
};

// A window row like the 3D panel's Center / Width: a slider, plus a number field for typing an exact value.
const windowRow = (key, label, value, min, max, step, title) => `
  <div class="ctl-slider-row" title="${title}">
    <span class="ctl-row-label ctl-slider-label">${label}</span>
    <div class="ctl-slider-track">
      <div class="ctl-slider-fill" data-role="fill-${key}"></div>
      <input type="range" class="ctl-slider-input" data-role="slider-${key}" min="${min}" max="${max}" step="${step}" value="${value}">
    </div>
    <input type="number" class="ctl-num" data-role="${key}" value="${value}" min="${min}" max="${max}" step="${step}" aria-label="${title}">
  </div>`;

const numberRow = (role, label, value, min, max, step, title = "") => `
  <label class="ctl-select-row" ${title ? `title="${title}"` : ""}>
    <span class="ctl-row-label ctl-select-label">${label}</span>
    <input type="number" class="ctl-select-input slice-num" data-role="${role}" value="${value}" min="${min}" max="${max}" step="${step}">
  </label>`;

function newSection(panelBody) {
  panelBody.querySelector('[data-role="slice-section"]')?.remove();
  const section = document.createElement("div");
  section.className = "ctl-collapsible open";
  section.dataset.role = "slice-section";
  // before the Info section, so the order is: ... Scene, Slice views, Info, Advanced
  const info = panelBody.querySelector('[data-key="infoOpen"]');
  if (info) panelBody.insertBefore(section, info);
  else panelBody.appendChild(section);
  return section;
}

function wireCollapsible(section, panelBody) {
  const header = section.querySelector(".ctl-collapsible-header");
  header.addEventListener("click", () => section.classList.toggle("open"));
  const arrow = panelBody.querySelector(".ctl-collapsible-header svg");
  if (arrow) header.prepend(arrow.cloneNode(true));
}

/**
 * Shown before the slice views exist (they are created on demand). Its one control creates
 * them in the 3D layout, so the cursor can be shown in the 3D view without opening a slice pane.
 * @param {() => void} onEnableCursor
 * @returns {() => void} unmount
 */
export function mountSlicePlaceholder(panelBody, onEnableCursor) {
  const section = newSection(panelBody);
  section.innerHTML = `
    <button type="button" class="ctl-collapsible-header"><span class="ctl-eyebrow">Slice views</span></button>
    <div class="ctl-collapsible-body">
      <div class="ctl-row-label" style="opacity:.75;font-size:.8em;line-height:1.5;padding:2px 0 6px">
        Pick XY, XZ, YZ, Quad or Angled above to open the slice views.</div>
      ${toggle("cursor3d", "Cursor in 3D view", false, "Show the slice cursor over the 3D view (opens the slice views in the background)")}
    </div>`;
  wireCollapsible(section, panelBody);
  section.querySelector('[data-role="cursor3d"]').addEventListener("change", (e) => {
    if (e.target.checked) onEnableCursor();
  });
  return () => section.remove();
}

/**
 * @param {HTMLElement} panelBody  the panel's scrolling body (`.ctl-panel-body`)
 * @param {import("./slice-views.js").SliceViews} views
 * @param {{ getHistogram?: () => ({counts:number[], min:number, max:number}|null|undefined) }} [opts]
 *   getHistogram: the volume's intensity histogram (as the server stores it), drawn behind the opacity curve
 * @returns {() => void} unmount
 */
export function mountSliceControls(panelBody, views, { getHistogram } = {}) {
  const st = views.state;
  const [lo, hi] = textureFormatFor(st.dtype)?.range ?? [0, 1];
  const span = hi - lo;
  const wStep = span > 1000 ? 1 : span / 1000;

  const section = newSection(panelBody);
  section.innerHTML = `
    <button type="button" class="ctl-collapsible-header"><span class="ctl-eyebrow">Slice views</span></button>
    <div class="ctl-collapsible-body">
      ${windowRow("win-center", "Center", +st.window.center.toPrecision(7), lo, hi, wStep, "Grey level shown as the middle of the colour scale (right-drag in a slice pane)")}
      ${windowRow("win-width", "Width", +st.window.width.toPrecision(7), wStep, span, wStep, "Range of values mapped across the colour scale")}
      <div class="ctl-select-row" style="justify-content:flex-end">
        <button type="button" class="ctl-mini-btn" data-role="win-reset">Reset window</button></div>

      <div class="ctl-eyebrow ctl-subhead">Transfer function</div>
      <label class="ctl-select-row" title="Colours applied to the windowed values of the slice views (independent of the 3D transfer function)">
        <span class="ctl-row-label ctl-select-label">Preset</span>
        <select class="ctl-select-input" data-role="tf-preset">${[...TF_PRESET_NAMES, "custom"].map((n) =>
          `<option value="${n}">${TF_LABELS[n]}</option>`).join("")}</select>
      </label>
      <div class="ctl-tf-canvas-container">
        <div class="ctl-tf-stage">
          <canvas class="ctl-tf-canvas" data-role="tf-canvas" style="height:150px"></canvas>
          <canvas class="ctl-tf-overlay" data-role="tf-overlay"></canvas>
        </div>
        <div class="ctl-tf-colors" data-role="tf-colors"></div>
      </div>
      <div class="ctl-tf-axis" aria-hidden="true"><span data-role="axis-lo"></span><span>window</span><span data-role="axis-hi"></span></div>
      <div class="ctl-tf-help">Opacity (line) over the data histogram &#x00b7; drag points or lines &#x00b7; double-click to add or remove</div>
      ${toggle("invert", "Invert", st.invert, "Reverse the colour scale")}

      <div class="ctl-eyebrow ctl-subhead">Cursor and planes</div>
      ${toggle("crosshair", "Crosshairs in slices", st.showCrosshair, "Show where the other two panes cut through each slice pane")}
      ${toggle("scalebar", "Scale bar in slices", st.showScaleBar !== false, "Length reference in each slice pane, assuming the voxel spacing in volume.json is in micrometres")}
      ${toggle("cursor3d", "Cursor in 3D view", st.show3dCursor, "Show the cursor (three crossing lines and a dot) over the 3D view")}
      ${toggle("planes3d", "Slice planes in 3D view", st.show3dPlanes, "Outline the three slice planes over the 3D view")}
      ${toggle("linkzoom", "Link zoom", st.linkZoom, "Zooming one slice pane zooms the others to match")}
      ${st.channels > 1 ? `<label class="ctl-select-row"><span class="ctl-row-label ctl-select-label">Channel</span>
        <select class="ctl-select-input" data-role="channel">${Array.from({ length: st.channels }, (_, i) =>
          `<option value="${i}"${i === st.channel ? " selected" : ""}>${i}</option>`).join("")}</select></label>` : ""}
      ${["x", "y", "z"].map((a) => numberRow(`cur-${a}`, `Position ${a.toUpperCase()}`, st.cursor[a] + 1, 1, st.dims[a], 1, `Voxel index along ${a.toUpperCase()} (1-based)`)).join("")}

      <div class="ctl-eyebrow ctl-subhead">Plane angles</div>
      <div class="ctl-row-label" style="opacity:.75;font-size:.8em;line-height:1.5;padding:2px 0 6px">
        Drag a crosshair line in a slice pane to turn the three planes about the cursor (Shift: 15\u00b0 steps), or set the angles here: the planes turned about X, then Y, then Z.</div>
      ${ANGLE_AXES.map(([key, label, title]) => angleRow(key, label, st.euler()[key], title)).join("")}
      <div class="ctl-select-row"><span class="ctl-row-label ctl-select-label"></span>
        <button type="button" class="ctl-chip slice-reset" data-role="angled-reset" style="position:static">Reset to axis-aligned</button></div>
    </div>`;
  wireCollapsible(section, panelBody);

  const q = (role) => section.querySelector(`[data-role="${role}"]`);
  const num = (role, apply) => q(role).addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) apply(v);
  });
  // window: slider and number field edit the same value (see windowRefresh)
  const windowSlider = (key, apply) => {
    q(`slider-${key}`).addEventListener("input", (e) => apply(parseFloat(e.target.value)));
    num(key, apply);
  };
  windowSlider("win-center", (v) => st.setWindow({ center: v, width: st.window.width }));
  windowSlider("win-width", (v) => st.setWindow({ center: st.window.center, width: v }));
  const paintFill = (key) => {
    const input = q(`slider-${key}`);
    const f = (parseFloat(input.value) - parseFloat(input.min)) / (parseFloat(input.max) - parseFloat(input.min));
    q(`fill-${key}`).style.width = `calc(6px + (100% - 12px) * ${Math.min(1, Math.max(0, f)) || 0})`;
  };
  const windowRefresh = () => {
    for (const [key, v] of [["win-center", st.window.center], ["win-width", st.window.width]]) {
      const shown = +v.toPrecision(7);
      q(`slider-${key}`).value = shown;
      const field = q(key);
      if (document.activeElement !== field) field.value = shown;
      paintFill(key);
    }
  };
  windowRefresh();
  q("win-reset").addEventListener("click", () => st.resetWindow());
  q("invert").addEventListener("change", (e) => st.setInvert(e.target.checked));
  q("crosshair").addEventListener("change", (e) => st.setOption("showCrosshair", e.target.checked));
  q("scalebar").addEventListener("change", (e) => st.setOption("showScaleBar", e.target.checked));
  q("cursor3d").addEventListener("change", (e) => st.setOption("show3dCursor", e.target.checked));
  q("planes3d").addEventListener("change", (e) => st.setOption("show3dPlanes", e.target.checked));
  q("linkzoom").addEventListener("change", (e) => st.setOption("linkZoom", e.target.checked));
  q("channel")?.addEventListener("change", (e) => st.setChannel(parseInt(e.target.value, 10)));
  for (const a of ["x", "y", "z"]) num(`cur-${a}`, (v) => st.setCursor({ [a]: v - 1 }, "controls"));

  // ----------------------------------------------------------- plane angles
  for (const [key] of ANGLE_AXES) {
    q(`slider-${key}`).addEventListener("input", (e) => st.setOrientation({ [key]: parseFloat(e.target.value) }, "controls"));
    num(`angle-${key}`, (v) => st.setOrientation({ [key]: v }, "controls"));
  }
  q("angled-reset").addEventListener("click", () => st.resetOrientation("controls"));

  // ----------------------------------------------------------- transfer function editor
  // Works like the colour editor of the 3D transfer function: a preset list ending in "Custom". A built-in
  // preset shows its colours with an "Edit colours..." button; "Custom" shows a strip with one handle per
  // colour stop. Drag a handle to move it (the end stops stay at 0 and 1), click the strip to add a stop
  // coloured like the map at that spot, double-click or Delete to remove one, arrow keys nudge the selected
  // stop; the colour box and position field below edit the selected stop.
  const host = q("tf-colors");
  const MIN_GAP = 0.001;
  let selStop = 0;
  let lastCustomStops = null; // restored when "Custom" is picked again after a built-in preset
  let bar = null, drag = null, builtCustom = null;
  let lastAdd = -Infinity; // when a click last added a stop: its double-click must not delete it again
  let pressedStop = -1; // the stop the last press landed on (a double-click's own coordinates are rounded, so it is not hit-tested again)


  const isCustom = () => st.tf.preset === "custom";
  const stopsNow = () => st.tf.stops.map((s) => ({ ...s }));
  const gradient = (stops) =>
    `linear-gradient(to right, ${stops.map((s) => `${s.color} ${(s.pos * 100).toFixed(2)}%`).join(", ")})`;

  function paint() {
    const stops = st.tf.stops;
    bar.style.background = gradient(stops);
    if (!isCustom()) return;
    selStop = Math.min(selStop, stops.length - 1);
    if (bar.children.length !== stops.length) {
      bar.replaceChildren(...stops.map(() => Object.assign(document.createElement("div"), { className: "ctl-cs-stop" })));
    }
    stops.forEach((s, i) => {
      const el = bar.children[i];
      el.style.left = `${s.pos * 100}%`;
      el.style.setProperty("--c", s.color);
      el.classList.toggle("sel", i === selStop);
      el.classList.toggle("end", i === 0 || i === stops.length - 1);
    });
    const interior = selStop > 0 && selStop < stops.length - 1;
    const colorInput = host.querySelector('[data-role="cs-color"]');
    if (colorInput.value !== stops[selStop].color) colorInput.value = stops[selStop].color;
    const posInput = host.querySelector('[data-role="cs-pos"]');
    if (document.activeElement !== posInput) posInput.value = stops[selStop].pos.toFixed(3);
    posInput.disabled = !interior;
    host.querySelector('[data-role="cs-remove"]').disabled = !interior;
  }

  function build() {
    builtCustom = isCustom();
    if (!builtCustom) {
      host.innerHTML = `
        <div class="ctl-cs-bar static" data-role="cs-bar"></div>
        <div class="ctl-cs-row"><button type="button" class="ctl-mini-btn" data-role="cs-edit">Edit colours&hellip;</button></div>`;
      bar = host.querySelector('[data-role="cs-bar"]');
      host.querySelector('[data-role="cs-edit"]').addEventListener("click", () => selectPreset("custom"));
      paint();
      return;
    }
    host.innerHTML = `
      <div class="ctl-cs-bar" data-role="cs-bar" tabindex="0" title="Click to add a colour stop; drag a stop to move it; double-click or press Delete to remove it"></div>
      <div class="ctl-cs-row">
        <input type="color" data-role="cs-color" aria-label="Colour of the selected stop" title="Colour of the selected stop">
        <label class="ctl-cs-pos">Pos <input type="number" data-role="cs-pos" min="0" max="1" step="0.01" aria-label="Position of the selected stop"></label>
        <span class="ctl-cs-spacer"></span>
        <button type="button" class="ctl-mini-btn" data-role="cs-remove" title="Remove the selected stop">Remove</button>
        <button type="button" class="ctl-mini-btn" data-role="cs-reverse" title="Flip the colour map">Reverse</button>
      </div>`;
    bar = host.querySelector('[data-role="cs-bar"]');
    wireEditor();
    paint();
  }

  // Switches the colour map: a built-in preset, or "custom" (the last custom stops, else the current colours
  // as an editable starting point).
  function selectPreset(value) {
    if (value === "custom") {
      selStop = 0;
      st.setTfStops(isCustom() ? stopsNow() : lastCustomStops ?? stopsNow());
    } else {
      if (isCustom()) lastCustomStops = stopsNow();
      st.setTfPreset(value);
    }
  }

  const posFromEvent = (evt) => {
    const r = bar.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (evt.clientX - r.left) / r.width)) : 0;
  };
  function hitStop(pos) {
    const widthPx = bar.getBoundingClientRect().width;
    let best = -1, bestDist = Infinity;
    st.tf.stops.forEach((s, i) => {
      const d = Math.abs(s.pos - pos) * widthPx;
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return bestDist <= 8 ? best : -1;
  }

  function removeStop(i) {
    const stops = stopsNow();
    if (i <= 0 || i >= stops.length - 1) return;
    stops.splice(i, 1);
    selStop = Math.min(selStop, stops.length - 1);
    st.setTfStops(stops);
  }
  function moveStop(i, pos) {
    const stops = stopsNow();
    if (i <= 0 || i >= stops.length - 1) return;
    stops[i].pos = Math.min(stops[i + 1].pos - MIN_GAP, Math.max(stops[i - 1].pos + MIN_GAP, pos));
    st.setTfStops(stops);
  }

  function wireEditor() {
    bar.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      bar.focus();
      bar.setPointerCapture(evt.pointerId);
      const pos = posFromEvent(evt);
      let idx = hitStop(pos);
      if (idx < 0) {
        const stops = insertStop(st.tf.stops, pos);
        if (!stops) return;
        idx = stops.reduce((best, s, i) => (Math.abs(s.pos - pos) < Math.abs(stops[best].pos - pos) ? i : best), 0);
        selStop = idx;
        lastAdd = performance.now();
        st.setTfStops(stops);
      }
      selStop = idx;
      pressedStop = idx;
      drag = { index: idx };
      paint();
    });
    bar.addEventListener("pointermove", (evt) => { if (drag) moveStop(drag.index, posFromEvent(evt)); });
    const endDrag = () => { drag = null; };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);
    bar.addEventListener("lostpointercapture", endDrag);
    bar.addEventListener("dblclick", () => {
      // (a double-click on empty strip adds a stop with its first click; the second one must not remove it)
      if (performance.now() - lastAdd < 600) return;
      if (pressedStop > 0) removeStop(pressedStop);
    });
    bar.addEventListener("keydown", (evt) => {
      if (evt.key === "Delete" || evt.key === "Backspace") {
        evt.preventDefault();
        removeStop(selStop);
      } else if (evt.key === "ArrowLeft" || evt.key === "ArrowRight") {
        evt.preventDefault();
        const step = (evt.shiftKey ? 0.05 : 0.01) * (evt.key === "ArrowLeft" ? -1 : 1);
        moveStop(selStop, st.tf.stops[selStop].pos + step);
      }
    });
    host.querySelector('[data-role="cs-color"]').addEventListener("input", (evt) => {
      const stops = stopsNow();
      stops[selStop].color = evt.target.value;
      st.setTfStops(stops);
    });
    host.querySelector('[data-role="cs-pos"]').addEventListener("change", (evt) => {
      const v = Number(evt.target.value);
      if (Number.isFinite(v)) moveStop(selStop, v);
      paint();
    });
    host.querySelector('[data-role="cs-remove"]').addEventListener("click", () => removeStop(selStop));
    host.querySelector('[data-role="cs-reverse"]').addEventListener("click", () => {
      const stops = stopsNow().map((s) => ({ ...s, pos: 1 - s.pos })).sort((a, b) => a.pos - b.pos);
      selStop = stops.length - 1 - selStop;
      st.setTfStops(stops);
    });
  }

  // ----------------------------------------------------------- opacity curve + histogram
  // The curve is drawn over the histogram of the values inside the window, with the area below it filled with
  // the colour map; the line and its points are edited like the 3D transfer function's opacity curve.
  const fmtValue = (v) => (Math.abs(v) >= 1000 ? String(Math.round(v)) : String(+v.toPrecision(4)));
  function paintCurve(ctx, w, h) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      const x = Math.round((w * k) / 4) + 0.5, y = Math.round((h * k) / 4) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();

    const lo = st.window.center - st.window.width / 2;
    const hist = getHistogram?.();
    const n = Math.max(16, Math.min(512, Math.round(w / 2)));
    const bins = hist ? resampleHistogram(hist, lo, lo + st.window.width, n) : null;
    if (bins) { // log scale: the background peak of a typical scan would flatten everything else
      let max = 0;
      for (const c of bins) if (c > max) max = c;
      if (max > 0) {
        ctx.fillStyle = "rgba(150,160,180,0.5)";
        const bw = w / n, scale = Math.log1p(max);
        ctx.beginPath(); // one outline, so neighbouring bars leave no seams
        ctx.moveTo(0, h);
        for (let i = 0; i < n; i++) {
          const y = h - (bins[i] ? Math.max(1, (Math.log1p(bins[i]) / scale) * (h - 2)) : 0);
          ctx.lineTo(i * bw, y);
          ctx.lineTo((i + 1) * bw, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
      }
    }

    const pts = st.tf.alpha;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    for (const s of st.tf.stops) grad.addColorStop(st.invert ? 1 - s.pos : s.pos, s.color); // (the colours follow Invert, the opacity does not)
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (const p of pts) ctx.lineTo(p.x * w, (1 - p.y) * h);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x * w, (1 - p.y) * h) : ctx.moveTo(p.x * w, (1 - p.y) * h)));
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    q("axis-lo").textContent = fmtValue(lo);
    q("axis-hi").textContent = fmtValue(lo + st.window.width);
  }
  const curve = mountCurveEditor({
    canvas: q("tf-canvas"),
    overlay: q("tf-overlay"),
    getPoints: () => st.tf.alpha.map((p) => ({ ...p })),
    setPoints: (points) => st.setTfAlpha(points),
    paint: paintCurve,
  });
  let curveFrame = 0;
  const scheduleCurve = () => {
    cancelAnimationFrame(curveFrame);
    curveFrame = requestAnimationFrame(curve.redraw);
  };


  // the preset, the strip and the handles follow the state (an edit, a preset pick, a shared link, an animation)
  function syncEditor() {
    q("tf-preset").value = st.tf.preset;
    if (builtCustom !== isCustom()) build(); else paint();
  }
  q("tf-preset").addEventListener("change", (e) => selectPreset(e.target.value));
  build();
  syncEditor();

  // keep the fields in sync with drags / scrolling elsewhere (never while the user types in one)
  const refresh = () => {
    const set = (role, v) => { const el = q(role); if (el && document.activeElement !== el) el.value = v; };
    windowRefresh();
    for (const a of ["x", "y", "z"]) set(`cur-${a}`, st.cursor[a] + 1);
    q("invert").checked = st.invert;
    q("cursor3d").checked = st.show3dCursor;
    q("planes3d").checked = st.show3dPlanes;
    q("scalebar").checked = st.showScaleBar !== false;
    const e = st.euler();
    for (const [key] of ANGLE_AXES) {
      const lim = ANGLE_LIMITS[key];
      set(`angle-${key}`, e[key]);
      if (document.activeElement !== q(`slider-${key}`)) q(`slider-${key}`).value = e[key];
      q(`fill-${key}`).style.width = `${((e[key] + lim) / (2 * lim)) * 100}%`;
    }
  };
  const offs = [st.on("window", refresh), st.on("cursor", refresh), st.on("option", refresh), st.on("angled", refresh), st.on("tf", () => { syncEditor(); scheduleCurve(); }), st.on("window", scheduleCurve)];
  return () => { offs.forEach((off) => off()); cancelAnimationFrame(curveFrame); curve.destroy(); section.remove(); };
}
