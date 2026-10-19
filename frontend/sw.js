// Service Worker for caching immutable OME-Zarr chunks across page loads
// (where the short-lived JWT in the URL path changes on every reload).

const CACHE_NAME = "vg-zarr-chunks-v1";
// Match /api/volumes/{id}/dataset.ome.zarr/{token}/{path}
const ZARR_URL_RE = /^\/api\/volumes\/(\d+)\/dataset\.ome\.zarr\/[^/]+\/(.+)$/;

// Maps volumeId (string) -> version hash supplied by zarr-access-url
const volumeVersions = new Map();

// Eviction hysteresis: evict oldest entries when storage exceeds high-water mark
const MAX_CACHE_BYTES_FALLBACK = 512 * 1024 * 1024; // 512 MB fallback if estimate() unavailable
const QUOTA_FRACTION_LIMIT = 0.5;
let opsSinceCheck = 0;
let evictionInFlight = null;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "SET_VOLUME_VERSION" && data.volumeId != null && data.version) {
    const volId = String(data.volumeId);
    const prev = volumeVersions.get(volId);
    volumeVersions.set(volId, String(data.version));
    if (prev && prev !== String(data.version)) {
      event.waitUntil(purgeVolumeStaleVersions(volId, String(data.version)));
    }
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ ok: true });
    }
  } else if (data.type === "CLEAR_ZARR_CACHE") {
    volumeVersions.clear();
    event.waitUntil(caches.delete(CACHE_NAME));
  }
});

async function purgeVolumeStaleVersions(volumeId, keepVersion) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const prefix = `${self.location.origin}/__vg_zarr_cache__/v/${volumeId}/`;
    const keepPrefix = `${prefix}${keepVersion}/`;
    await Promise.all(
      keys
        .filter((req) => req.url.startsWith(prefix) && !req.url.startsWith(keepPrefix))
        .map((req) => cache.delete(req))
    );
  } catch (_) {}
}

async function maybeEvict() {
  if (++opsSinceCheck < 50) return;
  opsSinceCheck = 0;
  if (evictionInFlight) return evictionInFlight;

  evictionInFlight = (async () => {
    try {
      let overLimit = false;
      if (navigator.storage && navigator.storage.estimate) {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        const cap = quota > 0 ? Math.min(quota * QUOTA_FRACTION_LIMIT, 2 * 1024 * 1024 * 1024) : MAX_CACHE_BYTES_FALLBACK;
        overLimit = usage > cap;
      }
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      if (overLimit || keys.length > 8000) {
        // Delete oldest ~20% of cached chunk entries (Cache API keys() returns insertion order)
        const removeCount = Math.max(1, Math.floor(keys.length * 0.2));
        for (let i = 0; i < removeCount; i++) {
          await cache.delete(keys[i]);
        }
      }
    } catch (_) {
    } finally {
      evictionInFlight = null;
    }
  })();
  return evictionInFlight;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // Do not cache partial range requests; regular Zarr v3 chunks are full-object GETs
  if (req.headers.has("Range")) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const m = ZARR_URL_RE.exec(url.pathname);
  if (!m) return;

  const volumeId = m[1];
  const innerPath = m[2];

  // Never cache root zarr.json or .zattrs (network-first: rewritten dynamically when min_lod changes)
  if (!innerPath.includes("/") && (innerPath === "zarr.json" || innerPath === ".zattrs")) {
    return;
  }

  const ver = volumeVersions.get(volumeId) || url.searchParams.get("v") || "default";
  const cacheKeyUrl = `${self.location.origin}/__vg_zarr_cache__/v/${volumeId}/${ver}/${innerPath}`;
  const cacheKeyReq = new Request(cacheKeyUrl, { method: "GET" });

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(cacheKeyReq);
      if (hit) return hit;

      const resp = await fetch(req);
      if (resp.status === 200) {
        cache.put(cacheKeyReq, resp.clone()).then(() => maybeEvict()).catch(() => {});
      }
      return resp;
