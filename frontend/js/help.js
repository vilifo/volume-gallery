// The gallery's help. One source of truth, used in three places:
//   * the Help page (/help.html, "Help" in the side menu): every topic that applies to the user's role;
//   * short notes at the top of the other pages, each describing its part in a sentence or two and
//     linking to the matching topic on the Help page (pageHint);
//   * a floating, non-modal panel in the viewers (toggleHelpPanel): it shows the viewer's topic, can
//     be moved and resized, and does not block the viewer.
// The content depends on the signed-in user's role: readers get the viewing basics, editors also see
// uploading and managing, admins also see user management. Rendering-engine credits are shown to everyone.
//
// Self-contained on purpose (no imports), so the version query string of api.js does not matter here.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const ext = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;

// Add or change an engine here. `refs` are links, `papers` are plain citations.
const ENGINES = [
  {
    name: "kiln-render",
    usedFor: "CT volumes",
    text: "A WebGPU-native, out-of-core volume renderer. It streams large kiln sharded binary datasets over HTTP into a fixed-size " +
          "GPU cache, using virtual texturing and compute-shader ray marching, so volumes much larger than the GPU memory " +
          "can still be explored interactively. This gallery uses a patched build.",
    refs: [
      ["https://github.com/MPanknin/kiln-render", "kiln-render on GitHub (M. Panknin)"],
      ["https://dev.to/mpanknin/kiln-webgpu-native-out-of-core-volume-rendering-for-multi-gb-datasets-2alb", "Kiln: WebGPU-Native Out-of-Core Volume Rendering for Multi-GB Datasets"],
      ["https://github.com/MPanknin/kiln-render", "kiln-render sharded binary format"],
    ],
    papers: [],
  },
  {
    name: "3DHOP and Nexus",
    usedFor: "Meshes",
    text: "3DHOP (3D Heritage Online Presenter) is the web viewer. Uploaded meshes are converted to Nexus, a multiresolution " +
          "format that is streamed and refined on demand, so even very large meshes open quickly.",
    refs: [
      ["https://github.com/cnr-isti-vclab/3DHOP", "3DHOP on GitHub (Visual Computing Lab, CNR-ISTI)"],
      ["https://github.com/cnr-isti-vclab/nexus", "Nexus on GitHub (Visual Computing Lab, CNR-ISTI)"],
    ],
    papers: [
      "Potenziani, M., Callieri, M., Dellepiane, M., Corsini, M., Ponchio, F., Scopigno, R. (2015). 3DHOP: 3D Heritage Online Presenter. Computers & Graphics 52, 129\u2013141.",
      "Ponchio, F., Dellepiane, M. (2016). Multiresolution and fast decompression for optimal web-based rendering. Graphical Models 88.",
    ],
  },
  {
    name: "Potree and PotreeConverter",
    usedFor: "Point clouds",
    text: "Potree is the web viewer for large point clouds. Uploaded files are converted with PotreeConverter into an " +
          "octree that the viewer loads progressively, showing more detail as you zoom in.",
    refs: [
      ["https://github.com/potree/potree", "Potree on GitHub"],
      ["https://github.com/potree/PotreeConverter", "PotreeConverter on GitHub"],
    ],
    papers: [
      "Sch\u00fctz, M. (2016). Potree: Rendering Large Point Clouds in Web Browsers. Master\u2019s thesis, TU Wien.",
      "Sch\u00fctz, M., Ohrhallinger, S., Wimmer, M. (2020). Fast Out-of-Core Octree Generation for Massive Point Clouds. Computer Graphics Forum 39(7).",
    ],
  },
];


const ROLE_INTRO = {
  reader: "You are signed in as a <strong>reader</strong>. You see the items an editor or administrator has shared with you and can view them. Meshes can be downloaded only if that was allowed for you.",
  editor: "You are signed in as an <strong>editor</strong>. You see every item in the gallery, can upload new ones and manage existing ones.",
  admin: "You are signed in as an <strong>administrator</strong>. You can do everything an editor can, and you also manage the user accounts.",
};

