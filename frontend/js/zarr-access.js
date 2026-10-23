// Tells the user when the volume's data access link has expired.
//
// The chunk URLs carry a short-lived signed token (see volume-data-access-url). When it expires the
// server answers every further chunk request with 403, and kiln-render treats that like a
// missing brick: no error, the view just stops filling in. This module notices those 403s and
// asks the user to reload the page, which fetches a fresh token.
//
// Two sources, both reporting to the same dialog:
//   * the service worker (js/sw.js), which sees every chunk request, including the ones made
//     inside kiln's web workers, and posts {type: "ZARR_ACCESS_DENIED", volumeId};
//   * a wrapper around window.fetch, for requests the page makes itself (covers browsers where
//     the service worker is unavailable).

const ZARR_PATH = "/dataset.ome.zarr/";

let watchedVolume = null;
let installed = false;
let dialogOpen = false;
let dismissed = false; // "Not now": stay quiet until a fresh token arrives or the page reloads

function showReloadDialog() {
  if (dialogOpen || dismissed) return;
  dialogOpen = true;
  const previouslyFocused = document.activeElement;
  // In browser fullscreen only the fullscreen element is visible, so the dialog goes inside it.
  const host = document.fullscreenElement || document.body;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "zarr-access-dialog";
  backdrop.innerHTML = `
    <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="zarr-access-title" aria-describedby="zarr-access-text" tabindex="-1">
      <h2 id="zarr-access-title">Session expired</h2>
      <p id="zarr-access-text">Access to this volume\u2019s data has expired, so no more of it can be loaded and parts of the view may stay empty. Reload the page to get fresh access.</p>
      <div class="modal-actions">
        <button type="button" id="zarr-access-later">Not now</button>
        <button type="button" class="primary" id="zarr-access-reload">Reload page</button>
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
  backdrop.querySelector("#zarr-access-reload").addEventListener("click", () => window.location.reload());
  backdrop.querySelector("#zarr-access-later").addEventListener("click", () => { dismissed = true; close(); });
  backdrop.querySelector("#zarr-access-reload").focus();
}

function isThisVolumesChunk(url) {
  try {
    const path = new URL(url, window.location.href).pathname;
    return path.startsWith(`/api/volumes/${watchedVolume}${ZARR_PATH}`);
  } catch (_) {
    return false;
  }
}

// Starts watching. Call once per page, with the id of the volume being viewed.
export function watchZarrAccess(volumeId) {
  watchedVolume = String(volumeId);
  if (installed) return;
  installed = true;

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const d = event.data;
      if (d && d.type === "ZARR_ACCESS_DENIED" && String(d.volumeId) === watchedVolume) showReloadDialog();
    });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (response.status === 403) {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && isThisVolumesChunk(url)) showReloadDialog();
    }
    return response;
  };
}

// A new access token was obtained (the viewer was rebuilt): allow the dialog again.
export function resetZarrAccessWatch() {
  dismissed = false;
}
