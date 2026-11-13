// The page script of viewers/pointcloud.html (it was an inline <script type="module"> there). Bundled by webpack.config.js.
import { api, requireLogin, getRole, getUsername, renderShell, wireLogout } from "../js/api.js";
import { toggleHelpPanel } from "../js/help.js";
import { makeDescriptionExpandable } from "../js/description.js";

requireLogin();
const role = getRole();
const params = new URLSearchParams(window.location.search);
const pcId = params.get("id");

const EXPAND_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
const HELP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></svg>`;
const LINK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

document.getElementById("shell").innerHTML = `
  ${renderShell("gallery", role, getUsername())}
  <main><div id="content" style="display:flex; flex-direction:column; height:100%;"></div></main>
`;
wireLogout();

const content = document.getElementById("content");

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function init() {
  if (!pcId) {
    content.innerHTML = `<div class="error-box" style="margin:1.4em">No point cloud specified.</div>`;
    return;
  }
  let pc;
  try {
    pc = await api.getPointCloud(pcId);
  } catch (err) {
    const safeMessage = escapeHtml(String(err?.message ?? "Failed to load point cloud."));
    content.innerHTML = `<div class="error-box" style="margin:1.4em">${safeMessage}</div>`;
    return;
  }

  content.innerHTML = `
    <div class="viewer-topbar">
      <div class="viewer-titles">
        <h1>${escapeHtml(pc.title)}</h1>
        ${pc.description ? `<div class="viewer-desc">${escapeHtml(pc.description)}</div>` : ""}
      </div>
      <div class="viewer-topbar-actions">
        <button id="help-btn" class="icon-btn" aria-pressed="false" title="Show help for this viewer next to the view">${HELP_ICON}<span class="icon-btn-label">Help</span></button>
        <button id="share-btn" class="icon-btn" title="Copy a link to this exact view">${LINK_ICON}<span class="icon-btn-label">Share</span></button>
        <button id="fullscreen-btn" class="icon-btn primary">${EXPAND_ICON}<span>Fullscreen</span></button>
      </div>
    </div>
    <div class="pc-render-area" id="render-area">
      <div class="potree_container">
        <div id="potree_render_area"></div>
        <div id="potree_sidebar_container"></div>
      </div>
      <div class="viewer-status" id="status">Loading point cloud viewer\u2026</div>
    </div>
  `;

  const descEl = content.querySelector(".viewer-desc");
  if (descEl) makeDescriptionExpandable(descEl, { title: pc.title, text: pc.description });

  const statusEl = document.getElementById("status");
  const renderArea = document.getElementById("render-area");

  document.getElementById("fullscreen-btn").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else renderArea.requestFullscreen().catch((err) => alert(`Couldn't enter fullscreen: ${err.message}`));
  });



  // Share view URL button
  // Help: a floating panel, not a dialog, so the view stays usable while it is open.
  const helpBtn = document.getElementById("help-btn");
  helpBtn.addEventListener("click", () => {
    const open = toggleHelpPanel({ topic: "pointcloud", role: getRole(), onClose: () => helpBtn.setAttribute("aria-pressed", "false") });
    helpBtn.setAttribute("aria-pressed", String(open));
  });

  document.getElementById("share-btn").addEventListener("click", async () => {
    const btn = document.getElementById("share-btn");
    const origHtml = btn.innerHTML;

    // Readers just copy the direct current view URL
    if (role !== "editor" && role !== "admin") {
      try {
        await navigator.clipboard.writeText(window.location.href);
        btn.textContent = "Copied!";
        setTimeout(() => { btn.innerHTML = origHtml; }, 1200);
      } catch (_) {}
      return;
    }

    let cfg;
    try {
      cfg = await api.suggestShareCode();
    } catch (_) {
      cfg = { min_length: 4, max_length: 16, suggested_code: "" };
    }

    let modalRoot = document.getElementById("modal-root");
    if (!modalRoot) {
      modalRoot = document.createElement("div");
      modalRoot.id = "modal-root";
      document.body.appendChild(modalRoot);
    }

    const DESC_DIRECT =
      "Copies a direct link to this pointcloud. The recipient must sign in with an account that has access.";
    const DESC_TIMED =
      "Generates a short, time-limited public link (/s/code) that opens this pointcloud directly without signing in.";

    modalRoot.innerHTML = `
      <div class="modal-backdrop" id="share-modal-backdrop">
        <div class="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
          <div class="share-modal-head">
            <h2 id="share-modal-title">Share current view</h2>
          </div>

          <div class="share-mode-switch" id="share-mode-switch" data-mode="direct" role="tablist">
            <div class="share-mode-thumb"></div>
            <button type="button" class="share-mode-btn active" data-set-mode="direct" role="tab" aria-selected="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <span>Members only</span>
            </button>
            <button type="button" class="share-mode-btn" data-set-mode="timed" role="tab" aria-selected="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              <span>Public token link</span>
            </button>
          </div>

          <p class="share-mode-desc" id="share-mode-desc">${DESC_DIRECT}</p>
          <div id="modal-error" style="display:none;margin-bottom:0.9em" class="error-box"></div>

          <div class="share-drawer" id="timed-drawer">
            <div class="share-drawer-inner">
              <div class="share-drawer-card">
                <div class="field" style="margin:0">
                  <label for="m-code">Short link name (${cfg.min_length}–${cfg.max_length} chars)</label>
                  <div class="share-code-row">
                    <span class="share-code-prefix">/s/</span>
                    <input id="m-code" class="mono" value="${escapeHtml(cfg.suggested_code)}" minlength="${cfg.min_length}" maxlength="${cfg.max_length}" />
                    <button type="button" class="share-regen-btn" id="m-regen" title="Generate new random code" aria-label="Generate new random code">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 2v6h-6"/>
                        <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                        <path d="M3 22v-6h6"/>
                        <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
                      </svg>
                    </button>
                  </div>
                </div>

                <div class="field" style="margin:0">
                  <label for="m-exp">Expires after</label>
                  <select id="m-exp">
                    <option value="60">1 hour</option>
                    <option value="1440" selected>24 hours</option>
                    <option value="10080">7 days</option>
                    <option value="43200">30 days</option>
                    <option value="262800">6 months</option>
                    <option value="525600">1 year</option>
                    <option value="0">Never</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div class="modal-actions">
            <button type="button" id="m-cancel">Cancel</button>
            <button type="button" class="primary" id="m-submit" style="display:inline-flex;align-items:center;gap:0.45em">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              <span id="m-submit-label">Copy direct link</span>
            </button>
          </div>
        </div>
      </div>
    `;

    let mode = "direct";
    const switchEl = document.getElementById("share-mode-switch");
    const descEl = document.getElementById("share-mode-desc");
    const drawerEl = document.getElementById("timed-drawer");
    const submitLabel = document.getElementById("m-submit-label");
    const errBox = document.getElementById("modal-error");

    const close = () => { modalRoot.innerHTML = ""; };
    document.getElementById("m-cancel").addEventListener("click", close);
    document.getElementById("share-modal-backdrop").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) close();
    });

    switchEl.querySelectorAll("[data-set-mode]").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        mode = tabBtn.dataset.setMode;
        switchEl.dataset.mode = mode;
        switchEl.querySelectorAll("[data-set-mode]").forEach((b) => {
          const active = b.dataset.setMode === mode;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", String(active));
        });
        descEl.textContent = mode === "timed" ? DESC_TIMED : DESC_DIRECT;
        drawerEl.classList.toggle("open", mode === "timed");
        submitLabel.textContent = mode === "timed" ? "Create & copy link" : "Copy direct link";
        errBox.style.display = "none";
      });
    });

    document.getElementById("m-regen").addEventListener("click", async () => {
      const n = await api.suggestShareCode();
      document.getElementById("m-code").value = n.suggested_code;
    });

    document.getElementById("m-submit").addEventListener("click", async () => {
      errBox.style.display = "none";
      try {
        let linkToCopy = window.location.href;
        if (mode === "timed") {
          const code = document.getElementById("m-code").value.trim();
          const exp = parseInt(document.getElementById("m-exp").value, 10);
          const res = await api.createShare({
            code,
            asset_type: "pointcloud",
            asset_id: Number(pcId),
            expires_in_minutes: exp,
          });
          linkToCopy = res.url;
        }
        if (navigator.clipboard) await navigator.clipboard.writeText(linkToCopy);
        btn.textContent = "Copied!";
        setTimeout(() => { btn.innerHTML = origHtml; }, 1200);
        close();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.style.display = "block";
      }
    });
  });

  if (!window.WebGLRenderingContext) {
    statusEl.textContent = "This browser doesn't support WebGL, which the point cloud viewer needs.";
    return;
  }

  try {
    const access = await api.pointCloudOctreeAccessUrl(pcId);
    Potree.workerPath = window.location.origin + "/vendor/potree/workers";
    Potree.resourcePath = window.location.origin + "/vendor/potree/resources";

    const viewer = new Potree.Viewer(document.getElementById("potree_render_area"));
    // Potree's toggleSidebar() moves the render area's LEFT edge (its sidebar is on the left); ours
    // is on the right. Must be in place before loadGUI(), which wires it to the menu button.
    viewer.toggleSidebar = () => {
      const area = $("#potree_render_area");
      area.css("right", area.css("right") !== "0px" ? "0px" : "300px");
    };
    viewer.setEDLEnabled(true);
    viewer.setFOV(60);
    viewer.setPointBudget(1_000_000);
    viewer.setBackground("black");
    viewer.loadGUI(() => {
      viewer.setLanguage("en");
      $("#menu_appearance").next().show();
      $("#menu_tools").next().show();
      // The sidebar would cover most of a phone screen: leave it closed there (Potree's
      // menu button in the render area opens it).
      if (window.innerWidth > 800) viewer.toggleSidebar();
    });

    Potree.loadPointCloud(`${access.url}metadata.json`, "cloud", (e) => {
      if (!e || !e.pointcloud) {
        statusEl.textContent = "Could not load point cloud: the converted octree didn't load correctly.";
        statusEl.style.display = "flex";
        return;
      }
      const pointcloud = e.pointcloud;
      viewer.scene.addPointCloud(pointcloud);
      pointcloud.material.size = 1;
      pointcloud.material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
      viewer.fitToScreen();
      statusEl.style.display = "none";
    });
  } catch (err) {
    statusEl.textContent = `Could not load point cloud: ${err.message}`;
    statusEl.style.display = "flex";
  }
}

init();