function overview(role, branding) {
  const about = (branding.about || "")
    .split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`).join("");
  const empty = role === "reader"
    ? "If the gallery is empty, nothing has been shared with you yet: ask an editor or administrator."
    : "If the gallery is empty, use <strong>Upload</strong> in the side menu to add the first item.";
  return `${about}
    <p><span class="help-role">${esc(role)}</span></p>
    <p>${ROLE_INTRO[role] || ROLE_INTRO.reader}</p>
    <p>The gallery lists three kinds of items. Each row shows a thumbnail, or a label when there is none:</p>
    <ul>
      <li><strong>CT</strong>: a volume (a 3D scan), shown as a volume rendering and as slices.</li>
      <li><strong>MSH</strong>: a 3D mesh model.</li>
      <li><strong>PTS</strong>: a point cloud.</li>
    </ul>
    <p>Click a title or <strong>Open</strong> to view an item. ${empty}</p>
    <p>An item that is still being prepared shows a <em>processing</em> badge and cannot be opened until it is done. The list updates by itself. A <em>failed</em> item shows the reason in red${role === "reader" ? "; ask an editor to upload it again" : ""}.</p>`;
}

function volumeViewer() {
  return `<p>Open a CT item to see the volume in 3D. Drag with the left button to turn it freely, in any direction and over the poles, and scroll (or pinch) to zoom. Hold <code>Shift</code> and drag sideways to roll it about the viewing direction; drag with the right button to pan. The <strong>Volume controls</strong> panel has everything else.</p>
    <ul>
      <li><strong>Layout</strong> (3D, Quad, XY, XZ, YZ): the 3D view only, the 3D view with the three slice views, or one slice plane. XY steps through slices along Z, XZ along Y and YZ along X.</li>
      <li><strong>Render mode</strong>: <em>DVR</em> (direct volume rendering) shows the volume semi-transparent, shaped by the transfer function. <em>MIP</em> (maximum intensity projection) shows the brightest value along each line of sight. <em>ISO</em> shows a solid surface at the chosen threshold.</li>
      <li><strong>Transfer function</strong> (colour and opacity curve): click to add a point, drag a point to move it, double-click a point to remove it. The dark area behind the curve is a histogram of the volume\u2019s intensities (logarithmic height), so you can see where the data is. It is missing for volumes whose histogram has not been computed yet.</li>
      <li><strong>Scene</strong>: choose which axis points up (this also resets the view), switch <em>Free rotation</em> off to get a turntable that keeps that axis upright, show a wireframe, axes or a <em>scale bar</em>, and cut the volume open with the Clip X / Y / Z sliders.</li>
      <li><strong>Slice views</strong> (Quad, XY, XZ, YZ): click in a slice to move the cursor, scroll to step through the slices (hold Shift for steps of 10), Ctrl + scroll to zoom, drag with the middle button (or Shift or Space + drag) to pan, drag with the right button to change the grey-level window, double-click to reset the zoom. Arrow keys move the cursor, <code>i</code> inverts, <code>w</code> resets the window. The <em>Slice views</em> section of the control panel sets the window, colour map and crosshairs.</li>
      <li><strong>Scale bar</strong>: shown in the 3D view and in each slice, with its own switch for both. It assumes the voxel spacing stored with the volume is in micrometres. In 3D it is exact for what is at the centre of rotation, since parts nearer to you are drawn larger.</li>
      <li><strong>Advanced</strong>: <em>Render scale</em> trades sharpness for speed, <em>Max detail level</em> limits the resolution that is streamed (0 is full resolution), and <em>VRAM allocation</em> sets how much graphics memory may cache the volume.</li>
      <li><strong>Share</strong> copies a link to exactly this view. Whoever opens it must sign in and have access to the item.</li>
      <li><strong>View mesh</strong> appears when a mesh is attached to the volume. <strong>Fullscreen</strong> enlarges the view.</li>
    </ul>`;
}

function meshViewer(role) {
  const dl = role === "reader"
    ? "<strong>Download</strong> appears only if you were allowed to download the mesh."
    : "<strong>Download</strong> saves the original mesh file.";
  return `<p>Drag with the left button to rotate the model, drag with the right or middle button (or Ctrl + left drag) to pan, and scroll (or pinch) to zoom. <code>H</code> resets the view and <code>Esc</code> switches off the active measuring tool. The toolbar offers:</p>
    <ul>
      <li><strong>Measure</strong>: distances between points on the surface.</li>
      <li><strong>Pick point</strong>: shows the coordinates of a point you click, with a Copy button.</li>
      <li><strong>Plane sections</strong>: cut the model along the X, Y or Z axis, move the plane with the slider and flip its direction.</li>
      <li><strong>Light</strong>: while it is active, dragging moves the light instead of the camera.</li>
      <li><strong>Appearance</strong>: change the background, or paint the whole model in one colour instead of its vertex colours and textures.</li>
      <li>${dl} <strong>Fullscreen</strong> enlarges the view. A mesh attached to a volume has a <strong>Back to volume</strong> button.</li>
    </ul>`;
}

function pointcloudViewer() {
  return `<p>Drag to rotate, scroll (or pinch) to zoom. The points load progressively, so the view sharpens as you get closer or wait a moment. Use the menu button at the top left of the view to show or hide Potree\u2019s side panel (on the right) for point size, colouring and measuring tools. <strong>Fullscreen</strong> enlarges the view.</p>`;
}

function uploading() {
  return `<p>Open <strong>Upload</strong> in the side menu and choose what you are adding:</p>
    <ul>
      <li><strong>TIFF stack (.zip or multiple files)</strong>: single-slice <code>.tif</code>/<code>.tiff</code> files, one per Z position. Slice order follows the filenames naturally (for example <code>slice_0001.tif</code>, <code>slice_0002.tif</code>), so use leading zeros. The server converts the stack to kiln sharded binary with out-of-core processing, then deletes the extracted TIFF files.</li>
      <li><strong>Mesh file</strong>: <code>.stl</code>, <code>.3mf</code>, <code>.ply</code>, <code>.obj</code> or <code>.glb</code>. Added to a volume upload, a mesh becomes the volume\u2019s attached mesh.</li>
      <li><strong>Point cloud file</strong>: <code>.laz</code>, <code>.las</code>, <code>.ply</code>, <code>.xyz</code>, <code>.ptx</code>, <code>.pts</code> or <code>.e57</code>.</li>
    </ul>
    <p>Give every item a <strong>slug</strong> (the short name used in URLs: lowercase letters, digits, <code>-</code> and <code>_</code>, 2\u201363 characters, starting with a letter or digit) and a title. A description and a <strong>thumbnail</strong> (PNG, JPEG or WebP, 5 MB by default) are optional.</p>
    <p>Uploads are processed in the background: you can leave the page and watch the progress in the gallery.</p>`;
}

function managing(role) {
  const pick = role === "admin"
    ? "Choose a reader and press <strong>Grant</strong> to share the item with them."
    : "Choosing new readers needs the user list, which only administrators can see: ask an administrator if the picker is empty.";
  return `<p>Press <strong>Manage</strong> on a row to:</p>
    <ul>
      <li>upload, replace or remove the item\u2019s <strong>thumbnail</strong>;</li>
      <li>for volumes, add, replace or remove the <strong>attached mesh</strong>;</li>
      <li>see who has access and <strong>revoke</strong> it. ${pick} For meshes you can also allow a reader to download the file;</li>
      <li><strong>delete</strong> the item. This removes its data and cannot be undone. A failed upload can be deleted here and uploaded again.</li>
    </ul>
    <p>Editors and administrators always see every item. Readers see only the items shared with them.</p>`;
}

function userAdmin() {
  return `<p>Open <strong>Users</strong> in the side menu to:</p>
    <ul>
      <li>create accounts and choose a role: <em>reader</em> (views what is shared with them), <em>editor</em> (uploads and manages items) or <em>admin</em> (also manages users);</li>
      <li>change a role from the drop-down in the user\u2019s row;</li>
      <li><strong>Disable</strong> an account (it can no longer sign in) or enable it again;</li>
      <li><strong>Reset password</strong>: set a new password for someone who has forgotten theirs. They are signed out everywhere and must use the new one;</li>
      <li><strong>Delete</strong> an account.</li>
    </ul>
    <p>You cannot change your own role or delete yourself. Change your own password on the Account page.</p>`;
}

function account() {
  return `<ul>
      <li>Open <strong>Account</strong> in the side menu to change your password. You need the current one, and the new one must be at least 8 characters unless your administrator changed that limit. Your other sessions are signed out.</li>
      <li><strong>Help</strong> (this page) is in the side menu above Account. Inside a viewer, the <strong>Help</strong> button opens a small panel next to the view, so you can keep working while you read it.</li>
      <li><strong>Sign out</strong> is at the bottom of the side menu.</li>
      <li>The sun / monitor / moon switch above it selects the light, system or dark theme.</li>
    </ul>`;
}

function requirements() {
  return `<ul>
      <li><strong>Volumes</strong> need a browser with <strong>WebGPU</strong>: current Chrome or Edge (113 or newer), Safari 26 or newer, or Firefox 141 or newer. The page must be loaded over <strong>HTTPS</strong> (or from <code>localhost</code>); on a plain http:// address the volume viewer cannot start.</li>
      <li>Meshes and point clouds use WebGL, which every current browser supports.</li>
      <li>If a volume is slow or fails to load, make sure hardware acceleration is on, close other GPU-heavy tabs, and lower <em>Render scale</em> or <em>VRAM allocation</em> under Advanced.</li>
      <li>Access to a volume\u2019s data is granted for a limited time. When it runs out, a \u201cSession expired\u201d dialog appears; press <strong>Reload page</strong> to continue.</li>
      <li>Items that are still <em>processing</em> cannot be opened yet. If a share link asks you to sign in, sign in with an account that has access to the item.</li>
    </ul>`;
}

function engines() {
  const items = ENGINES.map((e) => `
    <div class="help-engine">
      <h4>${esc(e.name)} <span class="used-for">\u2013 ${esc(e.usedFor)}</span></h4>
      <p>${esc(e.text)}</p>
      <ul class="help-refs">${e.refs.map(([url, label]) => `<li>${ext(url, label)}</li>`).join("")}</ul>
      ${e.papers.length ? `<p class="used-for">References</p><ul class="help-refs">${e.papers.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    </div>`).join("");
  return `<p>Everything is rendered in your browser by open-source engines. Please cite them when you use images or results from this gallery in publications.</p>${items}
    <p>Browser graphics APIs: ${ext("https://developer.mozilla.org/docs/Web/API/WebGPU_API", "WebGPU")}.</p>`;
}


