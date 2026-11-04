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
//
// Renewal without a reload: the token is a path segment of every brick URL, so setDataAccess() lets the
// page hand over a function that gets a fresh one. The wrapper renews it in good time (at three quarters
// of its life), puts the newest token into the URL of every brick request, and when a request is refused
// anyway it renews and repeats that request once. The dialog (and the expiry listeners) only come into
// play if renewing fails. Nothing is rebuilt: the view keeps running, which is what a screen that plays
// for hours needs.

const DATASET_PATH = "/dataset/";

let watchedVolume = null;
let installed = false;
let dialogOpen = false;
let dismissed = false; // "Not now": stay quiet until a fresh token arrives or the page reloads
let cacheStarted = null;
const expiredListeners = new Set();

// The newest token and how to get another (see setDataAccess)
const DATASET_URL = /^(\/api\/volumes\/\d+\/dataset\/)([^/]+)(.*)$/;
let currentToken = null;
let tokenExpiresAt = null;
let tokenTtlMs = 0;
let renewer = null;
let renewing = null;
let renewTimer = null;

/**
 * Registers a function to call whenever a brick request of the watched volume is refused (the access
 * token ran out). While at least one is registered the "Session expired" dialog is not shown: whoever
 * registered takes care of renewing access (an animation being rendered does). Returns a function that
 * unregisters it.
 */
export function onDataAccessExpired(listener) {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
}

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

function tokenOf(url) {
  try {
    const match = DATASET_URL.exec(new URL(url, window.location.href).pathname);
    return match ? match[2] : null;
  } catch (_) {
    return null;
  }
}

function withToken(url, token) {
  const u = new URL(url, window.location.href);
  const match = DATASET_URL.exec(u.pathname);
  if (!match || match[2] === token) return url;
  u.pathname = `${match[1]}${token}${match[3]}`;
  return u.toString();
}

function urlOf(input) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || "";
}

function retarget(input, url) {
  if (typeof input === "string") return url;
  if (input instanceof URL) return new URL(url);
  return new Request(url, input);
}

/** When the current token runs out (ms timestamp), or null when unknown. */
export const dataAccessExpiresAt = () => tokenExpiresAt;
/** The life of a token in ms (0 when unknown). */
export const dataAccessTtlMs = () => tokenTtlMs;

/**
 * Tells the wrapper which token is in use and how to get a fresh one.
 * @param {{url: string, ttlMs: number, renew: () => Promise<string>}} o  `url`: the data URL the viewer was given;
 *   `renew` resolves with a new data URL (same volume and same detail levels)
 */
export function setDataAccess({ url, ttlMs, renew }) {
  currentToken = tokenOf(url);
  renewer = renew;
  tokenTtlMs = ttlMs || 0;
  tokenExpiresAt = tokenTtlMs ? Date.now() + tokenTtlMs : null;
  scheduleRenewal();
}

function scheduleRenewal(delayMs) {
  clearTimeout(renewTimer);
  if (!renewer || !tokenTtlMs) return;
  const delay = delayMs ?? Math.max(5000, tokenExpiresAt - Date.now() - tokenTtlMs * 0.25);
  renewTimer = setTimeout(() => { renewNow(); }, delay);
}

// One renewal at a time; everybody who needs one waits for the same. Resolves with the new token, or null.
function renewNow() {
  if (!renewer) return Promise.resolve(null);
  if (!renewing) {
    renewing = (async () => {
      try {
        const url = await renewer();
        currentToken = tokenOf(url) || currentToken;
        tokenExpiresAt = tokenTtlMs ? Date.now() + tokenTtlMs : null;
        dismissed = false;
        scheduleRenewal();
        return currentToken;
      } catch (err) {
        console.warn("Could not renew access to the volume data:", err);
        scheduleRenewal(15000); // try again shortly
        return null;
      } finally {
        renewing = null;
      }
    })();
  }
  return renewing;
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
    const ours = isThisVolumesData(urlOf(input));
    if (ours && currentToken) {
      const fixed = withToken(urlOf(input), currentToken); // always the newest token
      if (fixed !== urlOf(input)) input = retarget(input, fixed);
    }
    let response = await originalFetch(input, init);
    if (ours && response.status === 403 && renewer) {
      const fresh = await renewNow();
      if (fresh) {
        input = retarget(input, withToken(urlOf(input), fresh));
        response = await originalFetch(input, init);
      }
    }
    if (ours && response.status === 403) {
      if (expiredListeners.size) expiredListeners.forEach((fn) => { try { fn(); } catch (_) { /* a listener must not break loading */ } });
      else showReloadDialog();
    }
    return response;
  };
}

// A new access token was obtained (the viewer was rebuilt): allow the dialog again.
export function resetDataAccessWatch() {
  dismissed = false;
}
