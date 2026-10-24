// Thin fetch wrapper around the backend API. Keeps the JWT in localStorage —
// fine for a small internal-network appliance; put this behind HTTPS in prod.

const TOKEN_KEY = "vg_token";
const ROLE_KEY = "vg_role";
const USER_KEY = "vg_username";
const SHARE_TOKEN_KEY = "vg_share_token";
const SHARE_CODE_KEY = "vg_share_code";
const RAIL_COLLAPSED_KEY = "vg_rail_collapsed";

// Consume #vg_st=<token>&vg_sc=<code> from /s/<code> redirect immediately on module load
(function _consumeShareHash() {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#vg_st=")) return;
  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const st = params.get("vg_st");
    const sc = params.get("vg_sc");
    if (st) sessionStorage.setItem(SHARE_TOKEN_KEY, st);
    if (sc) sessionStorage.setItem(SHARE_CODE_KEY, sc);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch (_) {}
})();

export function isGuestShareSession() {
    return Boolean(sessionStorage.getItem(SHARE_TOKEN_KEY)) && !localStorage.getItem(TOKEN_KEY);
}

export function getShareToken() {
    return sessionStorage.getItem(SHARE_TOKEN_KEY);
}

export function clearShareSession() {
    sessionStorage.removeItem(SHARE_TOKEN_KEY);
    sessionStorage.removeItem(SHARE_CODE_KEY);
}

export function getToken() {
    // On viewer pages, if a scoped share session token is active, use it when no user is logged in
    // (or prefer it if the URL was opened via a share link).
    if (window.location.pathname.startsWith("/viewers/") && sessionStorage.getItem(SHARE_TOKEN_KEY)) {
        return sessionStorage.getItem(SHARE_TOKEN_KEY);
    }
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(SHARE_TOKEN_KEY);
}

export function getRole() {
    return localStorage.getItem(ROLE_KEY) || (sessionStorage.getItem(SHARE_TOKEN_KEY) ? "guest" : null);
}

export function getUsername() {
    return localStorage.getItem(USER_KEY) || (sessionStorage.getItem(SHARE_CODE_KEY) ? `shared:${sessionStorage.getItem(SHARE_CODE_KEY)}` : "guest");
}

export function setSession(token, role, username) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, role);
    localStorage.setItem(USER_KEY, username);
}


export function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
    localStorage.removeItem(USER_KEY);
    clearShareSession();
}

// ---- branding (branding/branding.toml on the server; see the README) ----

const DEFAULT_BRANDING = {
    app_name: "Volume Gallery", tagline: "", about: "", organization: "", copyright: "",
    logo_url: null, logo_dark_url: null, contact: {}, links: [],
};

const NAV_ICONS = {
  gallery: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  admin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
};

let brandingPromise = null;

// Resolves with the branding (never rejects: falls back to the defaults). Cached per page.
// The last branding the server sent is kept in localStorage, so the next page load can draw the
// right name and logo straight away instead of the defaults followed by a visible swap.
const BRANDING_CACHE_KEY = "vg_branding";

function normalizeBranding(b) {
    return {...DEFAULT_BRANDING, ...b, contact: (b && b.contact) || {}, links: (b && b.links) || []};
}

// Synchronous: the cached branding, or null on the very first visit (or if storage is unavailable).
export function getCachedBranding() {
    try {
        const raw = localStorage.getItem(BRANDING_CACHE_KEY);
        return raw ? normalizeBranding(JSON.parse(raw)) : null;
    } catch (_) {
        return null;
    }
}

export function getBranding() {
    if (!brandingPromise) {
        brandingPromise = fetch("/api/branding", {cache: "no-cache"})
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null)
            .then((b) => {
                if (b) {
                    try { localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(b)); } catch (_) { /* full or blocked */ }
                    return normalizeBranding(b);
                }
                return getCachedBranding() || normalizeBranding({}); // server unreachable: keep what we had
            });
    }
    return brandingPromise;
}

