// The "Measure" section of the viewer's control panel (the ruler switch, where 3D clicks land, the list of
// measurements) and the CSS the measuring tools share. The measurements live in SliceState; this only shows them.

import { deltas, distance, formatLength, measureLabel, measuresCsv, voxelDistance, MAX_MEASURES } from "./measure.js?v=mpr1";

const STYLE = `
.slice-pane[data-measuring="1"] { cursor: crosshair; }
.slice-pane [data-act="measure"][aria-pressed="true"], .slice-tools [data-tool="measure"][aria-pressed="true"] { background: var(--accent, #47e0c6); color: #000; }
.measure-hint { opacity: .75; font-size: .8em; line-height: 1.5; padding: 2px 0 6px; }
.measure-status { opacity: .75; font-size: .8em; padding: 0 0 4px; min-height: 1.2em; }
.measure-list { display: flex; flex-direction: column; gap: 2px; margin: 4px 0; }
.measure-row { display: flex; align-items: stretch; gap: 2px; border: 1px solid var(--line, #333); border-radius: var(--radius, 4px); }
.measure-row.sel { border-color: #ffd84a; }
.measure-row button { background: none; border: 0; color: inherit; cursor: pointer; padding: 4px 6px; font: inherit; }
.measure-row button:hover { background: var(--panel-raised, #222); }
.measure-row .measure-main { flex: 1; text-align: left; min-width: 0; display: flex; flex-direction: column; }
.measure-d { font-family: var(--mono, ui-monospace, monospace); font-size: 1.05em; }
.measure-sub { opacity: .65; font-size: .78em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.measure-empty { opacity: .6; font-size: .85em; padding: 4px 2px; }
`;

export function ensureMeasureStyles() {
  if (typeof document === "undefined" || document.getElementById("measure-style")) return;
  const st = document.createElement("style");
  st.id = "measure-style";
  st.textContent = STYLE;
  document.head.append(st);
}

const esc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function newSection(panelBody) {
  panelBody.querySelector('[data-role="measure-section"]')?.remove();
  const section = document.createElement("div");
  section.className = "ctl-collapsible open";
  section.dataset.role = "measure-section";
  const info = panelBody.querySelector('[data-key="infoOpen"]'); // before Info, after the slice views
  if (info) panelBody.insertBefore(section, info);
  else panelBody.appendChild(section);
  const header = () => {
    section.querySelector(".ctl-collapsible-header").addEventListener("click", () => section.classList.toggle("open"));
    const arrow = panelBody.querySelector(".ctl-collapsible-header svg");
    if (arrow) section.querySelector(".ctl-collapsible-header").prepend(arrow.cloneNode(true));
  };
  return { section, header };
}

const toggleRow = (role, label, checked, title) => `
  <label class="ctl-toggle-row" title="${esc(title)}">
    <span class="ctl-row-label ctl-toggle-label">${label}</span>
    <input type="checkbox" class="ctl-toggle-input" data-role="${role}" ${checked ? "checked" : ""}>
    <span class="ctl-toggle-track"></span>
  </label>`;

const HINT = "Click two points to measure between them. In a slice pane click (or press, drag and release); in the 3D view click \u2014 dragging still rotates. Drag an end to move it, Esc cancels, Delete removes the selected one, M turns the ruler on and off.";

/**
 * @param {HTMLElement} panelBody the panel's scrolling body
 * @param {{views: import("./slice-views.js").SliceViews|null, onEnable: () => void}} o
 *   views: null until the slice views exist (the ruler needs them: they hold the measurements); then turning the
 *   ruler on calls onEnable, which creates them and turns it on
 * @returns {() => void} unmount
 */
