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
import { PrivateBlockCache } from "./block-cache.js";
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
   * @param {(refused: string) => Promise<string>} [o.refreshUrl]  returns a new baseUrl when the token expired (403);
   *   `refused` is the baseUrl that was refused
   * @param {object} [o.cache]  where the blocks are kept (block-cache.js): a PrivateBlockCache of `maxCacheBytes`
   *   by default; the pane workers pass the SharedBlockCache they share
   */
  constructor({ baseUrl, fetchFn = (...a) => fetch(...a), refreshUrl = null, maxCacheBytes = 512e6, maxInflight = 3, cache = null }) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn;
    this.refreshUrl = refreshUrl;
    this.maxCacheBytes = maxCacheBytes;
    this.maxInflight = maxInflight;
    this.cache = cache ?? new PrivateBlockCache({ maxBytes: maxCacheBytes });
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
      ...this.cache.stats(),
      inflight: this._running,
      queued: this._queue.length,
      ...this.counters,
    };
  }

  dispose() {
    this._disposed = true;
    for (const job of this._queue.splice(0)) job.reject(abortError());
    if (!this.cache.shared) this.cache.clear(); // (a shared cache belongs to whoever made it)
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
    const base = this.baseUrl;
    let res = await this.fetchFn(base + path, init());
    if (res.status === 403 && this.refreshUrl) {
      if (this.baseUrl === base) this.baseUrl = await this.refreshUrl(base); // (else a request of ours has renewed it meanwhile)
      res = await this.fetchFn(this.baseUrl + path, init());
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).detail ?? "";
        // FastAPI validation errors (422) are a list of objects, not a string
        if (Array.isArray(detail)) detail = detail.map((d) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`).join("; ");
        else if (typeof detail === "object") detail = JSON.stringify(detail);
      } catch (_) { /* not JSON */ }
      throw new PlaneError(`${path.split("?")[0]}: ${detail || res.status}`, res.status);
    }
    return res;
  }

  async _run(job) {
    const pins = []; // the blocks of a shared cache that this image reads from: not replaced until it is done
    try {
      return await this._load(job, pins);
    } finally {
      this.cache.release(pins);
    }
  }

  async _load(job, pins) {
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
    const cache = this.cache;
    const mine = asm ? pins : null; // (a prefetch only fills the cache: it keeps nothing)

    // what the cache has goes in now; the rest is requested
    const missing = [];
    let cached = 0;
    for (let i = 0; i < plan.blocks.length; i += 4) {
      const gx = plan.blocks[i], gy = plan.blocks[i + 1], gz = plan.blocks[i + 2];
      if (!asm) {
        if (cache.has(channel, gx, gy, gz)) cached++;
        else missing.push(gx, gy, gz, plan.blocks[i + 3]);
        continue;
      }
      const data = cache.get(channel, gx, gy, gz, mine);
      if (data !== undefined) { asm.add(gx, gy, gz, data); cached++; }
      else missing.push(gx, gy, gz, plan.blocks[i + 3]);
    }
    this.counters.cached += cached;
    job.onUpdate?.(asm);
    let first = performance.now() - t0;

    if (missing.length) {
      // The server takes a limited number of blocks per request; a tilted plane can need more than that, so the
      // list (best blocks first) goes out in consecutive requests of at most that size.
      const perRequest = Math.max(1, plan.maxBlocksPerRequest ?? 40000) * 4;
      let got = 0;
      for (let from = 0; from < missing.length; from += perRequest) {
        signal.throwIfAborted();
        const res = await this._request("blocks", { signal, json: { blocks: missing.slice(from, from + perRequest), prefetch } });
        const parser = new BlockStreamParser({
          Array: fmt.array,
          blockBytes: plan.blockSize ** 3 * fmt.array.BYTES_PER_ELEMENT,
          onBlock: (gx, gy, gz, data) => {
            const stored = cache.put(channel, gx, gy, gz, data, mine); // (the cache's copy, when it keeps one)
            asm?.add(gx, gy, gz, stored);
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
      }
      this.counters.fetched += got;
    }
    if (asm && !asm.complete) throw new PlaneError(`The image is incomplete: ${asm.pending} blocks missing`);
    if (asm && cache.shared) asm.loaded.clear(); // the blocks it read are views of the shared memory, which is free to go on now
    this.counters.loads++;
    this.counters.lastMs = performance.now() - t0;
    this.counters.lastFirstMs = first;
    this.counters.lastBlocks = plan.blocks.length / 4;
    return { plan, assembler: asm };
  }
}
