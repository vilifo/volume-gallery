// The page script of shares.html (it was an inline <script type="module"> there). Bundled by webpack.config.js.
import { api, requireLogin, getRole, getUsername, renderShell, wireLogout, escapeHtml } from "../js/api.js";

requireLogin();
const role = getRole();
if (role !== "admin") window.location.href = "/index.html";

document.getElementById("shell").innerHTML = `
  ${renderShell("shares", role, getUsername())}
  <main>
    <div class="toolbar">
      <h1>Shares</h1>
      <button type="button" id="refresh-btn" title="Load the numbers again (disk usage is measured afresh)">Refresh</button>
    </div>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" id="tab-links" aria-selected="true">Share links</button>
      <button type="button" role="tab" id="tab-storage" aria-selected="false">Storage</button>
    </div>
    <div id="error" style="display:none" class="error-box"></div>
    <section id="links-panel">
      <div class="stats" id="link-stats"></div>
      <div class="filters">
        <input type="search" id="q" placeholder="Search code, asset, creator…" aria-label="Search" />
        <select id="f-state" aria-label="State">
          <option value="">All states</option><option value="active">Active</option>
          <option value="expired">Expired</option><option value="revoked">Revoked</option>
        </select>
        <select id="f-type" aria-label="Asset type">
          <option value="">All assets</option><option value="volume">Volumes</option>
          <option value="mesh">Meshes</option><option value="pointcloud">Point clouds</option>
        </select>
        <select id="f-sort" aria-label="Sort">
          <option value="newest">Newest first</option><option value="views">Most views</option>
          <option value="last">Last viewed</option><option value="expiry">Expiring soonest</option>
          <option value="size">Largest asset</option>
        </select>
      </div>
      <table class="responsive">
        <thead><tr><th>Link</th><th>Asset</th><th>Access</th><th>Views</th><th>Created</th><th></th></tr></thead>
        <tbody id="links-body"><tr><td colspan="6" class="dim">Loading…</td></tr></tbody>
      </table>
      <p class="sub" id="links-foot"></p>
    </section>
    <section id="storage-panel" style="display:none"><p class="dim">Measuring the data folders…</p></section>
  </main>
`;
wireLogout();

// ---------------------------------------------------------------- formatting
const esc = escapeHtml;
function bytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
function left(sec) {
  if (sec == null) return "";
  if (sec < 90) return "under a minute";
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} d`;
}
const when = (iso) => new Date(iso).toLocaleString();
const TYPE_LABEL = { volume: "Volume", mesh: "Mesh", pointcloud: "Point cloud" };
const manageHref = (type, id) => `/manage.html?kind=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;

function spark(daily) {
  const max = Math.max(1, ...daily);
  const w = 4, gap = 1, h = 18;
  const bars = daily.map((n, i) => {
    const bh = n ? Math.max(2, Math.round((n / max) * h)) : 1;
    return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" opacity="${n ? 1 : 0.3}"><title>${n} view${n === 1 ? "" : "s"}</title></rect>`;
  }).join("");
  return `<svg class="spark" width="${daily.length * (w + gap)}" height="${h}" role="img" aria-label="Views per day, last ${daily.length} days">${bars}</svg>`;
}

function showError(err) {
  const box = document.getElementById("error");
  box.textContent = err ? (err.message || String(err)) : "";
  box.style.display = err ? "block" : "none";
}

// ---------------------------------------------------------------- share links
let overview = null;

function renderStats() {
  const s = overview.summary;
  document.getElementById("link-stats").innerHTML = `
    <div class="stat"><div class="l">Links</div><div class="n">${s.total}</div>
      <div class="d"><span class="okc">${s.active} active</span> · ${s.expired} expired · ${s.revoked} revoked${s.never_expire ? ` · ${s.never_expire} never expire` : ""}</div></div>
    <div class="stat"><div class="l">Views</div><div class="n">${s.views_total}</div>
      <div class="d">${s.views_24h} in 24 h · ${s.views_7d} in 7 d · ${s.views_30d} in 30 d</div></div>
    <div class="stat"><div class="l">Assets shared</div><div class="n">${s.assets_shared}</div>
      <div class="d">${bytes(s.bytes_shared)} on disk${s.orphaned ? ` · <span class="warn">${s.orphaned} link${s.orphaned === 1 ? "" : "s"} to deleted assets</span>` : ""}</div></div>`;
}