function contactBody(branding, contactItems) {
  return `<p>Questions or problems? Get in touch with ${esc(branding.organization || branding.app_name)}:</p>
    <div class="help-contact">${contactItems.join("")}</div>`;
}

// ------------------------------------------------------------------------------------------ topics

const isEditor = (role) => role === "editor" || role === "admin";

// id = the anchor on the Help page (/help.html#id). `when` decides who sees the topic.
const TOPICS = [
  { id: "overview", title: "How the gallery works", body: (c) => overview(c.role, c.branding) },
  { id: "volume", title: "Viewing a CT volume", body: () => volumeViewer() },
  { id: "mesh", title: "Viewing a mesh", body: (c) => meshViewer(c.role) },
  { id: "pointcloud", title: "Viewing a point cloud", body: () => pointcloudViewer() },
  { id: "uploading", title: "Uploading items", when: isEditor, body: () => uploading() },
  { id: "managing", title: "Managing items and access", when: isEditor, body: (c) => managing(c.role) },
  { id: "users", title: "Managing users", when: (role) => role === "admin", body: () => userAdmin() },
  { id: "account", title: "Your account", body: () => account() },
  { id: "requirements", title: "Browser requirements and troubleshooting", body: () => requirements() },
  { id: "engines", title: "Rendering engines and references", body: () => engines() },
  { id: "contact", title: "Contact", when: (role, c) => c.contactItems.length > 0, body: (c) => contactBody(c.branding, c.contactItems) },
];

