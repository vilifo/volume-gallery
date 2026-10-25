// The "Slice views" section of the viewer's control panel. It is inserted before the Info
// section and reuses the panel's own CSS classes. The panel is recreated on every viewer
// reload, so this section keeps no state of its own: everything lives in SliceState.

import { textureFormatFor } from "./geometry.js";
import { TF_LABELS, TF_PRESET_NAMES, hexToRgb, insertStop } from "./transfer-function.js";

const toggle = (role, label, checked, title = "") => `
  <label class="ctl-toggle-row" ${title ? `title="${title}"` : ""}>
    <span class="ctl-row-label ctl-toggle-label">${label}</span>
    <input type="checkbox" class="ctl-toggle-input" data-role="${role}" ${checked ? "checked" : ""}>
    <span class="ctl-toggle-track"></span>
  </label>`;

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
        Pick XY, XZ, YZ or Quad above to open the slice views.</div>
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
 * @returns {() => void} unmount
 */
export function mountSliceControls(panelBody, views) {
  const st = views.state;
  const [lo, hi] = textureFormatFor(st.dtype)?.range ?? [0, 1];
  const span = hi - lo;
  const wStep = span > 1000 ? 1 : span / 1000;

  const section = newSection(panelBody);
  section.innerHTML = `
    <button type="button" class="ctl-collapsible-header"><span class="ctl-eyebrow">Slice views</span></button>
    <div class="ctl-collapsible-body">
      ${numberRow("win-center", "Window centre", +st.window.center.toPrecision(7), lo, hi, wStep, "Grey level shown as the middle of the colour scale (right-drag in a slice pane)")}
      ${numberRow("win-width", "Window width", +st.window.width.toPrecision(7), wStep, span * 2, wStep, "Range of values mapped across the colour scale")}
      <div class="ctl-select-row"><span class="ctl-row-label ctl-select-label"></span>
        <button type="button" class="ctl-chip slice-reset" data-role="win-reset" style="position:static">Reset window</button></div>

      <div class="ctl-eyebrow ctl-subhead">Transfer function</div>
      <label class="ctl-select-row" title="Colours applied to the windowed values of the slice views (independent of the 3D transfer function)">
        <span class="ctl-row-label ctl-select-label">Colour map</span>
        <select class="ctl-select-input" data-role="tf-preset">${[...TF_PRESET_NAMES, "custom"].map((n) =>
          `<option value="${n}">${TF_LABELS[n]}</option>`).join("")}</select>
      </label>
      <div class="slice-tf-bar" data-role="tf-bar" title="Click to add a colour stop, drag to move it, double-click to remove it"></div>
      <div class="slice-tf-edit">
        <input type="color" data-role="tf-color" aria-label="Colour of the selected stop">
        <input type="number" class="ctl-select-input slice-num" data-role="tf-pos" min="0" max="100" step="1" aria-label="Position of the selected stop (%)"><span>%</span>
        <button type="button" class="ctl-chip slice-reset" data-role="tf-remove" style="position:static">Remove</button>
      </div>
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
    </div>`;
  wireCollapsible(section, panelBody);

  const q = (role) => section.querySelector(`[data-role="${role}"]`);
  const num = (role, apply) => q(role).addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) apply(v);
  });
  num("win-center", (v) => st.setWindow({ center: v, width: st.window.width }));
  num("win-width", (v) => st.setWindow({ center: st.window.center, width: v }));
  q("win-reset").addEventListener("click", () => st.resetWindow());
  q("invert").addEventListener("change", (e) => st.setInvert(e.target.checked));
  q("crosshair").addEventListener("change", (e) => st.setOption("showCrosshair", e.target.checked));
  q("scalebar").addEventListener("change", (e) => st.setOption("showScaleBar", e.target.checked));
  q("cursor3d").addEventListener("change", (e) => st.setOption("show3dCursor", e.target.checked));
  q("planes3d").addEventListener("change", (e) => st.setOption("show3dPlanes", e.target.checked));
  q("linkzoom").addEventListener("change", (e) => st.setOption("linkZoom", e.target.checked));
  q("channel")?.addEventListener("change", (e) => st.setChannel(parseInt(e.target.value, 10)));
  for (const a of ["x", "y", "z"]) num(`cur-${a}`, (v) => st.setCursor({ [a]: v - 1 }, "controls"));

  // ----------------------------------------------------------- transfer function editor
  const bar = q("tf-bar");
  const colorInput = q("tf-color");
  const posInput = q("tf-pos");
  const removeBtn = q("tf-remove");
  let selected = 0;
  const handles = [];

  const lastIndex = () => st.tf.stops.length - 1;
  const isEnd = (i) => i === 0 || i === lastIndex();

  function syncEditor() {
    const stops = st.tf.stops;
    selected = Math.min(selected, stops.length - 1);
    q("tf-preset").value = st.tf.preset;
    bar.style.background = `linear-gradient(90deg, ${stops.map((s) => `${s.color} ${(s.pos * 100).toFixed(2)}%`).join(", ")})`;
    // create / remove handles only when the number of stops changed (never while one is being dragged)
    while (handles.length > stops.length) handles.pop().remove();
    while (handles.length < stops.length) {
      const h = document.createElement("button");
      h.type = "button";
      h.className = "slice-tf-stop";
      bar.appendChild(h);
      bindHandle(h);
      handles.push(h);
    }
    handles.forEach((h, i) => {
      h.dataset.index = String(i);
      h.style.left = `${stops[i].pos * 100}%`;
      h.style.background = stops[i].color;
      h.classList.toggle("selected", i === selected);
      h.classList.toggle("end", isEnd(i));
    });
    if (document.activeElement !== colorInput) colorInput.value = stops[selected].color;
    if (document.activeElement !== posInput) posInput.value = String(Math.round(stops[selected].pos * 100));
    posInput.disabled = isEnd(selected);
    removeBtn.disabled = isEnd(selected);
  }

  const barPos = (clientX) => {
    const r = bar.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };

  function setStop(i, patch) {
    const stops = st.tf.stops.map((s) => ({ ...s }));
    Object.assign(stops[i], patch);
    st.setTfStops(stops);
  }

  function removeStop(i) {
    if (isEnd(i)) return;
    st.setTfStops(st.tf.stops.filter((_, k) => k !== i));
    selected = Math.min(selected, lastIndex());
    syncEditor();
  }

  function bindHandle(h) {
    let drag = false;
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selected = Number(h.dataset.index);
      drag = true;
      h.setPointerCapture?.(e.pointerId);
      syncEditor();
    });
    h.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const i = Number(h.dataset.index);
      if (isEnd(i)) return;
      const lo = st.tf.stops[i - 1].pos + 0.001;
      const hi = st.tf.stops[i + 1].pos - 0.001;
      setStop(i, { pos: Math.min(hi, Math.max(lo, barPos(e.clientX))) });
    });
    const end = () => { drag = false; };
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
    h.addEventListener("dblclick", (e) => { e.stopPropagation(); removeStop(Number(h.dataset.index)); });
    h.addEventListener("keydown", (e) => {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeStop(Number(h.dataset.index)); }
    });
  }

  // a click on the bar itself adds a stop there; the new stop is picked up for dragging
  bar.addEventListener("pointerdown", (e) => {
    if (e.target !== bar) return;
    const pos = barPos(e.clientX);
    const stops = insertStop(st.tf.stops, pos);
    if (!stops) return;
    st.setTfStops(stops);
    selected = st.tf.stops.reduce((best, s, i) => (Math.abs(s.pos - pos) < Math.abs(st.tf.stops[best].pos - pos) ? i : best), 0);
    syncEditor();
    const h = handles[selected];
    h?.dispatchEvent(new e.constructor(e.type, { pointerId: e.pointerId, clientX: e.clientX, bubbles: true, cancelable: true }));
  });

  q("tf-preset").addEventListener("change", (e) => {
    if (e.target.value === "custom") { syncEditor(); return; } // "Custom" only describes edited stops
    st.setTfPreset(e.target.value);
    selected = 0;
    syncEditor();
  });
  colorInput.addEventListener("input", () => {
    if (hexToRgb(colorInput.value)) setStop(selected, { color: colorInput.value });
  });
  posInput.addEventListener("change", () => {
    if (isEnd(selected)) return;
    const lo = st.tf.stops[selected - 1].pos + 0.001;
    const hi = st.tf.stops[selected + 1].pos - 0.001;
    const v = parseFloat(posInput.value) / 100;
    if (Number.isFinite(v)) setStop(selected, { pos: Math.min(hi, Math.max(lo, v)) });
    syncEditor();
  });
  removeBtn.addEventListener("click", () => removeStop(selected));
  syncEditor();

  // keep the fields in sync with drags / scrolling elsewhere (never while the user types in one)
  const refresh = () => {
    const set = (role, v) => { const el = q(role); if (el && document.activeElement !== el) el.value = v; };
    set("win-center", +st.window.center.toPrecision(7));
    set("win-width", +st.window.width.toPrecision(7));
    for (const a of ["x", "y", "z"]) set(`cur-${a}`, st.cursor[a] + 1);
    q("invert").checked = st.invert;
    q("cursor3d").checked = st.show3dCursor;
    q("planes3d").checked = st.show3dPlanes;
    q("scalebar").checked = st.showScaleBar !== false;
  };
  const offs = [st.on("window", refresh), st.on("cursor", refresh), st.on("option", refresh), st.on("tf", syncEditor)];
  return () => { offs.forEach((off) => off()); section.remove(); };
}
