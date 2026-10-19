// Thin fetch wrapper around the backend API. Keeps the JWT in localStorage —
// fine for a small internal-network appliance; put this behind HTTPS in prod.

const TOKEN_KEY = "vg_token";
const ROLE_KEY = "vg_role";
const USER_KEY = "vg_username";

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function getRole() { return localStorage.getItem(ROLE_KEY); }
export function getUsername() { return localStorage.getItem(USER_KEY); }

export function setSession(token, role, username) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
  localStorage.setItem(USER_KEY, username);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(USER_KEY);
}

// ---- branding (branding/branding.toml on the server; see the README) ----

const DEFAULT_BRANDING = {
  app_name: "Volume Gallery", tagline: "", about: "", organization: "", copyright: "",
  logo_url: null, logo_dark_url: null, contact: {}, links: [],
};
let brandingPromise = null;

// Resolves with the branding (never rejects: falls back to the defaults). Cached per page.
export function getBranding() {
  if (!brandingPromise) {
    brandingPromise = fetch("/api/branding", { cache: "no-cache" })
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}))
      .then((b) => ({ ...DEFAULT_BRANDING, ...b, contact: b.contact || {}, links: b.links || [] }));
  }
  return brandingPromise;
}

// Escapes text for use in HTML, including inside attribute values.
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// <img> tags for the logo: one, or a light and a dark one (shown according to the theme).
export function brandLogoHtml(b, cls = "brand-logo") {
  if (!b.logo_url) return "";
  if (!b.logo_dark_url) return `<img class="${cls}" src="${escapeHtml(b.logo_url)}" alt="" />`;
  return `<img class="${cls} logo-light" src="${escapeHtml(b.logo_url)}" alt="" />` +
         `<img class="${cls} logo-dark" src="${escapeHtml(b.logo_dark_url)}" alt="" />`;
}

// Contact details as links/spans, one per item (the caller decides how to lay them out).
export function contactItems(b) {
  const c = b.contact || {};
  const items = [];
  if (c.email) items.push(`<a href="mailto:${escapeHtml(c.email)}">Contact</a>`);
  if (c.phone) items.push(`<a href="tel:${escapeHtml(c.phone.replace(/[^+\d]/g, ""))}">Phone</a>`);
  if (c.website) {
    items.push(`<a href="${escapeHtml(c.website)}" target="_blank" rel="noopener noreferrer">Web</a>`);
  }
  if (c.address) items.push(`<span>${escapeHtml(c.address)}</span>`);
  return items;
}

export function linkItems(b) {
  return (b.links || []).map((l) =>
    `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)}</a>`);
}

// Puts the configured name and logo into the side rail and the page title.
export async function applyBranding() {
  const b = await getBranding();
  const brand = document.querySelector(".rail .brand");
  if (brand) brand.innerHTML = `<div class="brand-logos">${brandLogoHtml(b)}</div><span>${escapeHtml(b.app_name)}</span>`;
  document.title = document.title.replace(/ \u2014 Volume Gallery$/, ` \u2014 ${b.app_name}`);
  return b;
}

// Login page URL that remembers the page the user was trying to reach (shared links!).
export function loginUrl() {
  const { pathname, search, hash } = window.location;
  if (pathname.endsWith("/login.html")) return "/login.html";
  return `/login.html?next=${encodeURIComponent(pathname + search + hash)}`;
}

// Where to go after signing in: the login URL's `next` parameter, but only if it points
// into this app (otherwise a crafted link could send people to another site).
export function postLoginUrl() {
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw) return "/index.html";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.endsWith("/login.html")) return "/index.html";
    return url.pathname + url.search + url.hash;
  } catch (_) {
    return "/index.html";
  }
}

export function requireLogin() {
  if (!getToken()) {
    window.location.href = loginUrl();
    // Stop the page's own script here: it would otherwise carry on and, for pages that
    // check the role next, replace this redirect with one to the gallery (losing the link).
    throw new Error("Not signed in: redirecting to the login page");
  }
}

async function request(path, options = {}) {
  const headers = options.headers || {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearSession();
    window.location.href = loginUrl();
    throw new Error("Not authenticated");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res;
}

// XHR-based (not fetch) specifically to get real upload-progress events —
// fetch has no stable cross-browser API for tracking request-body upload
// progress, only response-download progress. onProgress(fraction 0..1)
// fires as bytes actually leave the browser; it does NOT track server-side
// processing (that's what /status polling is for, since processing happens
// in a background task after this request already returned). Shared by
// volumes/meshes/point clouds — same upload shape for all three.
function _uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.addEventListener("progress", (evt) => {
      if (evt.lengthComputable && onProgress) onProgress(evt.loaded / evt.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 401) {
        clearSession();
        window.location.href = loginUrl();
        reject(new Error("Not authenticated"));
        return;
      }
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error((data && data.detail) || xhr.statusText || "Upload failed"));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(formData);
  });
}