function matches(x, q) {
  if (!q) return true;
  const hay = [x.code, x.asset.title, x.asset.slug, x.created_by_name, x.asset.created_by_name, x.view_query, ...x.related.map((r) => r.title)]
    .filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}
const SORTS = {
  newest: (a, b) => b.created_at.localeCompare(a.created_at),
  views: (a, b) => b.stats.views_total - a.stats.views_total,
  last: (a, b) => (b.stats.last_viewed_at || "").localeCompare(a.stats.last_viewed_at || ""),
  expiry: (a, b) => (a.state === "active" ? (a.seconds_left ?? Infinity) : Infinity + 1) - (b.state === "active" ? (b.seconds_left ?? Infinity) : Infinity + 1) || 0,
  size: (a, b) => (b.asset.bytes ?? -1) - (a.asset.bytes ?? -1),
};

function assetCell(x) {
  const a = x.asset;
  if (!a.exists) return `<span class="pill">${esc(TYPE_LABEL[a.type] || a.type)}</span> <span class="warn">asset deleted</span><div class="sub mono">id ${a.id}</div>`;
  const related = x.related.map((r) =>
    `<div>+ ${esc(TYPE_LABEL[r.type] || r.type)} <a href="${manageHref(r.type, r.id)}">${esc(r.title)}</a> · ${bytes(r.bytes)}</div>`).join("");
  const extras = [];
  if (x.paths_count) extras.push(`${x.paths_count} saved path${x.paths_count === 1 ? "" : "s"}`);
  if (x.bookmarks_count) extras.push(`${x.bookmarks_count} bookmark${x.bookmarks_count === 1 ? "" : "s"}`);
  if (x.sibling_links) extras.push(`${x.sibling_links} other link${x.sibling_links === 1 ? "" : "s"} to it`);
  return `<span class="pill">${esc(TYPE_LABEL[a.type] || a.type)}</span>
    <a href="${manageHref(a.type, a.id)}">${esc(a.title)}</a>
    <div class="sub"><span class="mono">${esc(a.slug)}</span> · ${esc(a.status)}${a.status !== "ready" ? " ⚠" : ""} · ${bytes(a.bytes)} on disk${a.created_by_name ? ` · by ${esc(a.created_by_name)}` : ""}</div>
    ${related ? `<div class="related">${related}</div>` : ""}
    ${extras.length ? `<div class="related">${esc(extras.join(" · "))}</div>` : ""}`;
}

function accessCell(x) {
  const color = x.state === "active" ? "var(--ok)" : x.state === "revoked" ? "var(--danger)" : "var(--text-dim)";
  const expiry = x.never_expires ? "never expires"
    : x.state === "active" ? `<span title="${esc(when(x.expires_at))}">ends in ${left(x.seconds_left)}</span>`
    : `<span title="${esc(when(x.expires_at))}">${x.state === "expired" ? "ended " + ago(x.expires_at) : esc(when(x.expires_at))}</span>`;
  const flags = [];
  if (x.can_download) flags.push("download allowed");
  if (x.min_lod != null) flags.push(`lower resolution only (LOD ${x.min_lod}+)`);
  return `<span class="pill" style="color:${color};border-color:${color}">${esc(x.state)}</span>
    <div class="sub">${expiry}</div>
    ${flags.length ? `<div class="sub">${esc(flags.join(" · "))}</div>` : ""}
    ${x.view_query ? `<div class="sub">opens with <span class="mono clip" title="${esc(x.view_query)}">${esc(x.view_query)}</span></div>` : ""}`;
}

function viewsCell(x) {
  const st = x.stats;
  return `<strong class="mono">${st.views_total}</strong>
    <div class="sub">${st.views_24h} · ${st.views_7d} · ${st.views_30d} <span title="views in the last 24 hours · 7 days · 30 days">(24 h · 7 d · 30 d)</span></div>
    ${spark(st.daily)}
    <div class="sub">last viewed ${esc(ago(st.last_viewed_at))}</div>`;
}

