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

export function requireLogin() {
  if (!getToken()) {
    window.location.href = "/login.html";
  }
}

async function request(path, options = {}) {
  const headers = options.headers || {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearSession();
    window.location.href = "/login.html";
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
        window.location.href = "/login.html";
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

  // volumes
  listVolumes() { return request("/api/volumes"); },
  getVolume(id) { return request(`/api/volumes/${id}`); },
  createVolume(formData) {
    return request("/api/volumes", { method: "POST", body: formData });
  },
  // XHR-based (not fetch) specifically to get real upload-progress events —
  // see _uploadWithProgress above for why.
  createVolumeWithProgress(formData, onProgress) {
    return _uploadWithProgress("/api/volumes", formData, onProgress);
  },
  getVolumeStatus(id) { return request(`/api/volumes/${id}/status`); },
  deleteVolume(id) { return request(`/api/volumes/${id}`, { method: "DELETE" }); },
  uploadMesh(id, formData) {
    return request(`/api/volumes/${id}/mesh`, { method: "POST", body: formData });
  },
  zarrAccessUrl(id, minLevel) {
    const qs = minLevel != null ? `?min_level=${encodeURIComponent(minLevel)}` : "";
    return request(`/api/volumes/${id}/zarr-access-url${qs}`);
  },
  meshAccessUrl(id) { return request(`/api/volumes/${id}/mesh-access-url`); },
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
  volumeDownloadAccessUrl(id) { return request(`/api/volumes/${id}/download-access-url`); },

  // meshes
  listMeshes() { return request("/api/meshes"); },
  getMesh(id) { return request(`/api/meshes/${id}`); },
  getMeshStatus(id) { return request(`/api/meshes/${id}/status`); },
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
  getPointCloudStatus(id) { return request(`/api/pointclouds/${id}/status`); },
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

export function renderShell(activePage, role, username) {
  const navItems = [{ href: "/index.html", label: "Gallery", key: "gallery" }];
  if (role === "editor" || role === "admin") {
    navItems.push({ href: "/upload.html", label: "Upload", key: "upload" });
  }
  if (role === "admin") {
    navItems.push({ href: "/admin.html", label: "Users", key: "admin" });
  }
  const nav = navItems
    .map(
      (item) =>
        `<a href="${item.href}" class="${item.key === activePage ? "active" : ""}">${item.label}</a>`
    )
    .join("");
  return `
    <div class="rail">
      <div class="brand">Volume Gallery</div>
      <div class="role-tag">${role}</div>
      <nav>${nav}</nav>
      <div class="spacer"></div>
      <div class="signed-in-as">Signed in as <strong>${username}</strong></div>
      <button id="logout-btn">Sign out</button>
    </div>
  `;
}

export function wireLogout() {
  const btn = document.getElementById("logout-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      clearSession();
      window.location.href = "/login.html";
    });
  }
}