// Escapes text for use in HTML, including inside attribute values.
export function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));
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
// Inner HTML of the rail's brand block, and a signature that says when it needs redrawing.
function railBrandHtml(b) {
  const logos = brandLogoHtml(b);
  const monogram = !logos
    ? `<span class="brand-monogram">${escapeHtml((b.app_name || "V").slice(0, 1).toUpperCase())}</span>`
    : "";
  return `<div class="brand-logos${logos ? " has-logo" : ""}">${logos}${monogram}</div><span class="brand-text">${escapeHtml(b.app_name)}</span>`;
}
const brandSignature = (b) => JSON.stringify([b.app_name, b.logo_url, b.logo_dark_url]);

// "<page> \u2014 <name>": swaps the name part of the tab title, whatever name it showed before.
let titleName = "Volume Gallery";
function setTitleName(name) {
  const suffix = ` \u2014 ${titleName}`;
  if (document.title.endsWith(suffix)) document.title = document.title.slice(0, -suffix.length) + ` \u2014 ${name}`;
  titleName = name;
}

export async function applyBranding() {
  const b = await getBranding();
  const brand = document.querySelector(".rail .brand");
  if (brand) {
    // Already drawn from the cache and unchanged: leave the DOM alone (nothing to flicker).
    if (brand.dataset.sig !== brandSignature(b)) {
      brand.innerHTML = railBrandHtml(b);
      brand.dataset.sig = brandSignature(b);
    }
    brand.removeAttribute("data-pending");
  }
  setTitleName(b.app_name);
  return b;
}

// Login page URL that remembers the page the user was trying to reach (shared links!).
export function loginUrl() {
    const {pathname, search, hash} = window.location;
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
    const res = await fetch(path, {...options, headers});
    if (res.status === 401) {
        clearSession();
        window.location.href = loginUrl();
        throw new Error("Not authenticated");
    }
    if (!res.ok) {
        let detail = res.statusText;
        try {
            detail = (await res.json()).detail || detail;
        } catch (_) {
        }
        throw new Error(detail);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res;
}

// XHR-based (not fetch) specifically to get real upload-progress events —
// fetch has no stable cross-browser API for tracking request-body upload
// progress, only response-download progress. onProgress(loaded, total) in
// bytes fires as bytes actually leave the browser; it does NOT track
// server-side processing (that's what /status polling is for, since
// processing happens in a background task after the request already
// returned). Shared by volumes/meshes/point clouds — same upload shape for
// all three.
function _xhrWithProgress(method, path, body, onProgress, headers = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, path);
        const token = getToken();
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        xhr.upload.addEventListener("progress", (evt) => {
            if (evt.lengthComputable && onProgress) onProgress(evt.loaded, evt.total);
        });
        xhr.addEventListener("load", () => {
            if (xhr.status === 401) {
                clearSession();
                window.location.href = loginUrl();
                reject(new Error("Not authenticated"));
                return;
            }
            let data = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (_) {
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(data);
            } else {
                reject(new Error((data && data.detail) || xhr.statusText || "Upload failed"));
            }
        });
        xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
        xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
        xhr.send(body);
    });
}

// Each big file goes to the server as the raw body of its own request, PUT /api/uploads/<kind>:
// nginx writes such a body to disk exactly once, in the processing directory (the data directory for
// meshes), and the server just renames that file into place. The multipart form is then only
// sent with the small fields and the ids of the staged files (see backend/app/routers/uploads.py).
// A multipart form carrying the files would have to be parsed and spooled to a temp file and copied
// from there. The thumbnail is small and stays in the form.
//   form field -> [upload kind, id field of the create request]
const _STAGED_FIELDS = {
    tiff_zip: ["volume", "tiff_upload_id"],
    tiff_files: ["volume", "tiff_upload_ids"],
    mesh_file: ["mesh", "mesh_upload_id"],
    pointcloud_file: ["pointcloud", "pointcloud_upload_id"],
};
const _STAGE_CONCURRENCY = 3;  // only matters for stacks of many small slice files

