// Service worker: keeps a volume's bricks in the browser between page loads.
//
// kiln-render reads a volume with one Range request per brick into lodN.bin (plus lodN_index.json),
// all under /api/volumes/{id}/dataset/{token}/. The token in that URL is short-lived and different on
// every page load, so the browser's own HTTP cache never gets a hit (and it does not store partial
// responses anyway). This worker stores what it fetches under a key made of the volume, its version
// and the file + byte range instead, so a reload is served from disk.
//
// What is stored: lodN.bin ranges (the 206 is kept as a plain 200 entry and rebuilt on a hit) and
// lodN_index.json. volume.json is never touched: the server rewrites it per token (a share link's
// resolution cap), so every page load asks for it, and that request also proves the token is good.
//
// A cached brick is only handed out while the token that asks for it is accepted by the server:
// the first hit of a token (and then one every VERIFY_TTL_MS) re-asks the server about it, so a
// revoked share link or a disabled account stops working here too, as it does for the network path.

const CACHE_NAME = "vg-brick-cache-v1";
const OLD_CACHES = ["vg-zarr-chunks-v1"]; // from the OME-Zarr days: unreadable now, so deleted on activation

// /api/volumes/{id}/dataset/{token}/{lodN.bin | lodN_index.json}
const URL_RE = /^\/api\/volumes\/(\d+)\/dataset\/([^/]+)\/(lod(\d+)\.bin|lod(\d+)_index\.json)$/;

const VERIFY_TTL_MS = 45 * 1000;
const MAX_ENTRIES = 40000;
const MAX_CACHE_BYTES_FALLBACK = 512 * 1024 * 1024; // when storage.estimate() is unavailable
const QUOTA_FRACTION_LIMIT = 0.5;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        await Promise.all(OLD_CACHES.map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

// The page asks for this on sign-out: what is cached belongs to whoever was signed in.
self.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.type === "CLEAR_BRICK_CACHE") {
        verified.clear();
        entryCount = null;
        event.waitUntil(caches.delete(CACHE_NAME));
    }
});

// The token is a JWT; its payload says which volume version the bricks belong to (ver), how far
// down the share link allows (min_lod) and when it runs out (exp). Reading it here is only for
// choosing a cache key and skipping hopeless requests: the server is the one that checks it.
function claimsOf(token) {
    try {
        const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    } catch (_) {
        return null;
    }
}

function keyFor(volumeId, ver, file, range) {
    const suffix = range ? `?r=${range[0]}-${range[1]}` : "";
    return new Request(`${self.location.origin}/__vg_bricks__/${volumeId}/${ver}/${file}${suffix}`);
}

// ---- is this token still accepted by the server? ----

const verified = new Map();  // token -> time (ms) until which it counts as accepted
const inflight = new Map();  // token -> pending check, shared by concurrent requests

function markValid(token) {
    const now = Date.now();
    verified.set(token, now + VERIFY_TTL_MS);
    if (verified.size > 500) {
        for (const [t, until] of verified) if (until <= now) verified.delete(t);
    }
}

// true: accepted; false: refused (revoked, expired, volume gone); null: could not ask (offline)
function tokenStillValid(volumeId, token) {
    const until = verified.get(token);
    if (until && until > Date.now()) return Promise.resolve(true);
    let pending = inflight.get(token);
    if (!pending) {
        pending = (async () => {
            try {
                const r = await fetch(`/api/volumes/${volumeId}/dataset/${token}/volume.json`, {cache: "no-store"});
                if (r.ok) {
                    markValid(token);
                    return true;
                }
                if (r.status === 401 || r.status === 403 || r.status === 404) {
                    verified.delete(token);
                    return false;
                }
                return null;
            } catch (_) {
                return null;
            } finally {
                inflight.delete(token);
            }
        })();
        inflight.set(token, pending);
    }
    return pending;
}

// ---- the cache ----

let opsSinceCheck = 0;
let entryCount = null; // entries in the cache; counted once, then tracked
let evictionInFlight = null;

