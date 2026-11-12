// The slice views' plane loader that runs off the main thread: one worker per pane (xy, xz, yz; slice-worker.js),
// all three reading and writing the same block cache (block-cache.js, in a SharedArrayBuffer). Same interface as
// PlaneClient (plane-client.js), so slice-views.js does not care which one it has:
//
//   info(), loadPlane(spec, opts), prefetchPlane(spec, opts), stats(), dispose()
//
// Differences: `opts.axis` ("xy" | "xz" | "yz": the pane asking) picks the worker; the `assembler` that loadPlane
// hands to onUpdate and resolves with is a RemoteAssembler, a copy of the worker's image that this thread keeps
// up to date from the rows the worker sends; and a pane tells setShown() which image it shows, so the worker can
// start the next one from it (the "underlay").
//
// SharedArrayBuffer needs a cross-origin isolated page (Cross-Origin-Opener-Policy: same-origin and
// Cross-Origin-Embedder-Policy: require-corp, set in nginx/nginx.conf.template). Where the page is not isolated
// (or a worker cannot be started) createPlaneClient() returns the plain PlaneClient and everything runs on the
// main thread as before.

import { PlaneClient, PlaneError } from "./plane-client.js?v=mpr2";
import { SharedBlockCache } from "./block-cache.js?v=mpr2";
import { textureFormatFor } from "./geometry.js";

const abortError = () => new DOMException("aborted", "AbortError");
const WORKER_URL = new URL("./slice-worker.js?v=mpr2", import.meta.url);
const SUM_KEYS = ["loads", "cached", "fetched", "bytes", "aborted"];
const LAST_KEYS = ["lastMs", "lastPlanMs", "lastServerPlanMs", "lastFirstMs", "lastBlocks"];

/** The image of a plane that a worker is building, as the pane needs it: the shape of PlaneAssembler's. */
export class RemoteAssembler {
  constructor(id, { width, height, dtype, buffer }) {
    const fmt = textureFormatFor(dtype);
    this.width = width;
    this.height = height;
    this.data = new fmt.array(buffer);
    /** In the shape the renderer's upload() takes; `srcId` tells setShown() which image it is. */
    this.plane = { width, height, dtype, data: this.data, stride: 1, srcId: id };
    this.pending = 1;
    this.complete = false;
    this.dirty = null;
  }

  applyRows(r0, r1, buffer) {
    this.data.set(new this.data.constructor(buffer), r0 * this.width);
    if (!this.dirty) this.dirty = { r0, r1 };
    else {
      this.dirty.r0 = Math.min(this.dirty.r0, r0);
      this.dirty.r1 = Math.max(this.dirty.r1, r1);
    }
  }

  /** Rows [r0, r1] changed since the last call, or null. */
  takeDirty() {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }
}

export class WorkerPlaneClient {
  /**
   * @param {object} o
   * @param {PlaneClient} o.meta   a PlaneClient that has fetched /info (it keeps asking for it, and renews the token)
   * @param {SharedBlockCache} o.cache
   * @param {() => Promise<string>} o.refreshUrl
   */
  constructor({ meta, cache, refreshUrl, maxInflight = 2 }) {
    this.meta = meta;
    this.cache = cache; // (this thread only reads its stats)
    this.baseUrl = meta.baseUrl;
    this.maxInflight = maxInflight;
    this._refreshUrl = refreshUrl;
    this._refreshing = null;
    this._workers = new Map(); // axis -> Worker
    this._jobs = new Map();    // id -> { asm, onUpdate, resolve, reject, prefetch }
    this._seq = 0;
    this._disposed = false;
    this._stats = new Map();   // axis -> the worker's last counters
    this._last = {};
    this._fallback = false;    // a worker could not run: planes load on this thread (through `meta`) from now on
    meta.refreshUrl = () => this._renewUrl();
  }

  static supported() {
    return typeof Worker !== "undefined" && typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
  }

  info() {
    return this.meta.info();
  }

  loadPlane(spec, { axis = "xy", channel = 0, priority = 1, signal, underlay = null, onUpdate = null, prefetch = false } = {}) {
    if (this._fallback) return this.meta.loadPlane(spec, { channel, priority, signal, underlay, onUpdate, prefetch });
    return new Promise((resolve, reject) => {
      if (this._disposed || signal?.aborted) { reject(abortError()); return; }
      const id = ++this._seq;
      const worker = this._worker(axis);
      this._jobs.set(id, { asm: null, onUpdate, resolve, reject, prefetch, axis, redo: () => this.meta.loadPlane(spec, { channel, priority, signal, underlay, onUpdate, prefetch }) });
      signal?.addEventListener("abort", () => {
        if (!this._jobs.delete(id)) return;
        worker.postMessage({ type: "abort", id });
        reject(abortError());
      }, { once: true });
      worker.postMessage({ type: "load", id, spec, channel, priority, prefetch, underlayId: underlay?.srcId ?? null });
    });
  }

  /** Low-priority warm-up of the cache; never throws. */
  prefetchPlane(spec, { axis = "xy", channel = 0 } = {}) {
    this.loadPlane(spec, { axis, channel, prefetch: true }).catch(() => {});
  }