function renderLinks() {
  const q = document.getElementById("q").value.trim();
  const fs = document.getElementById("f-state").value;
  const ft = document.getElementById("f-type").value;
  const sort = SORTS[document.getElementById("f-sort").value] || SORTS.newest;
  const rows = overview.shares
    .filter((x) => (!fs || x.state === fs) && (!ft || x.asset.type === ft) && matches(x, q))
    .sort(sort);
  document.getElementById("links-body").innerHTML = rows.map((x) => `
    <tr>
      <td><a class="mono" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.code)}</a></td>
      <td>${assetCell(x)}</td>
      <td>${accessCell(x)}</td>
      <td>${viewsCell(x)}</td>
      <td><span title="${esc(when(x.created_at))}">${esc(ago(x.created_at))}</span><div class="sub">${x.created_by_name ? "by " + esc(x.created_by_name) : "creator removed"}</div></td>
      <td class="row-actions">
        <button type="button" data-copy="${esc(x.url)}">Copy URL</button>
        <button type="button" class="danger" data-del="${x.id}" data-code="${esc(x.code)}">Delete</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="6" class="dim">${overview.shares.length ? "No link matches the filters." : "No share links yet."}</td></tr>`;
  document.getElementById("links-foot").textContent =
    `Showing ${rows.length} of ${overview.shares.length}. Per-day numbers come from a view log that starts when this page was introduced; the all-time count includes earlier views.`;
}

async function loadLinks() {
  overview = await api.adminShares();
  renderStats();
  renderLinks();
}

document.getElementById("links-body").addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = "Copied!"; }
    catch { copy.textContent = "Copy failed"; }
    setTimeout(() => (copy.textContent = "Copy URL"), 1500);
    return;
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    if (!confirm(`Delete the share link “${del.dataset.code}”? Anyone using it loses access. This cannot be undone.`)) return;
    try { await api.deleteShare(del.dataset.del); showError(null); await loadLinks(); } catch (err) { showError(err); }
  }
});
for (const id of ["q", "f-state", "f-type", "f-sort"]) {
  document.getElementById(id).addEventListener(id === "q" ? "input" : "change", () => overview && renderLinks());
}

// ---------------------------------------------------------------- storage
let storage = null;

function diskBlock(title, d) {
  if (!d) return "";
  const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
  return `<div class="stat"><div class="l">${esc(title)}</div><div class="n">${bytes(d.free)} free</div>
    <div class="bar big" style="margin:0.4em 0"><i style="width:${pct}%"></i></div>
    <div class="d">${bytes(d.used)} of ${bytes(d.total)} used (${pct}%)</div></div>`;
}