// Oldest entries go first when the cache gets too big (cache.keys() lists them in insertion order).
async function maybeEvict() {
    if (++opsSinceCheck < 50) return;
    opsSinceCheck = 0;
    if (evictionInFlight) return evictionInFlight;
    evictionInFlight = (async () => {
        try {
            let overLimit = false;
            if (navigator.storage && navigator.storage.estimate) {
                const {usage = 0, quota = 0} = await navigator.storage.estimate();
                const cap = quota > 0 ? Math.min(quota * QUOTA_FRACTION_LIMIT, MAX_CACHE_BYTES) : MAX_CACHE_BYTES_FALLBACK;
                overLimit = usage > cap;
            }
            // cache.keys() walks every entry, so it only runs to count them the first time
            // or when a limit has been hit.
            if (!overLimit && entryCount !== null && entryCount <= MAX_ENTRIES) return;
            const cache = await caches.open(CACHE_NAME);
            const keys = await cache.keys();
            entryCount = keys.length;
            if (overLimit || keys.length > MAX_ENTRIES) {
                const removeCount = Math.max(1, Math.floor(keys.length * 0.2));
                for (let i = 0; i < removeCount; i++) await cache.delete(keys[i]);
                entryCount -= removeCount;
            }
        } catch (_) {
        } finally {
            evictionInFlight = null;
        }
    })();
    return evictionInFlight;
}

// Keeps a network response if it is exactly what was asked for. A 206 is stored as a 200 (the Cache
// API refuses partial responses); the total size of the file rides along for the Content-Range.
async function store(cache, key, resp, range) {
    const headers = new Headers({"Content-Type": resp.headers.get("Content-Type") || "application/octet-stream"});
    if (range) {
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(resp.headers.get("Content-Range") || "");
        if (resp.status !== 206 || !m || Number(m[1]) !== range[0] || Number(m[2]) !== range[1]) return;
        headers.set("X-VG-Total", m[3]);
    } else if (resp.status !== 200) {
        return;
    }
    await cache.put(key, new Response(resp.body, {status: 200, headers}));
    if (entryCount !== null) entryCount++;
    await maybeEvict();
}

function fromCache(hit, range) {
    if (!range) return hit;
    return new Response(hit.body, {
        status: 206,
        headers: {
            "Content-Type": hit.headers.get("Content-Type") || "application/octet-stream",
            "Content-Range": `bytes ${range[0]}-${range[1]}/${hit.headers.get("X-VG-Total") || "*"}`,
            "Content-Length": String(range[1] - range[0] + 1),
            "Accept-Ranges": "bytes",
        },
    });
}

async function handle(event, req, {volumeId, token, file, range, ver}) {
    const cache = await caches.open(CACHE_NAME);
    const key = keyFor(volumeId, ver, file, range);

    const hit = await cache.match(key);
    if (hit) {
        const accepted = await tokenStillValid(volumeId, token);
        if (accepted === false) {
            // what the server itself answers for a token it no longer accepts
            return new Response(JSON.stringify({detail: "Invalid or expired link"}), {
                status: 403, statusText: "Forbidden", headers: {"Content-Type": "application/json"},
            });
        }
        return fromCache(hit, range); // accepted, or the server could not be reached: the bytes are already here
    }

    const resp = await fetch(req);
    if (resp.status === 200 || resp.status === 206) markValid(token);
    else if (resp.status === 403) verified.delete(token);
    if (resp.status === 200 || resp.status === 206) {
        event.waitUntil(store(cache, key, resp.clone(), range).catch(() => {}));
    }
    return resp;
}

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    const m = URL_RE.exec(url.pathname);
    if (!m) return;
    const [, volumeId, token, file] = m;
    const lod = Number(m[4] !== undefined ? m[4] : m[5]);

    // A brick is requested as exactly "bytes=start-end"; anything else (whole file, open-ended or
    // several ranges) goes to the network untouched, as does an index request with a Range.
    let range = null;
    const rangeHeader = req.headers.get("Range");
    if (file.endsWith(".bin")) {
        const r = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader || "");
        if (!r || Number(r[2]) < Number(r[1])) return;
        range = [Number(r[1]), Number(r[2])];
    } else if (rangeHeader) {
        return;
    }

    const claims = claimsOf(token);
    if (!claims || !/^[0-9a-f]{8,64}$/.test(String(claims.ver || ""))) return; // no version, no key
    if (claims.exp && claims.exp * 1000 < Date.now()) return;                   // expired: let the server say so
    if (lod < (claims.min_lod || 0)) return;                                    // below the share's cap: the server refuses it

    event.respondWith(handle(event, req, {volumeId, token, file, range, ver: claims.ver}));
});
