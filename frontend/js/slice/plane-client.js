// Fetches finished planes from the server (see backend/app/helpers/slices.py).
//
//   * one request per plane; planes are raw unless a one-time probe shows that this
//     browser/connection really decodes `Content-Encoding: zstd` (see _useZstd)
//   * identical requests are shared; a request nobody waits for any more is aborted
//     ("latest wins" while dragging a crosshair)
//   * decoded planes are kept in a byte-budgeted LRU
//   * foreground requests run before prefetches; at most `maxInflight` at a time
//
// The renderer and panes only depend on `get()` / `prefetch()` / `peek()`, so the
// transport can be swapped without touching them.

import { textureFormatFor } from "./geometry.js";

export class PlaneError extends Error {
  constructor(message, status = 0, { sizeMismatch = false } = {}) {
    super(message);
    this.name = "PlaneError";
    this.status = status;
    this.sizeMismatch = sizeMismatch;
  }
}

const keyOf = (axis, index, channel, stride) => `${axis}/${index}/${channel}/${stride}`;

export class PlaneClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   ".../slices/<token>/" (ends with "/")
   * @param {Function} [o.fetchFn]
   * @param {() => Promise<string>} [o.refreshUrl]  returns a new baseUrl when the token expired (403)
   * @param {"auto"|"on"|"off"} [o.compression]  "auto" (default): ask for zstd only after the probe
   *  proved that this connection decodes it; "off": always raw; "on": always zstd (falls back
   *  to raw if a response turns out to be undecoded)
   */
  constructor({ baseUrl, fetchFn = (...a) => fetch(...a), refreshUrl = null, maxCacheBytes = 384e6, maxInflight = 6, compression = "auto" }) {
    this.baseUrl = baseUrl;
    this.compression = compression;
    this._zstd = compression === "on";
    this._probe = null;
    this.fetchFn = fetchFn;
    this.refreshUrl = refreshUrl;
    this.maxCacheBytes = maxCacheBytes;
    this.maxInflight = maxInflight;
    this._cache = new Map();
    this._cacheBytes = 0;
    this._jobs = new Map();
    this._queue = [];
    this._running = 0;
    this._info = null;
    this._disposed = false;
    this.counters = { hits: 0, fetches: 0, aborted: 0, lastMs: 0, lastServerMs: 0, lastSource: "" };
  }

  async info() {
    this._info ??= this._request("info").then((r) => r.json());
    try {
      return await this._info;
    } catch (err) {
      this._info = null;
      throw err;
    }
  }

  peek(axis, index, channel = 0, stride = 1) {
    const k = keyOf(axis, index, channel, stride);
    const p = this._cache.get(k);
    if (p) {
      this._cache.delete(k);
      this._cache.set(k, p); // LRU touch
    }
    return p ?? null;
  }

  /**
   * @returns {Promise<{axis, index, channel, stride, width, height, dtype, data: ArrayBufferView, serverMs, source}>}
   */
  get(axis, index, { channel = 0, stride = 1, priority = 1, signal } = {}) {
    const hit = this.peek(axis, index, channel, stride);
    if (hit) {
      this.counters.hits++;
      return Promise.resolve(hit);
    }
    const job = this._job(axis, index, channel, stride, priority);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      job.waiters.add(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          if (!job.waiters.delete(waiter)) return;
          reject(new DOMException("aborted", "AbortError"));
          this._maybeCancel(job);
        },
        { once: true },
      );
      if (signal?.aborted) {
        job.waiters.delete(waiter);
        reject(new DOMException("aborted", "AbortError"));
        this._maybeCancel(job);
      }
    });
  }

  /** Low-priority warm-up; never throws, never blocks foreground requests. */
  prefetch(axis, indices, { channel = 0, stride = 1 } = {}) {
    for (const index of indices) {
      if (this._cache.has(keyOf(axis, index, channel, stride))) continue;
      const job = this._job(axis, index, channel, stride, 0);
      job.prefetch = true;
    }
  }

  stats() {
    return {
      planes: this._cache.size,
      cacheMB: +(this._cacheBytes / 1e6).toFixed(1),
      inflight: this._running,
      queued: this._queue.length,
      ...this.counters,
    };
  }

  dispose() {
    this._disposed = true;
    for (const job of this._jobs.values()) {
      job.controller.abort();
      for (const w of job.waiters) w.reject(new DOMException("disposed", "AbortError"));
    }
    this._jobs.clear();
    this._queue = [];
    this._cache.clear();
    this._cacheBytes = 0;
  }

  // ------------------------------------------------------------------ internals

  _job(axis, index, channel, stride, priority) {
    const key = keyOf(axis, index, channel, stride);
    let job = this._jobs.get(key);
    if (job) {
      if (priority > job.priority) {
        job.priority = priority;
        this._sortQueue();
      }
      return job;
    }
    job = {
      key, axis, index, channel, stride, priority, prefetch: false,
      waiters: new Set(), controller: new AbortController(), state: "queued", seq: this._seq = (this._seq ?? 0) + 1,
    };
    this._jobs.set(key, job);
    this._queue.push(job);
    this._sortQueue();
    this._pump();
    return job;
  }

  _sortQueue() {
    this._queue.sort((a, b) => b.priority - a.priority || b.seq - a.seq); // newest foreground request first
  }

  _maybeCancel(job) {
    if (job.waiters.size > 0 || job.prefetch) return;
    if (job.state === "queued") {
      this._queue = this._queue.filter((j) => j !== job);
      this._jobs.delete(job.key);
    } else {
      job.controller.abort();
    }
    this.counters.aborted++;
  }

  _pump() {
    while (!this._disposed && this._running < this.maxInflight && this._queue.length) {
      const job = this._queue.shift();
      job.state = "running";
      this._running++;
      this._run(job).finally(() => {
        this._running--;
        this._jobs.delete(job.key);
        this._pump();
      });
    }
  }

  async _request(path, signal) {
    let res = await this.fetchFn(this.baseUrl + path, { signal });
    if (res.status === 403 && this.refreshUrl) {
      this.baseUrl = await this.refreshUrl();
      res = await this.fetchFn(this.baseUrl + path, { signal });
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail ?? ""; } catch { /* not json */ }
      throw new PlaneError(detail || `HTTP ${res.status}`, res.status);
    }
    return res;
  }

  /**
   * Whether to request `enc=zstd`. A body sent with `Content-Encoding: zstd` is only usable if
   * fetch() decodes it; older embedded Chromium builds, proxies that drop the header and the like
   * hand over the compressed bytes (the "plane size does not match its headers" failure). So in
   * "auto" mode one tiny plane is fetched compressed first and its size checked; raw is the
   * fallback and is always correct.
   */
  _useZstd() {
    if (this.compression !== "auto") return Promise.resolve(this._zstd);
    this._probe ??= this._probeZstd();
    return this._probe;
  }

  async _probeZstd() {
    let ok = false;
    try {
      const res = await this._request("xy/0?stride=8&enc=zstd");
      const buf = await res.arrayBuffer();
      const fmt = textureFormatFor(res.headers.get("X-Plane-Dtype"));
      const w = parseInt(res.headers.get("X-Plane-Width"), 10);
      const h = parseInt(res.headers.get("X-Plane-Height"), 10);
      ok = !!fmt && buf.byteLength === w * h * fmt.bytes;
    } catch {
      ok = false;
    }
    this._zstd = ok;
    if (!ok) console.warn("[slice] compressed planes are not decoded on this connection; using raw planes");
    return ok;
  }

  _disableZstd() {
    if (this._zstd) console.warn("[slice] a compressed plane arrived undecoded; switching to raw planes");
    this._zstd = false;
    this.compression = "off";
  }

  /** One request for one plane; throws PlaneError{sizeMismatch} when the body does not fit its headers. */
  async _fetchPlane(job, zstd) {
    const { axis, index, channel, stride } = job;
    const qs = new URLSearchParams();
    if (channel) qs.set("channel", String(channel));
    if (stride !== 1) qs.set("stride", String(stride));
    if (zstd) qs.set("enc", "zstd");
    const res = await this._request(`${axis}/${index}${qs.size ? `?${qs}` : ""}`, job.controller.signal);
    const buf = await res.arrayBuffer();
    const dtype = res.headers.get("X-Plane-Dtype");
    const fmt = textureFormatFor(dtype);
    if (!fmt) throw new PlaneError(`Unsupported plane data type ${dtype}`);
    const width = parseInt(res.headers.get("X-Plane-Width"), 10);
    const height = parseInt(res.headers.get("X-Plane-Height"), 10);
    const expected = width * height * fmt.bytes;
    if (buf.byteLength !== expected) {
      throw new PlaneError(
        `Plane size does not match its headers: received ${buf.byteLength} bytes, expected ${expected} ` +
        `(${width}x${height} ${dtype}); Content-Encoding: ${res.headers.get("Content-Encoding") ?? "none"}, ` +
        `Content-Length: ${res.headers.get("Content-Length") ?? "?"}, requested ${zstd ? "zstd" : "raw"}`,
        0,
        { sizeMismatch: true },
      );
    }
    return {
      axis, index, channel, stride, width, height, dtype, data: new fmt.array(buf),
      serverMs: parseFloat(res.headers.get("X-Plane-Server-Ms") ?? "0"),
      source: res.headers.get("X-Plane-Source") ?? "",
    };
  }

  async _run(job) {
    const { axis, index, channel, stride } = job;
    const t0 = performance.now();
    try {
      const zstd = await this._useZstd();
      let plane;
      try {
        plane = await this._fetchPlane(job, zstd);
      } catch (err) {
        if (!(err?.sizeMismatch && zstd)) throw err;
        this._disableZstd(); // compressed bytes came through undecoded: retry this plane raw
        plane = await this._fetchPlane(job, false);
      }
      this.counters.fetches++;
      this.counters.lastMs = performance.now() - t0;
      this.counters.lastServerMs = plane.serverMs;
      this.counters.lastSource = plane.source;
      this._store(job.key, plane);
      for (const w of job.waiters) w.resolve(plane);
    } catch (err) {
      const aborted = err?.name === "AbortError";
      for (const w of job.waiters) w.reject(aborted ? new DOMException("aborted", "AbortError") : err);
      if (!aborted && !job.prefetch) console.warn("[slice] plane request failed:", err);
    } finally {
      job.waiters.clear();
    }
  }

  _store(key, plane) {
    const bytes = plane.data.byteLength;
    if (bytes > this.maxCacheBytes) return;
    this._cache.set(key, plane);
    this._cacheBytes += bytes;
    for (const [k, p] of this._cache) {
      if (this._cacheBytes <= this.maxCacheBytes) break;
      if (k === key) continue;
      this._cache.delete(k);
      this._cacheBytes -= p.data.byteLength;
    }
  }
}

/**
 * Prefetch plan around the plane being shown: a few planes ahead in the scroll
 * direction, one behind, and the first plane of the next slab when the cursor
 * is about to cross a chunk boundary (that is when the server decodes a new slab).
 */
export function prefetchIndices(index, dir, size, chunk, { ahead = 4, behind = 1, boundaryMargin = 6 } = {}) {
  const out = [];
  const d = dir >= 0 ? 1 : -1;
  for (let i = 1; i <= ahead; i++) out.push(index + d * i);
  for (let i = 1; i <= behind; i++) out.push(index - d * i);
  const local = index % chunk;
  if (d > 0 && chunk - 1 - local <= boundaryMargin) out.push((Math.floor(index / chunk) + 1) * chunk);
  if (d < 0 && local <= boundaryMargin) out.push(Math.floor(index / chunk) * chunk - 1);
  return [...new Set(out)].filter((i) => i >= 0 && i < size);
}