// URL segment of each asset kind's API (used by the kind-agnostic thumbnail calls)
const ASSET_API = { volume: "volumes", mesh: "meshes", pointcloud: "pointclouds" };

export const api = {
  async login(username, password) {
    const body = new URLSearchParams({ username, password });
    const res = await fetch("/api/auth/login", { method: "POST", body });
    if (!res.ok) {
      let detail = "Login failed";
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    return res.json();
  },

  me() { return request("/api/users/me"); },
  // Changes the signed-in user's own password. Resolves with a fresh token (the old one
  // is revoked by the server): pass it to setSession() to stay signed in.
  changePassword(currentPassword, newPassword) {
    return request("/api/users/me/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
  },

  // thumbnails — kind is "volume" | "mesh" | "pointcloud"
  uploadThumbnail(kind, id, file) {
    const fd = new FormData();
    fd.append("thumbnail_file", file);
    return request(`/api/${ASSET_API[kind]}/${id}/thumbnail`, { method: "POST", body: fd });
  },
  deleteThumbnail(kind, id) {
    return request(`/api/${ASSET_API[kind]}/${id}/thumbnail`, { method: "DELETE" });
  },
  // <img> cannot send the Authorization header, so the image is fetched and handed out as a
  // blob: URL. Resolves with null when the asset has no (readable) thumbnail.
  async thumbnailUrl(kind, id) {
    try {
      const res = await request(`/api/${ASSET_API[kind]}/${id}/thumbnail`);
      return URL.createObjectURL(await res.blob());
    } catch (_) {
      return null;
    }
  },

  // volumes
  listVolumes() { return request("/api/volumes"); },
  getVolume(id) { return request(`/api/volumes/${id}`); },
  // XHR-based (not fetch) specifically to get real upload-progress events —
  // see _uploadWithProgress above for why.
  createVolumeWithProgress(formData, onProgress) {
    return _uploadWithProgress("/api/volumes", formData, onProgress);
  },
  deleteVolume(id) { return request(`/api/volumes/${id}`, { method: "DELETE" }); },
  uploadMesh(id, formData) {
    return request(`/api/volumes/${id}/mesh`, { method: "POST", body: formData });
  },
  zarrAccessUrl(id, minLevel) {
    const qs = minLevel != null ? `?min_level=${encodeURIComponent(minLevel)}` : "";
    return request(`/api/volumes/${id}/zarr-access-url${qs}`);
  },
  // Signed base URL for the slice views: one finished plane per request (backend/app/helpers/slices.py)
  sliceAccessUrl(id) { return request(`/api/volumes/${id}/slice-access-url`); },
  meshAccessUrl(id) { return request(`/api/volumes/${id}/mesh-access-url`); },
  volumeMeshViewUrl(id) { return request(`/api/volumes/${id}/mesh-view-url`); },
  listAccess(id) { return request(`/api/volumes/${id}/access`); },
  grantAccess(id, userId, canDownload) {
    return request(`/api/volumes/${id}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, can_download: !!canDownload }),
    });
  },
  revokeAccess(id, userId) {
    return request(`/api/volumes/${id}/access/${userId}`, { method: "DELETE" });
  },

  // meshes
  listMeshes() { return request("/api/meshes"); },
  getMesh(id) { return request(`/api/meshes/${id}`); },
  createMeshWithProgress(formData, onProgress) {
    return _uploadWithProgress("/api/meshes", formData, onProgress);
  },
  deleteMesh(id) { return request(`/api/meshes/${id}`, { method: "DELETE" }); },
  meshNxzAccessUrl(id) { return request(`/api/meshes/${id}/mesh-access-url`); },
  meshDownloadAccessUrl(id) { return request(`/api/meshes/${id}/download-access-url`); },
  listMeshAccess(id) { return request(`/api/meshes/${id}/access`); },
  grantMeshAccess(id, userId, canDownload) {
    return request(`/api/meshes/${id}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, can_download: !!canDownload }),
    });
  },
  revokeMeshAccess(id, userId) {
    return request(`/api/meshes/${id}/access/${userId}`, { method: "DELETE" });
  },

  // point clouds
  listPointClouds() { return request("/api/pointclouds"); },
  getPointCloud(id) { return request(`/api/pointclouds/${id}`); },
  createPointCloudWithProgress(formData, onProgress) {
    return _uploadWithProgress("/api/pointclouds", formData, onProgress);
  },
  deletePointCloud(id) { return request(`/api/pointclouds/${id}`, { method: "DELETE" }); },
  pointCloudOctreeAccessUrl(id) { return request(`/api/pointclouds/${id}/octree-access-url`); },
  pointCloudDownloadAccessUrl(id) { return request(`/api/pointclouds/${id}/download-access-url`); },
  listPointCloudAccess(id) { return request(`/api/pointclouds/${id}/access`); },
  grantPointCloudAccess(id, userId, canDownload) {
    return request(`/api/pointclouds/${id}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, can_download: !!canDownload }),
    });
  },
  revokePointCloudAccess(id, userId) {
    return request(`/api/pointclouds/${id}/access/${userId}`, { method: "DELETE" });
  },

  // users (admin)
  listUsers() { return request("/api/users"); },
  createUser(payload) {
    return request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  updateUser(id, payload) {
    return request(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  deleteUser(id) { return request(`/api/users/${id}`, { method: "DELETE" }); },
};

// Theme preference: "light" | "dark" | absent (= follow the OS setting).
// Keep THEME_KEY in sync with js/theme-init.js, which applies it before first paint.
const THEME_KEY = "vg_theme";

export function getThemePref() {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function setThemePref(pref) {
  if (pref === "light" || pref === "dark") {
    localStorage.setItem(THEME_KEY, pref);
    document.documentElement.dataset.theme = pref;
  } else {
    localStorage.removeItem(THEME_KEY);
    delete document.documentElement.dataset.theme;
  }
}

const THEME_ORDER = ["light", "system", "dark"]; // switch positions, left to right

export function wireTheme() {
  const sw = document.querySelector(".theme-switch");
  if (!sw) return;
  const buttons = [...sw.querySelectorAll("button[data-theme-pref]")];
  const sync = () => {
    const cur = getThemePref();
    sw.dataset.pos = String(THEME_ORDER.indexOf(cur));
    buttons.forEach((b) => {
      const on = b.dataset.themePref === cur;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  const choose = (pref) => { setThemePref(pref); sync(); };
  buttons.forEach((b) => b.addEventListener("click", () => choose(b.dataset.themePref)));
  sw.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = (THEME_ORDER.indexOf(getThemePref()) + step + THEME_ORDER.length) % THEME_ORDER.length;
    choose(THEME_ORDER[i]);
    buttons[i].focus();
  });
  sync();
}

export function renderShell(activePage, role, username) {
  const navItems = [{ href: "/index.html", label: "Gallery", key: "gallery" }];
  if (role === "editor" || role === "admin") {
    navItems.push({ href: "/upload.html", label: "Upload", key: "upload" });
  }
  if (role === "admin") {
    navItems.push({ href: "/admin.html", label: "Users", key: "admin" });
  }
  navItems.push({ href: "/account.html", label: "Account", key: "account" });
  const nav = navItems
    .map(
      (item) =>
        `<a href="${item.href}" class="${item.key === activePage ? "active" : ""}">${item.label}</a>`
    )
    .join("");
  return `
    <div class="rail">
      <div class="rail-top">
        <div class="rail-id">
          <div class="brand">Volume Gallery</div>
          <div class="role-tag">${role}</div>
        </div>
        <button type="button" class="rail-toggle" aria-label="Menu" aria-expanded="false" aria-controls="rail-menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </button>
      </div>
      <div class="rail-menu" id="rail-menu">
      <nav>${nav}</nav>
      <div class="spacer"></div>
      <div class="theme-switch" role="radiogroup" aria-label="Theme" data-pos="1">
        <button type="button" role="radio" data-theme-pref="light" aria-label="Light theme" title="Light">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button type="button" role="radio" data-theme-pref="system" aria-label="Follow system theme" title="System (follow PC setting)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
        </button>
        <button type="button" role="radio" data-theme-pref="dark" aria-label="Dark theme" title="Dark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        </button>
      </div>
      <div class="signed-in-as">Signed in as <strong>${username}</strong></div>
      <button id="logout-btn">Sign out</button>
      </div>
    </div>
  `;
}

export function wireLogout() {
  wireTheme(); // every page that renders the shell already calls this
  applyBranding();
  // On phones the side rail is a top bar whose menu opens with this button.
  const rail = document.querySelector(".rail");
  const toggle = document.querySelector(".rail-toggle");
  if (rail && toggle) {
    toggle.addEventListener("click", () => {
      toggle.setAttribute("aria-expanded", String(rail.classList.toggle("open")));
    });
  }
  const btn = document.getElementById("logout-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      clearSession();
      window.location.href = "/login.html";
    });
  }
}