function renderStorage() {
  const s = storage;
  const kinds = [["volume", "Volumes"], ["mesh", "Meshes"], ["pointcloud", "Point clouds"]];
  const assetsTotal = kinds.reduce((n, [k]) => n + (s.kind_bytes[k] || 0), 0);
  const biggest = Math.max(1, ...s.assets.map((a) => a.bytes));
  const leftoverTotal = s.leftovers.reduce((n, l) => n + l.bytes, 0);
  document.getElementById("storage-panel").innerHTML = `
    <div class="stats">
      ${diskBlock("Data disk", s.disk)}
      ${diskBlock("Scratch disk", s.processing_disk)}
      <div class="stat"><div class="l">Assets</div><div class="n">${bytes(assetsTotal)}</div>
        <div class="d">${kinds.map(([k, l]) => `${l.toLowerCase()} ${bytes(s.kind_bytes[k])}`).join(" · ")}</div></div>
      <div class="stat"><div class="l">Other</div><div class="n">${bytes(s.database_bytes + s.staging_bytes + s.processing_bytes + leftoverTotal)}</div>
        <div class="d">database ${bytes(s.database_bytes)} · waiting uploads ${bytes(s.staging_bytes)} · scratch ${bytes(s.processing_bytes)}${leftoverTotal ? ` · leftovers ${bytes(leftoverTotal)}` : ""}</div></div>
    </div>
    ${s.missing.length ? `<div class="error-box"><strong>Folder missing</strong> for ${s.missing.length} asset${s.missing.length === 1 ? "" : "s"} marked ready: ${s.missing.map((m) => `<a href="${manageHref(m.type, m.id)}">${esc(m.title)}</a>`).join(", ")}</div>` : ""}
    <div class="filters">
      <select id="s-type" aria-label="Asset type">
        <option value="">All assets</option><option value="volume">Volumes</option>
        <option value="mesh">Meshes</option><option value="pointcloud">Point clouds</option>
      </select>
      <span class="sub">Sizes are what the files occupy on disk. Measured ${esc(ago(s.scanned_at))}.</span>
    </div>
    <table class="responsive">
      <thead><tr><th>Asset</th><th>Type</th><th>Status</th><th class="num">Files</th><th class="num">On disk</th><th style="width:22%"></th></tr></thead>
      <tbody id="storage-body"></tbody>
    </table>
    ${s.leftovers.length ? `
      <h2 style="margin-top:1.6em">Folders no asset points at</h2>
      <p class="dim" style="font-size:0.9em">These folders sit in the data directory but belong to no volume, mesh or point cloud — usually what an interrupted delete or upload left behind. Nothing here is removed automatically.</p>
      <table class="responsive">
        <thead><tr><th>Folder</th><th>Type</th><th class="num">Files</th><th class="num">On disk</th></tr></thead>
        <tbody>${s.leftovers.map((l) => `<tr><td class="mono">${esc(l.slug)}</td><td>${esc(TYPE_LABEL[l.type] || l.type)}</td><td class="num">${l.files}</td><td class="num">${bytes(l.bytes)}</td></tr>`).join("")}</tbody>
      </table>` : ""}`;
  const body = () => {
    const t = document.getElementById("s-type").value;
    document.getElementById("storage-body").innerHTML = s.assets.filter((a) => !t || a.type === t).map((a) => `
      <tr>
        <td><a href="${manageHref(a.type, a.id)}">${esc(a.title)}</a> <span class="sub mono">${esc(a.slug)}</span></td>
        <td>${esc(TYPE_LABEL[a.type] || a.type)}</td>
        <td>${esc(a.status)}</td>
        <td class="num">${a.files}</td>
        <td class="num">${bytes(a.bytes)}</td>
        <td><div class="bar"><i style="width:${Math.max(1, Math.round((a.bytes / biggest) * 100))}%"></i></div></td>
      </tr>`).join("") || `<tr><td colspan="6" class="dim">Nothing here.</td></tr>`;
  };
  document.getElementById("s-type").addEventListener("change", body);
  body();
}

async function loadStorage(refresh = false) {
  document.getElementById("storage-panel").innerHTML = `<p class="dim">Measuring the data folders…</p>`;
  storage = await api.adminStorage(refresh);
  renderStorage();
}

// ---------------------------------------------------------------- tabs, refresh
let tab = location.hash === "#storage" ? "storage" : "links";
function setTab(next) {
  tab = next;
  history.replaceState(null, "", next === "storage" ? "#storage" : location.pathname + location.search);
  document.getElementById("tab-links").setAttribute("aria-selected", String(next === "links"));
  document.getElementById("tab-storage").setAttribute("aria-selected", String(next === "storage"));
  document.getElementById("links-panel").style.display = next === "links" ? "" : "none";
  document.getElementById("storage-panel").style.display = next === "storage" ? "" : "none";
  if (next === "storage" && !storage) loadStorage().catch(showError);
}
document.getElementById("tab-links").addEventListener("click", () => setTab("links"));
document.getElementById("tab-storage").addEventListener("click", () => setTab("storage"));
document.getElementById("refresh-btn").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    showError(null);
    await (tab === "storage" ? loadStorage(true) : loadLinks());
  } catch (err) { showError(err); }
  e.target.disabled = false;
});

loadLinks().catch(showError);
setTab(tab);
