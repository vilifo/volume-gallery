// The viewer's side of loading a volume's data: the brick cache worker and the "session expired" notice.
//
// Cache: js/sw.js keeps bricks in the browser between page loads (see the comment there).
// startBrickCache() registers it and waits until it controls this page, so the bricks of the very
// first load are cached too. Without service worker support, or if registering fails, the viewer
// just loads everything from the server as before.
//
// Expiry: the data URLs carry a short-lived signed token (see volume-data-access-url). When it
// runs out the server answers every further brick request with 403, and kiln-render treats that like
// a missing brick: no error, the view just stops filling in. watchDataAccess() notices those 403s
// (kiln fetches on the main thread, so a wrapper around window.fetch sees them, including the 403s
// the worker answers with for a token the server no longer accepts) and asks the user to reload,
// which gets a fresh token.

const DATASET_PATH = "/dataset/";

let watchedVolume = null;
let installed = false;
let dialogOpen = false;
let dismissed = false; // "Not now": stay quiet until a fresh token arrives or the page reloads
let cacheStarted = null;

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves true once the worker controls the page, false if that is not going to happen (no
// support, registration failed, or it took too long: the viewer must never wait on the cache).
export function startBrickCache() {
  if (cacheStarted) return cacheStarted;
  cacheStarted = (async () => {
    if (!("serviceWorker" in navigator)) return false;
    try {
      await navigator.serviceWorker.register("/js/sw.js", { scope: "/" });
      await Promise.race([navigator.serviceWorker.ready, timeout(4000)]);
      if (navigator.serviceWorker.controller) return true;
      // First visit: the worker is active but only takes over this page a moment later.
      await Promise.race([
        new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
        timeout(1500),
      ]);
      return Boolean(navigator.serviceWorker.controller);
    } catch (err) {
      console.warn("Brick cache unavailable:", err);
      return false;
    }
  })();
  return cacheStarted;
}

function showReloadDialog() {
  if (dialogOpen || dismissed) return;
  dialogOpen = true;
  const previouslyFocused = document.activeElement;
  // In browser fullscreen only the fullscreen element is visible, so the dialog goes inside it.
  const host = document.fullscreenElement || document.body;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "data-access-dialog";
  backdrop.innerHTML = `
    <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="data-access-title" aria-describedby="data-access-text" tabindex="-1">
      <h2 id="data-access-title">Session expired</h2>
      <p id="data-access-text">Access to this volume\u2019s data has expired, so no more of it can be loaded and parts of the view may stay empty. Reload the page to get fresh access.</p>
      <div class="modal-actions">
        <button type="button" id="data-access-later">Not now</button>
        <button type="button" class="primary" id="data-access-reload">Reload page</button>
      </div>
    </div>`;
  host.appendChild(backdrop);
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    dialogOpen = false;
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { dismissed = true; close(); }
  };
  document.addEventListener("keydown", onKey, true);
  backdrop.querySelector("#data-access-reload").addEventListener("click", () => window.location.reload());
  backdrop.querySelector("#data-access-later").addEventListener("click", () => { dismissed = true; close(); });
  backdrop.querySelector("#data-access-reload").focus();
}

function isThisVolumesData(url) {
  try {
    const path = new URL(url, window.location.href).pathname;
    return path.startsWith(`/api/volumes/${watchedVolume}${DATASET_PATH}`);
  } catch (_) {
    return false;
  }
}

// Starts watching. Call once per page, with the id of the volume being viewed.
export function watchDataAccess(volumeId) {
  watchedVolume = String(volumeId);
  if (installed) return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (response.status === 403) {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && isThisVolumesData(url)) showReloadDialog();
    }
    return response;
  };
}

// A new access token was obtained (the viewer was rebuilt): allow the dialog again.
export function resetDataAccessWatch() {
  dismissed = false;
}
