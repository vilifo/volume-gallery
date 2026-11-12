// Gets the images of planes from the server (see backend/app/helpers/slices.py) as plans and blocks:
//
//   1. POST .../plan with the plane (origin, u, v, pixel, size) returns the plan: where each pixel samples the
//      volume and which blocks it reads from, the ones most pixels read from first;
//   2. the blocks the browser does not have yet are requested in one POST .../blocks, which streams them back as
//      the server reads them (the server reads the ones most pixels need first);
//   3. a PlaneAssembler (plane-assembler.js) builds the image from the blocks as they arrive; the caller is told
//      after every chunk and can show the image while it fills in.
//
// Blocks are kept in a byte-budgeted LRU, so a plane that overlaps one already seen (scrolling, a crosshair that
// moves, a plane that turns a little) is mostly assembled at once from the cache and only the rest is fetched.
// A load nobody waits for any more is aborted ("latest wins" while dragging); foreground loads run before
// prefetches, at most `maxInflight` at a time.

import { PlaneAssembler, BlockStreamParser } from "./plane-assembler.js";
import { textureFormatFor } from "./geometry.js";

export class PlaneError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "PlaneError";
    this.status = status;
  }
}

const abortError = () => new DOMException("aborted", "AbortError");

export class PlaneClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   ".../slices/<token>/" (ends with "/")
   * @param {Function} [o.fetchFn]
   * @param {() => Promise<string>} [o.refreshUrl]  returns a new baseUrl when the token expired (403)
   */
  constructor({ baseUrl, fetchFn = (...a) => fetch(...a), refreshUrl = null, maxCacheBytes = 512e6, maxInflight = 3 }) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn;
    this.refreshUrl = refreshUrl;
    this.maxCacheBytes = maxCacheBytes;
    this.maxInflight = maxInflight;
    this._blocks = new Map(); // "channel/key" -> typed array | null (an empty block), least recently used first
    this._blockBytes = 0;
    this._queue = [];
    this._running = 0;
    this._seq = 0;
    this._info = null;
    this._disposed = false;
    this.counters = { loads: 0, cached: 0, fetched: 0, bytes: 0, aborted: 0, lastMs: 0, lastPlanMs: 0, lastServerPlanMs: 0, lastFirstMs: 0, lastBlocks: 0 };
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

  /**
   * Loads the image of a plane. `spec` is a PaneGeometry.spec(). `onUpdate(assembler)` is called when the
   * cached blocks have been applied and after every chunk of the stream; the promise resolves with
   * { plan, assembler } when the image is complete (assembler is null for a prefetch, which only fills the cache).
   * Aborting `signal` stops it.
   * @param {object} spec
   * @param {{channel?: number, priority?: number, signal?: AbortSignal, underlay?: object, onUpdate?: Function, prefetch?: boolean}} [o]
   */
  loadPlane(spec, { channel = 0, priority = 1, signal, underlay = null, onUpdate = null, prefetch = false } = {}) {
    return new Promise((resolve, reject) => {
      if (this._disposed || signal?.aborted) { reject(abortError()); return; }
      const job = { spec, channel, priority: prefetch ? 0 : priority, underlay, onUpdate, prefetch, seq: this._seq++, controller: new AbortController(), resolve, reject, started: false };
      signal?.addEventListener("abort", () => {
        if (job.started) job.controller.abort();
        else {
          const i = this._queue.indexOf(job);
          if (i >= 0) this._queue.splice(i, 1);
          this.counters.aborted++;
          reject(abortError());
        }
      }, { once: true });
      this._queue.push(job);
      this._pump();
    });
  }

  /** Low-priority warm-up of the cache; never throws. */
  prefetchPlane(spec, { channel = 0 } = {}) {
    this.loadPlane(spec, { channel, prefetch: true }).catch(() => {});
  }

  stats() {
    return {
      blocks: this._blocks.size,
      cacheMB: +(this._blockBytes / 1e6).toFixed(1),
      inflight: this._running,
      queued: this._queue.length,
      ...this.counters,
    };
  }

  dispose() {
    this._disposed = true;
    for (const job of this._queue.splice(0)) job.reject(abortError());
    this._blocks.clear();
    this._blockBytes = 0;
  }

  // ------------------------------------------------------------------ internals

  /** The best queued job: highest priority, newest first (what is on screen now is what the user is waiting for). */
  _pump() {
    while (!this._disposed && this._running < this.maxInflight && this._queue.length) {
      let best = 0;
      for (let i = 1; i < this._queue.length; i++) {
        const a = this._queue[i], b = this._queue[best];
        if (a.priority > b.priority || (a.priority === b.priority && a.seq > b.seq)) best = i;
      }
      const job = this._queue.splice(best, 1)[0];
      job.started = true;
      this._running++;
      this._run(job).then(job.resolve, (err) => {
        if (err?.name === "AbortError") this.counters.aborted++;
        else if (!job.prefetch) console.warn("[slice] plane request failed:", err);
        job.reject(err?.name === "AbortError" ? abortError() : err);
      }).finally(() => { this._running--; this._pump(); });
    }
  }

  async _request(path, { signal, json } = {}) {
    const init = () => (json === undefined
      ? { signal }
      : { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
    let res = await this.fetchFn(this.baseUrl + path, init());
    if (res.status === 403 && this.refreshUrl) {
      this.baseUrl = await this.refreshUrl();
      res = await this.fetchFn(this.baseUrl + path, init());
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail ?? ""; } catch (_) { /* not JSON */ }
      throw new PlaneError(`${path.split("?")[0]}: ${detail || res.status}`, res.status);
    }
    return res;
  }

  _getBlock(channel, key) {
    const k = `${channel}/${key}`;
    const v = this._blocks.get(k);
    if (v !== undefined) {
      this._blocks.delete(k);
      this._blocks.set(k, v); // LRU touch
    }
    return v;
  }

  _putBlock(channel, key, data) {
    const k = `${channel}/${key}`;
    const bytes = data ? data.byteLength : 64;
    const old = this._blocks.get(k);
    if (old !== undefined) this._blockBytes -= old ? old.byteLength : 64;
    this._blocks.set(k, data);
    this._blockBytes += bytes;
    for (const [kk, v] of this._blocks) {
      if (this._blockBytes <= this.maxCacheBytes || kk === k) break;
      this._blocks.delete(kk);
      this._blockBytes -= v ? v.byteLength : 64;
    }
  }

  async _run(job) {
    const { spec, channel, prefetch } = job;
    const signal = job.controller.signal;
    const t0 = performance.now();

    const plan = await (await this._request("plan", { signal, json: spec })).json();
    signal.throwIfAborted(); // (a fetch that does not honour the signal, or a plan that arrived as it was aborted)
    this.counters.lastPlanMs = performance.now() - t0;
    this.counters.lastServerPlanMs = plan.planMs ?? 0;
    const fmt = textureFormatFor(plan.dtype);
    if (!fmt) throw new PlaneError(`Unsupported data type ${plan.dtype}`);
    const asm = prefetch ? null : new PlaneAssembler(plan, { underlay: job.underlay });
    const keyOf = (gx, gy, gz) => `${gx},${gy},${gz}`;

    // what the cache has goes in now; the rest is requested
    const missing = [];
    let cached = 0;
    for (let i = 0; i < plan.blocks.length; i += 4) {
      const gx = plan.blocks[i], gy = plan.blocks[i + 1], gz = plan.blocks[i + 2];
      const data = this._getBlock(channel, keyOf(gx, gy, gz));
      if (data !== undefined) { asm?.add(gx, gy, gz, data); cached++; }
      else missing.push(gx, gy, gz, plan.blocks[i + 3]);
    }
    this.counters.cached += cached;
    job.onUpdate?.(asm);
    let first = performance.now() - t0;

    if (missing.length) {
      const res = await this._request("blocks", { signal, json: { blocks: missing, prefetch } });
      let got = 0;
      const parser = new BlockStreamParser({
        Array: fmt.array,
        blockBytes: plan.blockSize ** 3 * fmt.array.BYTES_PER_ELEMENT,
        onBlock: (gx, gy, gz, data) => {
          this._putBlock(channel, keyOf(gx, gy, gz), data);
          asm?.add(gx, gy, gz, data);
          if (!got++) first = performance.now() - t0;
        },
      });
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            signal.throwIfAborted();
            this.counters.bytes += value.length;
            parser.push(value);
            job.onUpdate?.(asm);
          }
        } finally {
          reader.cancel().catch(() => {}); // a no-op once the stream has ended; frees the connection when we stop early
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        this.counters.bytes += buf.length;
        parser.push(buf);
        job.onUpdate?.(asm);
      }
      if (!parser.complete) throw new PlaneError("The block stream ended early");
      this.counters.fetched += got;
    }
    if (asm && !asm.complete) throw new PlaneError(`The image is incomplete: ${asm.pending} blocks missing`);
    this.counters.loads++;
    this.counters.lastMs = performance.now() - t0;
    this.counters.lastFirstMs = first;
    this.counters.lastBlocks = plan.blocks.length / 4;
    return { plan, assembler: asm };
  }
}