function topicsFor(ctx) {
  return TOPICS.filter((t) => !t.when || t.when(ctx.role, ctx));
}

function ctxOf({ role, branding, contactItems }) {
  return { role, branding: branding || {}, contactItems: contactItems || [] };
}

export const helpUrl = (topic) => `/help.html${topic ? `#${topic}` : ""}`;

/** The whole Help page: a contents list, then every topic that applies to the user. */
export function helpPageHtml(opts) {
  const ctx = ctxOf(opts);
  const topics = topicsFor(ctx);
  const toc = topics.map((t) => `<a href="#${t.id}">${esc(t.title)}</a>`).join("");
  const sections = topics.map((t) => `
    <section class="help-topic" id="${t.id}">
      <h2>${esc(t.title)}</h2>
      <div class="help-body">${t.body(ctx)}</div>
    </section>`).join("");
  return `<nav class="help-toc" aria-label="Help contents">${toc}</nav>${sections}`;
}

/** Makes the Help page follow its #topic links: scrolls to the topic and marks it. */
export function wireHelpPage(root) {
  let current = null;
  const show = () => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const el = id ? root.querySelector(`.help-topic[id="${CSS.escape(id)}"]`) : null;
    current?.classList.remove("is-target");
    current = el;
    if (!el) return;
    el.classList.add("is-target");
    el.scrollIntoView({ block: "start" });
  };
  window.addEventListener("hashchange", show);
  show();
  root.querySelector("[data-show-hints]")?.addEventListener("click", (e) => {
    showAllPageHints();
    e.target.textContent = "Page notes will be shown again";
    e.target.disabled = true;
  });
}

// ------------------------------------------------------------------------------- notes on the pages