// File -> upload id of the copy already staged on the server. When the create request is
// refused (slug taken, ...) the form is shown again, and sending it once more must not upload
// a 20 GB file a second time. Forgotten once the server has consumed the upload, or when it says
// it no longer has it (staged uploads that are never claimed expire after a day).
const _stagedIds = new WeakMap();

function _forgetStaged(formData) {
    for (const [key, value] of formData.entries()) {
        if (key in _STAGED_FIELDS && value instanceof File) _stagedIds.delete(value);
    }
}

async function _createWithStaged(formData, send, onProgress) {
    const staged = await _stageFiles(formData, onProgress);
    try {
        const result = await send(staged);
        _forgetStaged(formData);
        return result;
    } catch (err) {
        if (/Unknown or expired upload/.test(err.message)) _forgetStaged(formData);
        throw err;
    }
}

async function _stageFiles(formData, onProgress) {
    const jobs = [];
    const staged = new FormData();
    for (const [key, value] of formData.entries()) {
        if (key in _STAGED_FIELDS && value instanceof File) {
            jobs.push({file: value, field: key, id: null, loaded: 0});
        } else {
            staged.append(key, value);
        }
    }
    if (jobs.length === 0) return formData;

    const total = jobs.reduce((sum, job) => sum + job.file.size, 0) || 1;
    const report = () => onProgress && onProgress(jobs.reduce((sum, job) => sum + job.loaded, 0) / total);
    let next = 0;
    let failed = false;
    const worker = async () => {
        while (!failed && next < jobs.length) {
            const job = jobs[next++];
            const [kind] = _STAGED_FIELDS[job.field];
            if (_stagedIds.has(job.file)) {  // already on the server from an earlier attempt
                job.id = _stagedIds.get(job.file);
                job.loaded = job.file.size;
                report();
                continue;
            }
            let res;
            try {
                res = await _xhrWithProgress(
                    "PUT", `/api/uploads/${kind}?name=${encodeURIComponent(job.file.name)}`, job.file,
                    (loaded) => { job.loaded = loaded; report(); },
                    {"Content-Type": "application/octet-stream"},
                );
            } catch (err) {
                failed = true;  // the other workers take no further files
                throw err;
            }
            job.id = res.upload_id;
            _stagedIds.set(job.file, job.id);
            job.loaded = job.file.size;
            report();
        }
    };
    await Promise.all(Array.from({length: Math.min(_STAGE_CONCURRENCY, jobs.length)}, worker));
    for (const job of jobs) staged.append(_STAGED_FIELDS[job.field][1], job.id);  // keeps the files' order
    return staged;
}

function _uploadWithProgress(path, formData, onProgress) {
    return _createWithStaged(formData, (staged) => _xhrWithProgress("POST", path, staged, null), onProgress);
}

// URL segment of each asset kind's API (used by the kind-agnostic thumbnail calls)
const ASSET_API = {volume: "volumes", mesh: "meshes", pointcloud: "pointclouds"};

