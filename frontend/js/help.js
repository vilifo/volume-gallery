// The gallery's Help dialog. The content depends on the signed-in user's role:
// readers get the viewing basics, editors also see uploading and managing, admins also
// see user management. Rendering-engine credits are shown to everyone.
//
// Self-contained on purpose (no imports), so the version query string of api.js does not
// matter here. The caller passes in the branding and a ready-made contact block.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const ext = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;

// Add or change an engine here. `refs` are links, `papers` are plain citations.
const ENGINES = [
  {
    name: "kiln-render",
    usedFor: "CT volumes",
    text: "A WebGPU-native, out-of-core volume renderer. It streams large OME-Zarr datasets over HTTP into a fixed-size " +
          "GPU cache, using virtual texturing and compute-shader ray marching, so volumes much larger than the GPU memory " +
          "can still be explored interactively. This gallery uses a patched build.",
    refs: [
      ["https://github.com/MPanknin/kiln-render", "kiln-render on GitHub (M. Panknin)"],
      ["https://dev.to/mpanknin/kiln-webgpu-native-out-of-core-volume-rendering-for-multi-gb-datasets-2alb", "Kiln: WebGPU-Native Out-of-Core Volume Rendering for Multi-GB Datasets"],
      ["https://ngff.openmicroscopy.org", "OME-Zarr (OME-NGFF) specification, the volume storage format"],
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

function section(title, body, open = false) {
  return `<details class="help-section"${open ? " open" : ""}><summary>${title}</summary><div class="help-body">${body}</div></details>`;
}

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
  return `<p>Open a CT item to see the volume in 3D. Drag in the view to rotate it and scroll (or pinch) to zoom. The <strong>Volume controls</strong> panel has everything else.</p>
    <ul>
      <li><strong>Layout</strong> (3D, Quad, XY, XZ, YZ): the 3D view only, the 3D view with the three slice views, or one slice plane. XY steps through slices along Z, XZ along Y and YZ along X.</li>
      <li><strong>Render mode</strong>: <em>DVR</em> (direct volume rendering) shows the volume semi-transparent, shaped by the transfer function. <em>MIP</em> (maximum intensity projection) shows the brightest value along each line of sight. <em>ISO</em> shows a solid surface at the chosen threshold.</li>
      <li><strong>Transfer function</strong> (colour and opacity curve): click to add a point, drag a point to move it, double-click a point to remove it. The dark area behind the curve is a histogram of the volume\u2019s intensities (logarithmic height), so you can see where the data is. It is missing for volumes whose histogram has not been computed yet.</li>
      <li><strong>Scene</strong>: choose which axis points up, show a wireframe or axes, and cut the volume open with the Clip X / Y / Z sliders.</li>
      <li><strong>Advanced</strong>: <em>Render scale</em> trades sharpness for speed, <em>Max detail level</em> limits the resolution that is streamed (0 is full resolution), and <em>VRAM allocation</em> sets how much graphics memory may cache the volume.</li>
      <li><strong>Share</strong> copies a link to exactly this view. Whoever opens it must sign in and have access to the item.</li>
      <li><strong>View mesh</strong> appears when a mesh is attached to the volume. <strong>Fullscreen</strong> enlarges the view.</li>
    </ul>`;
}

function meshViewer(role) {
  const dl = role === "reader"
    ? "<strong>Download</strong> appears only if you were allowed to download the mesh."
    : "<strong>Download</strong> saves the original mesh file.";
  return `<p>Drag to rotate the model and scroll (or pinch) to zoom. The toolbar offers:</p>
    <ul>
      <li><strong>Measure</strong>: distances between points on the surface.</li>
      <li><strong>Pick point</strong>: shows the coordinates of a point you click, with a Copy button.</li>
      <li><strong>Plane sections</strong>: cut the model along the X, Y or Z axis, move the plane with the slider and flip its direction.</li>
      <li><strong>Appearance</strong>: change the background, or paint the whole model in one colour instead of its vertex colours and textures.</li>
      <li>${dl} <strong>Fullscreen</strong> enlarges the view. A mesh attached to a volume has a <strong>Back to volume</strong> button.</li>
    </ul>`;
}

function pointcloudViewer() {
  return `<p>Drag to rotate, scroll (or pinch) to zoom. The points load progressively, so the view sharpens as you get closer or wait a moment. Use the sidebar toggle to open Potree\u2019s side panel for point size, colouring and measuring tools. <strong>Fullscreen</strong> enlarges the view.</p>`;
}

function uploading() {
  return `<p>Open <strong>Upload</strong> in the side menu and choose what you are adding:</p>
    <ul>
      <li><strong>OME-Zarr (.zip)</strong>: a zip containing the <code>.ome.zarr</code> (or <code>.zarr</code>) folder. It is unpacked on the server.</li>
      <li><strong>TIFF stack (.zip of .tif files)</strong>: a flat zip of single-slice <code>.tif</code>/<code>.tiff</code> files, one per Z position. Slice order follows the file names alphabetically (for example <code>slice_0001.tif</code>, <code>slice_0002.tif</code>), so number them with leading zeros. The stack is converted to OME-Zarr and the TIFF files are then deleted. Large stacks are loaded into memory while converting.</li>
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
      <li><strong>Sign out</strong> is at the bottom of the side menu.</li>
      <li>The sun / monitor / moon switch above it selects the light, system or dark theme.</li>
    </ul>`;
}

function requirements() {
  return `<ul>
      <li><strong>Volumes</strong> need a browser with <strong>WebGPU</strong>: current Chrome or Edge (113 or newer), Safari 26 or newer, or Firefox 141 or newer. The page must be loaded over <strong>HTTPS</strong> (or from <code>localhost</code>); on a plain http:// address the volume viewer cannot start.</li>
      <li>Meshes and point clouds use WebGL, which every current browser supports.</li>
      <li>If a volume is slow or fails to load, make sure hardware acceleration is on, close other GPU-heavy tabs, and lower <em>Render scale</em> or <em>VRAM allocation</em> under Advanced.</li>
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

function contact(branding, contactItems) {
  if (!contactItems.length) return "";
  return section("Contact", `<p>Questions or problems? Get in touch with ${esc(branding.organization || branding.app_name)}:</p>
    <div class="help-contact">${contactItems.join("")}</div>`);
}

export function helpHtml(role, branding, contactItems = []) {
  const editor = role === "editor" || role === "admin";
  return [
    section("How the gallery works", overview(role, branding), true),
    section("Viewing a CT volume", volumeViewer()),
    section("Viewing a mesh", meshViewer(role)),
    section("Viewing a point cloud", pointcloudViewer()),
    editor ? section("Uploading items", uploading()) : "",
    editor ? section("Managing items and access", managing(role)) : "",
    role === "admin" ? section("Managing users", userAdmin()) : "",
    section("Your account", account()),
    section("Browser requirements and troubleshooting", requirements()),
    section("Rendering engines and references", engines()),
    contact(branding, contactItems),
  ].join("");
}

// Shows the dialog. Closes on Esc, on the close button and on a click outside it.
export function openHelp({ role, branding, contactItems = [], onClose = () => {} }) {
  const previouslyFocused = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" tabindex="-1">
      <div class="help-head">
        <h2 id="help-title">Help \u2014 ${esc(branding.app_name)}</h2>
        <button type="button" class="help-close" aria-label="Close help">\u00d7</button>
      </div>
      <div class="help-scroll">${helpHtml(role, branding, contactItems)}</div>
    </div>`;
  document.body.appendChild(backdrop);
  const dialog = backdrop.firstElementChild;
  const scrollLock = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = scrollLock;
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    onClose();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector(".help-close").addEventListener("click", close);
  dialog.focus();
  return close;
}