// What each page says about itself, in a sentence or two, and which Help topic it links to.
const PAGE_HINTS = {
  gallery: {
    topic: "overview",
    text: (role) => role === "reader"
      ? "The CT volumes, meshes and point clouds shared with you. Click a title or Open to view one; an item that is still processing cannot be opened yet."
      : "Every CT volume, mesh and point cloud. Click a title or Open to view one, Manage to change its thumbnail, access or attached mesh. Items still processing update by themselves.",
  },
  upload: {
    topic: "uploading",
    text: () => "Choose what you are adding (a TIFF stack, a mesh or a point cloud), give it a slug and a title, and upload. It is processed in the background, so you can leave the page and watch the progress in the gallery.",
  },
  manage: {
    topic: "managing",
    text: (role) => role === "admin"
      ? "Replace the thumbnail or the attached mesh, share the item with readers (or revoke access), or delete the item for good."
      : "Replace the thumbnail or the attached mesh, manage who can see the item, or delete it for good. Choosing new readers needs an administrator.",
  },
  admin: {
    topic: "users",
    text: () => "Create accounts and choose reader, editor or admin. You can also disable an account, reset a forgotten password or delete it.",
  },
  account: {
    topic: "account",
    text: () => "Change your password here (your other sessions are signed out). The theme switch and Sign out are at the bottom of the side menu.",
  },
};

const HINT_PREFIX = "vg_hint_hidden_";
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: the note simply comes back */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ditto */ } },
};

/** HTML of the short note for a page (empty if the user hid it). Put it near the top of <main>. */
export function pageHint(page, role) {
  const hint = PAGE_HINTS[page];
  if (!hint || store.get(HINT_PREFIX + page)) return "";
  return `<aside class="page-hint" data-hint="${page}">
    <p>${esc(hint.text(role))} <a href="${helpUrl(hint.topic)}">More in Help</a></p>
    <button type="button" class="page-hint-close" aria-label="Hide this note" title="Hide this note">\u00d7</button>
  </aside>`;
}

function showAllPageHints() {
  for (const page of Object.keys(PAGE_HINTS)) store.del(HINT_PREFIX + page);
}

// One delegated handler serves every page that shows a note.
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".page-hint-close");
  if (!btn) return;
  const note = btn.closest(".page-hint");
  store.set(HINT_PREFIX + note.dataset.hint, "1");
  note.remove();
});

// --------------------------------------------------------------------------- the viewers' help panel

let panel = null;
let panelTopic = null;
let panelPos = null; // remembered between openings: { left, top, width, height }

/**
 * Shows or hides a floating help panel with one topic ("volume", "mesh" or "pointcloud"). It is not
 * modal: no backdrop, no focus trap, the viewer stays usable underneath. Drag the title to move it,
 * drag its lower-right corner to resize it; the link opens the complete Help page in a new tab so the
 * viewer keeps its state. Returns true when the panel is open afterwards.
 */
export function toggleHelpPanel({ topic, role, branding, onClose = () => {} }) {
  if (panel) {
    const same = panelTopic === topic;
    closeHelpPanel();
    if (same) return false;
  }
  const ctx = ctxOf({ role, branding });
  const t = TOPICS.find((x) => x.id === topic);
  if (!t) return false;
  panelTopic = topic;
  panel = document.createElement("aside");
  panel.className = "help-panel";
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", `Help: ${t.title}`);
  panel.tabIndex = -1;
  panel.innerHTML = `
    <div class="help-panel-head" title="Drag to move">
      <h2>${esc(t.title)}</h2>
      <button type="button" class="help-close" aria-label="Close help">\u00d7</button>
    </div>
    <div class="help-panel-body help-body">${t.body(ctx)}</div>
    <div class="help-panel-foot">
      <a href="${helpUrl(topic)}" target="_blank" rel="noopener">Complete help</a>
      <a href="${helpUrl("requirements")}" target="_blank" rel="noopener">Troubleshooting</a>
    </div>`;
  document.body.appendChild(panel);
  if (panelPos) {
    Object.assign(panel.style, { left: `${panelPos.left}px`, top: `${panelPos.top}px`, right: "auto", width: `${panelPos.width}px`, height: `${panelPos.height}px` });
  }
  const closeAndNotify = () => { closeHelpPanel(); onClose(); };
  panel.querySelector(".help-close").addEventListener("click", closeAndNotify);
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeAndNotify(); } });
  dragByHead(panel);
  return true;
}

export function closeHelpPanel() {
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  panelPos = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  panel.remove();
  panel = null;
  panelTopic = null;
}

function dragByHead(el) {
  const head = el.querySelector(".help-panel-head");
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || e.button !== 0) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 80);
      const top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
      Object.assign(el.style, { left: `${left}px`, top: `${top}px`, right: "auto" });
    };
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  });
}
