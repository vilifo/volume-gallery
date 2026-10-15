// Fetches finished planes from the server (see backend/app/helpers/slices.py).
//
//   * one request per plane; the browser decodes zstd Content-Encoding itself
//   * identical requests are shared; a request nobody waits for any more is aborted
//     ("latest wins" while dragging a crosshair)
//   * decoded planes are kept in a byte-budgeted LRU
//   * foreground requests run before prefetches; at most `maxInflight` at a time
//
// The renderer and panes only depend on `get()` / `prefetch()` / `peek()`, so the
// transport can be swapped without touching them.

import { textureFormatFor } from "./geometry.js";

export class PlaneError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "PlaneError";
    this.status = status;
  }
}

const keyOf = (axis, index, channel, stride) => `${axis}/${index}/${channel}/${stride}`;

export class PlaneClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   ".../slices/<token>/" (ends with "/")
   * @param {Function} [o.fetchFn]
   * @param {() => Promise<string>} [o.refreshUrl]  returns a new baseUrl when the token expired (403)
   */
  constructor({ baseUrl, fetchFn = (...a) => fetch(...a), refreshUrl = null, maxCacheBytes = 384e6, maxInflight = 6 }) {
    this.baseUrl = baseUrl;
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

  async _run(job) {
    const { axis, index, channel, stride } = job;
    const t0 = performance.now();
    try {
      const qs = new URLSearchParams();
      if (channel) qs.set("channel", String(channel));
      if (stride !== 1) qs.set("stride", String(stride));
      const res = await this._request(`${axis}/${index}${qs.size ? `?${qs}` : ""}`, job.controller.signal);
      const buf = await res.arrayBuffer();
      const dtype = res.headers.get("X-Plane-Dtype");
      const fmt = textureFormatFor(dtype);
      if (!fmt) throw new PlaneError(`Unsupported plane data type ${dtype}`);
      const width = parseInt(res.headers.get("X-Plane-Width"), 10);
      const height = parseInt(res.headers.get("X-Plane-Height"), 10);
      const data = new fmt.array(buf);
      if (data.length !== width * height) throw new PlaneError("Plane size does not match its headers");
      const plane = {
        axis, index, channel, stride, width, height, dtype, data,
        serverMs: parseFloat(res.headers.get("X-Plane-Server-Ms") ?? "0"),
        source: res.headers.get("X-Plane-Source") ?? "",
      };
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
