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
  // fetch has no stable cross-browser API for tracking request-body upload
  // progress, only response-download progress. onProgress(fraction 0..1)
  // fires as bytes actually leave the browser; it does NOT track server-side
  // processing (that's what /status polling is for, since processing now
  // happens in a background task after this request already returned).
  createVolumeWithProgress(formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/volumes");
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
  },
  getVolumeStatus(id) { return request(`/api/volumes/${id}/status`); },
  deleteVolume(id) { return request(`/api/volumes/${id}`, { method: "DELETE" }); },
  uploadMesh(id, formData) {
    return request(`/api/volumes/${id}/mesh`, { method: "POST", body: formData });
  },
  zarrAccessUrl(id) { return request(`/api/volumes/${id}/zarr-access-url`); },
  meshAccessUrl(id) { return request(`/api/volumes/${id}/mesh-access-url`); },
  listAccess(id) { return request(`/api/volumes/${id}/access`); },
  grantAccess(id, userId) {
    return request(`/api/volumes/${id}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
  },
  revokeAccess(id, userId) {
    return request(`/api/volumes/${id}/access/${userId}`, { method: "DELETE" });
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
    navItems.push({ href: "/upload.html", label: "Upload volume", key: "upload" });
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