export const api = {
    async login(username, password) {
        const body = new URLSearchParams({username, password});
        const res = await fetch("/api/auth/login", {method: "POST", body});
        if (!res.ok) {
            let detail = "Login failed";
            try {
                detail = (await res.json()).detail || detail;
            } catch (_) {
            }
            throw new Error(detail);
        }
        return res.json();
    },

    me() {
        return request("/api/users/me");
    },
    // Changes the signed-in user's own password. Resolves with a fresh token (the old one
    // is revoked by the server): pass it to setSession() to stay signed in.
    changePassword(currentPassword, newPassword) {
        return request("/api/users/me/password", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({current_password: currentPassword, new_password: newPassword}),
        });
    },

    // thumbnails — kind is "volume" | "mesh" | "pointcloud"
    uploadThumbnail(kind, id, file) {
        const fd = new FormData();
        fd.append("thumbnail_file", file);
        return request(`/api/${ASSET_API[kind]}/${id}/thumbnail`, {method: "POST", body: fd});
    },
    deleteThumbnail(kind, id) {
        return request(`/api/${ASSET_API[kind]}/${id}/thumbnail`, {method: "DELETE"});
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

    // share links (editor / admin)
    suggestShareCode() {
        return request("/api/shares/suggest");
    },
    listShares(assetType, assetId) {
        const q = new URLSearchParams();
        if (assetType) q.set("asset_type", assetType);
        if (assetId != null) q.set("asset_id", String(assetId));
        return request(`/api/shares?${q.toString()}`);
    },
    createShare(payload) {
        return request("/api/shares", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload),
        });
    },
    deleteShare(shareId) {
        return request(`/api/shares/${shareId}`, {method: "DELETE"});
    },


    // volumes
    listVolumes() {
        return request("/api/volumes");
    },
    getVolume(id) {
        return request(`/api/volumes/${id}`);
    },
    // XHR-based (not fetch) specifically to get real upload-progress events —
    // see _uploadWithProgress above for why.
    createVolumeWithProgress(formData, onProgress) {
        return _uploadWithProgress("/api/volumes", formData, onProgress);
    },
    deleteVolume(id) {
        return request(`/api/volumes/${id}`, {method: "DELETE"});
    },
    uploadMesh(id, formData) {
        return _createWithStaged(
            formData, (staged) => request(`/api/volumes/${id}/mesh`, {method: "POST", body: staged}),
        );
    },
    // The volume's intensity histogram (JSON), or null when it has none yet.
    async volumeHistogram(id) {
        try {
            return await (await request(`/api/volumes/${id}/histogram`));
        } catch (err) {
            console.debug("No histogram for this volume:", err.message);
        }
    },
    volumeDataAccessUrl(id, minLevel) {
        const qs = minLevel != null ? `?min_level=${encodeURIComponent(minLevel)}` : "";
        return request(`/api/volumes/${id}/volume-data-access-url${qs}`);
    },
    // Signed base URL for the slice views: one finished plane per request (backend/app/helpers/slices.py)
    sliceAccessUrl(id) {
        return request(`/api/volumes/${id}/slice-access-url`);
    },
    meshAccessUrl(id) {
        return request(`/api/volumes/${id}/mesh-access-url`);
    },
    volumeMeshViewUrl(id) {
        return request(`/api/volumes/${id}/mesh-view-url`);
    },
    listAccess(id) {
        return request(`/api/volumes/${id}/access`);
    },
    grantAccess(id, userId, canDownload) {
        return request(`/api/volumes/${id}/access`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({user_id: userId, can_download: !!canDownload}),
        });
    },
    revokeAccess(id, userId) {
        return request(`/api/volumes/${id}/access/${userId}`, {method: "DELETE"});
    },

    // meshes
    listMeshes() {
        return request("/api/meshes");
    },
    getMesh(id) {
        return request(`/api/meshes/${id}`);
    },
    createMeshWithProgress(formData, onProgress) {
        return _uploadWithProgress("/api/meshes", formData, onProgress);
    },
    deleteMesh(id) {
        return request(`/api/meshes/${id}`, {method: "DELETE"});
    },
    meshNxzAccessUrl(id) {
        return request(`/api/meshes/${id}/mesh-access-url`);
    },
    meshDownloadAccessUrl(id) {
        return request(`/api/meshes/${id}/download-access-url`);
    },
    listMeshAccess(id) {
        return request(`/api/meshes/${id}/access`);
    },
    grantMeshAccess(id, userId, canDownload) {
        return request(`/api/meshes/${id}/access`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({user_id: userId, can_download: !!canDownload}),
        });
    },
    revokeMeshAccess(id, userId) {
        return request(`/api/meshes/${id}/access/${userId}`, {method: "DELETE"});
    },

    // point clouds
    listPointClouds() {
        return request("/api/pointclouds");
    },
    getPointCloud(id) {
        return request(`/api/pointclouds/${id}`);
    },
    createPointCloudWithProgress(formData, onProgress) {
        return _uploadWithProgress("/api/pointclouds", formData, onProgress);
    },
    deletePointCloud(id) {
        return request(`/api/pointclouds/${id}`, {method: "DELETE"});
    },
    pointCloudOctreeAccessUrl(id) {
        return request(`/api/pointclouds/${id}/octree-access-url`);
    },
    pointCloudDownloadAccessUrl(id) {
        return request(`/api/pointclouds/${id}/download-access-url`);
    },
    listPointCloudAccess(id) {
        return request(`/api/pointclouds/${id}/access`);
    },
    grantPointCloudAccess(id, userId, canDownload) {
        return request(`/api/pointclouds/${id}/access`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({user_id: userId, can_download: !!canDownload}),
        });
    },
    revokePointCloudAccess(id, userId) {
        return request(`/api/pointclouds/${id}/access/${userId}`, {method: "DELETE"});
    },

    // users (admin)
    listUsers() {
        return request("/api/users");
    },
    createUser(payload) {
        return request("/api/users", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload),
        });
    },
    updateUser(id, payload) {
        return request(`/api/users/${id}`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload),
        });
    },
    deleteUser(id) {
        return request(`/api/users/${id}`, {method: "DELETE"});
    },
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
    const choose = (pref) => {
        setThemePref(pref);
        sync();
    };
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
    // Brand from the cache if there is one; on the very first visit it stays invisible until the
    // server's branding arrives (applyBranding), so the default name never flashes.
    const cachedBrand = getCachedBranding();
    const brandInner = railBrandHtml(cachedBrand || DEFAULT_BRANDING);
    const brandAttrs = cachedBrand ? ` data-sig='${brandSignature(cachedBrand).replace(/'/g, "&#39;")}'` : " data-pending";
    if (cachedBrand) setTitleName(cachedBrand.app_name);
    if (role !== "guest") {
        const navItems = [{href: "/index.html", label: "Gallery", key: "gallery"}];
        if (role === "editor" || role === "admin") {
            navItems.push({href: "/upload.html", label: "Upload", key: "upload"});
        }
        if (role === "admin") {
            navItems.push({href: "/admin.html", label: "Users", key: "admin"});
        }
        navItems.push({href: "/account.html", label: "Account", key: "account"});

        const nav = navItems
            .map(
                (item) =>
                    `<a href="${item.href}" class="${activePage === item.key ? "active" : ""}" title="${item.label}">
          <span class="nav-icon">${NAV_ICONS[item.key] || ""}</span>
          <span class="nav-label">${item.label}</span>
        </a>`
            )
            .join("");
        const isCollapsed = localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";

  return `
    <div class="rail${isCollapsed ? " collapsed" : ""}">
      <div class="rail-top">
        <div class="rail-id">
          <div class="brand"${brandAttrs}>${brandInner}</div>
          <div class="role-tag">${role}</div>
        </div>
        <button type="button" class="rail-collapse-btn" id="rail-collapse-btn" title="${isCollapsed ? "Expand sidebar" : "Minimize sidebar"}" aria-label="Toggle sidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
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
        <button id="logout-btn" title="Sign out" aria-label="Sign out">
          <svg class="logout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          <span class="logout-label">Sign out</span>
        </button>
      </div>
    </div>
  `;
    } else {
     return `
    <div class="rail collapsed">
      <div class="rail-top">
        <div class="rail-id">
          <div class="brand"${brandAttrs}>${brandInner}</div>
        </div>
      </div>
      <div class="rail-menu" id="rail-menu">
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
      </div>
    </div>
  `;
    }
}

export function wireLogout() {
  wireTheme(); // every page that renders the shell already calls this
  applyBranding();
  const rail = document.querySelector(".rail");
  const toggle = document.querySelector(".rail-toggle");
  if (rail && toggle) {
    toggle.addEventListener("click", () => {
      toggle.setAttribute("aria-expanded", String(rail.classList.toggle("open")));
    });
  }
  const collapseBtn = document.getElementById("rail-collapse-btn");
  if (rail && collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      const collapsed = rail.classList.toggle("collapsed");
      localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
      collapseBtn.title = collapsed ? "Expand sidebar" : "Minimize sidebar";
      // Notify 3D viewers (kiln-render, 3DHOP, Potree) after the width transition
      setTimeout(() => window.dispatchEvent(new Event("resize")), 220);
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