export function mountMeasureControls(panelBody, { views, onEnable }) {
  ensureMeasureStyles();
  const { section, header } = newSection(panelBody);
  const st = views?.state ?? null;
  section.innerHTML = `
    <button type="button" class="ctl-collapsible-header"><span class="ctl-eyebrow">Measure</span></button>
    <div class="ctl-collapsible-body">
      ${toggleRow("measure-on", "Ruler", !!st?.measuring, "Measure distances in the slice panes and the 3D view (M)")}
      <div class="measure-hint">${HINT}</div>
      <label class="ctl-select-row" title="Where a click in the 3D view lands: on the surface of what is shown (approximate, accuracy shown) or on the three slice planes (exact)">
        <span class="ctl-row-label ctl-select-label">3D points</span>
        <select class="ctl-select-input" data-role="pick3d">
          <option value="surface">On the volume (approximate)</option>
          <option value="planes">On the slice planes (exact)</option>
        </select>
      </label>
      <div class="measure-status" data-role="measure-status"></div>
      <div class="measure-list" data-role="measure-list"></div>
      <div class="ctl-select-row"><span class="ctl-row-label ctl-select-label"></span>
        <span><button type="button" class="ctl-chip" data-role="measure-copy" style="position:static">Copy as CSV</button>
        <button type="button" class="ctl-chip" data-role="measure-clear" style="position:static">Clear all</button></span></div>
    </div>`;
  header();
  const $ = (role) => section.querySelector(`[data-role="${role}"]`);

  $("measure-on").addEventListener("change", (e) => {
    if (st) st.setMeasuring(e.target.checked);
    else if (e.target.checked) onEnable();
  });
  if (!st) {
    for (const role of ["pick3d", "measure-copy", "measure-clear"]) $(role).disabled = true;
    $("measure-list").innerHTML = `<div class="measure-empty">Turn the ruler on to open the measuring tools (the slice views start in the background).</div>`;
    return () => section.remove();
  }

  const unit = () => st.unit ?? "micrometer";
  function renderList() {
    const rows = st.measures.map((m) => {
      const d = deltas(m.a, m.b, st.spacing);
      const tip = `\u0394x ${formatLength(Math.abs(d.x), unit())}, \u0394y ${formatLength(Math.abs(d.y), unit())}, \u0394z ${formatLength(Math.abs(d.z), unit())}`;
      const acc = m.acc ? ` \u00b7 \u00b1${+m.acc.toPrecision(2)} voxels` : "";
      return `<div class="measure-row ${m.id === st.measureSel ? "sel" : ""}" data-id="${m.id}">
        <button type="button" class="measure-main" data-act="select" title="${esc(tip)}"><span class="measure-d">${esc(measureLabel(m, st.spacing, unit()))}</span><span class="measure-sub">${esc(m.label)} \u00b7 ${+voxelDistance(m.a, m.b).toPrecision(4)} voxels${acc}</span></button>
        <button type="button" data-act="goto" title="Move the slice cursor to the first point">\u2316</button>
        <button type="button" data-act="del" title="Delete this measurement">\u2715</button></div>`;
    });
    $("measure-list").innerHTML = rows.join("") || `<div class="measure-empty">${st.measuring ? "Click a first point." : "No measurements yet."}</div>`;
    $("measure-clear").disabled = !st.measures.length;
    $("measure-copy").disabled = !st.measures.length;
    $("measure-on").checked = st.measuring;
    $("pick3d").value = st.measure3dMode;
    const tail = st.measures.length >= MAX_MEASURES ? ` Limit of ${MAX_MEASURES} reached.` : "";
    const units = `Distances in ${unit() === "micrometer" && !st.unit ? "micrometres (the voxel spacing is taken to be in micrometres)" : unit()}.`;
    $("measure-status").textContent = `${views.measure3d?.status ? views.measure3d.status + ". " : ""}${units}${tail}`;
  }
  renderList();

  $("measure-list").addEventListener("click", (e) => {
    const row = e.target.closest(".measure-row");
    const btn = e.target.closest("button");
    if (!row || !btn) return;
    const id = Number(row.dataset.id);
    const m = st.measures.find((q) => q.id === id);
    if (!m) return;
    if (btn.dataset.act === "del") st.removeMeasure(id);
    else if (btn.dataset.act === "goto") { st.setCursor({ x: Math.floor(m.a.x), y: Math.floor(m.a.y), z: Math.floor(m.a.z) }, "measure"); st.selectMeasure(id); }
    else st.selectMeasure(id);
  });
  $("pick3d").addEventListener("change", (e) => st.setMeasure3dMode(e.target.value));
  $("measure-clear").addEventListener("click", () => st.clearMeasures());
  $("measure-copy").addEventListener("click", async (e) => {
    const csv = measuresCsv(st.measures, st.spacing, unit());
    const btn = e.target;
    try { await navigator.clipboard.writeText(csv); btn.textContent = "Copied!"; } catch (_) { window.prompt("Copy the measurements", csv); btn.textContent = "Copy as CSV"; }
    setTimeout(() => { btn.textContent = "Copy as CSV"; }, 1500);
  });

  const offs = [st.on("measure", renderList), st.on("measuring", renderList), st.on("measure3d", renderList), st.on("measure3d-status", renderList)];
  return () => { offs.forEach((off) => off()); section.remove(); };
}