  /** The pane `axis` now shows `plane` (an assembler's `plane`): the worker starts its next image from it. */
  setShown(axis, plane) {
    if (plane?.srcId) this._workers.get(axis)?.postMessage({ type: "shown", id: plane.srcId });
  }

  stats() {
    if (this._fallback) return this.meta.stats();
    const out = { ...this.cache.stats(), inflight: this._jobs.size, queued: 0, ...this._last };
    for (const k of SUM_KEYS) out[k] = 0;
    for (const s of this._stats.values()) for (const k of SUM_KEYS) out[k] += s[k] ?? 0;
    for (const k of LAST_KEYS) out[k] ??= 0;
    return out;
  }

  dispose() {
    this._disposed = true;
    for (const w of this._workers.values()) {
      w.postMessage({ type: "dispose" });
      w.terminate();
    }
    this._workers.clear();
    for (const job of this._jobs.values()) job.reject(abortError());
    this._jobs.clear();
    this.meta.dispose();
  }

  // ------------------------------------------------------------------ internals

  _worker(axis) {
    let w = this._workers.get(axis);
    if (w) return w;
    w = new Worker(WORKER_URL, { type: "module", name: `slice-${axis}` });
    w.onmessage = (e) => this._onMessage(axis, w, e.data);
    w.onerror = (e) => this._onCrash(axis, e.message || "The slice worker failed");
    w.postMessage({ type: "init", baseUrl: this.baseUrl, cache: this.cache.init, maxInflight: this.maxInflight });
    this._workers.set(axis, w);
    return w;
  }

  /** A worker could not start or died (a module that did not load, no memory): this thread takes over, what was waiting on it too. */
  _onCrash(axis, message) {
    console.warn("[slice] a slice worker failed, loading planes on the main thread:", message);
    this._fallback = true;
    for (const w of this._workers.values()) w.terminate();
    this._workers.clear();
    const waiting = [...this._jobs.values()];
    this._jobs.clear();
    for (const job of waiting) job.redo().then(job.resolve, job.reject);
  }

  /** A new token for everyone (one request, however many workers ran into the old one). */
  _renewUrl() {
    this._refreshing ??= this._refreshUrl()
      .then((url) => {
        this.baseUrl = url;
        this.meta.baseUrl = url;
        for (const w of this._workers.values()) w.postMessage({ type: "url", baseUrl: url });
        return url;
      })
      .finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  _onMessage(axis, worker, m) {
    if (m.type === "refresh") {
      if (m.stale && m.stale !== this.baseUrl) { // another worker's request has got a new url already
        worker.postMessage({ type: "url", baseUrl: this.baseUrl });
        return;
      }
      this._renewUrl().catch(() => worker.postMessage({ type: "url", baseUrl: this.baseUrl })); // (the worker's request then fails as it would have)
      return;
    }
    const job = this._jobs.get(m.id);
    if (!job) return; // aborted meanwhile
    switch (m.type) {
      case "update":
        if (m.init) job.asm = new RemoteAssembler(m.id, m.init);
        if (job.asm) {
          if (m.rows) job.asm.applyRows(m.rows.r0, m.rows.r1, m.rows.buffer);
          job.asm.pending = m.pending;
          job.asm.complete = m.complete;
          job.onUpdate?.(job.asm);
        }
        break;
      case "done":
        this._jobs.delete(m.id);
        this._stats.set(axis, m.stats);
        for (const k of LAST_KEYS) this._last[k] = m.stats[k];
        if (job.asm) { job.asm.pending = 0; job.asm.complete = true; }
        job.resolve({ plan: m.plan, assembler: job.asm });
        break;
      case "error":
        this._jobs.delete(m.id);
        job.reject(m.name === "AbortError" ? abortError() : new PlaneError(m.message, m.status));
        break;
      default: break;
    }
  }
}

/**
 * The loader for a volume's slice views: workers sharing one cache where the page can have them, else the plain
 * main-thread PlaneClient. Takes PlaneClient's options (a custom `fetchFn` means the plain client: a function cannot
 * go to a worker); `maxCacheBytes` is the memory for the shared cache.
 */
export async function createPlaneClient(opts) {
  const meta = new PlaneClient(opts);
  if (opts.fetchFn || !WorkerPlaneClient.supported()) return meta;
  try {
    const info = await meta.info();
    const fmt = textureFormatFor(info.dtype);
    if (!fmt || !info.blockSize) return meta;
    const bs = info.blockSize;
    const cache = SharedBlockCache.create({
      blockBytes: bs ** 3 * fmt.array.BYTES_PER_ELEMENT,
      arrayName: fmt.array.name,
      grid: [info.dims.x, info.dims.y, info.dims.z].map((d) => Math.ceil(d / bs)),
      channels: info.channels ?? 1,
      maxBytes: opts.maxCacheBytes ?? 512e6,
    });
    if (!cache) return meta;
    return new WorkerPlaneClient({ meta, cache, refreshUrl: opts.refreshUrl ?? (async () => meta.baseUrl) });
  } catch (err) {
    console.warn("[slice] workers unavailable, loading planes on the main thread:", err);
    return meta;
  }
}
