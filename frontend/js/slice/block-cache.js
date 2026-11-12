// The cache of the blocks of a volume that the slice views have fetched (see plane-client.js).
//
//   PrivateBlockCache  one thread: a byte-budgeted LRU in a Map. What the main-thread PlaneClient uses.
//   SharedBlockCache   several threads: the blocks live in one SharedArrayBuffer that the three pane workers
//                      (slice-worker.js) read and write, so a block fetched for one pane is there for the others
//                      (a tilted plane and an axis-aligned one overlap a lot) and the memory is spent once.
//
// Both answer the same calls, so PlaneClient does not care which one it has:
//
//   get(channel, gx, gy, gz, pins)       -> undefined (not cached) | null (an empty block) | the voxels
//   has(channel, gx, gy, gz)             -> boolean
//   put(channel, gx, gy, gz, data, pins) -> the voxels to use (data: a typed array, or null for an empty block)
//   release(pins)                        -> lets go of the blocks a job used (see below)
//   stats()                              -> { blocks, cacheMB }
//
// Pins (shared cache only). The voxels get() and put() hand out are views of the shared memory, so the slot
// must not be reused while the caller reads them. A caller that passes a `pins` array gets the block pinned (its
// entry index is pushed on the array); a pinned block is never evicted, until release(pins). PlaneClient pins
// everything a plane's image reads from and releases it when the image is done. When everything a block could
// replace is pinned (or the memory is used up by pinned blocks) put() simply returns `data` itself: that block is
// not cached, and the caller carries on with its own copy.
//
// The shared cache is a set-associative hash table (WAYS entries per set, CLOCK second-chance replacement) over a
// slab of equally sized slots, all guarded by one mutex (Atomics): operations are a few microseconds (a block's
// memcpy at most). Only workers may touch it (a page's main thread must not block); the main thread can read stats().

export class PrivateBlockCache {
  constructor({ maxBytes = 512e6 } = {}) {
    this.shared = false;
    this.maxBytes = maxBytes;
    this._blocks = new Map(); // "channel/gx,gy,gz" -> typed array | null (an empty block), least recently used first
    this._bytes = 0;
  }

  _k(channel, gx, gy, gz) {
    return `${channel}/${gx},${gy},${gz}`;
  }

  get(channel, gx, gy, gz) {
    const k = this._k(channel, gx, gy, gz);
    const v = this._blocks.get(k);
    if (v !== undefined) {
      this._blocks.delete(k);
      this._blocks.set(k, v); // LRU touch
    }
    return v;
  }

  has(channel, gx, gy, gz) {
    return this._blocks.has(this._k(channel, gx, gy, gz));
  }

  put(channel, gx, gy, gz, data) {
    const k = this._k(channel, gx, gy, gz);
    const old = this._blocks.get(k);
    if (old !== undefined) this._bytes -= old ? old.byteLength : 64;
    this._blocks.delete(k);
    this._blocks.set(k, data);
    this._bytes += data ? data.byteLength : 64;
    for (const [kk, v] of this._blocks) {
      if (this._bytes <= this.maxBytes || kk === k) break;
      this._blocks.delete(kk);
      this._bytes -= v ? v.byteLength : 64;
    }
    return data;
  }

  release() {}

  clear() {
    this._blocks.clear();
    this._bytes = 0;
  }

  stats() {
    return { blocks: this._blocks.size, cacheMB: +(this._bytes / 1e6).toFixed(1) };
  }
}

// ------------------------------------------------------------------------------------------ shared

const WAYS = 8;
const MIN_SLOTS = 64;
// header (Int32)
const H_LOCK = 0, H_HAND = 1, H_FREE = 2, H_DATA = 3, H_EMPTY = 4;
const HEADER_INTS = 16;
// entry states
const FREE = 0, DATA = 1, EMPTY = 2;
const TWO32 = 4294967296;

const align8 = (n) => (n + 7) & ~7;
const pow2AtLeast = (n) => { let p = 1; while (p < n) p *= 2; return p; };

export class SharedBlockCache {
  /**
   * A new shared cache. Send `cache.init` to the workers (it is structured-cloneable; the SharedArrayBuffer is
   * shared, not copied) and open it there with `new SharedBlockCache(init)`.
   * @param {object} o
   * @param {number} o.blockBytes   bytes of one block (blockSize^3 * bytes per voxel)
   * @param {string} o.arrayName    typed array of the voxels, "Uint16Array" ...
   * @param {number[]} o.grid       blocks per axis [nbx, nby, nbz]
   * @param {number} [o.channels]
   * @param {number} [o.maxBytes]   memory for the blocks (the slab); the cache is a little larger
   * @returns {SharedBlockCache|null}  null when it cannot be made (no SharedArrayBuffer, or too little memory)
   */
  static create({ blockBytes, arrayName, grid, channels = 1, maxBytes = 512e6 }) {
    if (typeof SharedArrayBuffer === "undefined") return null;
    const stride = align8(blockBytes);
    const slots = Math.floor(maxBytes / stride);
    if (slots < MIN_SLOTS) return null;
    const sets = pow2AtLeast(Math.ceil((slots * 4) / WAYS)); // entries: 4 per slot (empty blocks have no slot)
    const entries = sets * WAYS;
    const layout = SharedBlockCache._layout(slots, entries, stride);
    let sab;
    try {
      sab = new SharedArrayBuffer(layout.total);
    } catch (_) {
      return null;
    }
    const cache = new SharedBlockCache({ sab, blockBytes, arrayName, grid, channels, slots, sets, stride });
    for (let i = 0; i < slots; i++) cache._free[i] = slots - 1 - i; // popped from the end: slot 0 first
    cache._h[H_FREE] = slots;
    return cache;
  }

  static _layout(slots, entries, stride) {
    let o = HEADER_INTS * 4;
    const take = (bytes) => { const at = o; o = align8(o + bytes); return at; };
    const keyLo = take(entries * 4), keyHi = take(entries * 4), state = take(entries * 4);
    const slotOf = take(entries * 4), pins = take(entries * 4), ref = take(entries);
    const free = take(slots * 4);
    const slab = o;
    return { keyLo, keyHi, state, slotOf, pins, ref, free, slab, total: slab + slots * stride };
  }

  /** @param {object} init  what create() made (`cache.init`) */
  constructor(init) {
    const { sab, blockBytes, arrayName, grid, channels, slots, sets, stride } = init;
    this.init = init;
    this.shared = true;
    this.sab = sab;
    this.slots = slots;
    this.sets = sets;
    this.entries = sets * WAYS;
    this.stride = stride;
    this.grid = grid;
    this.channels = channels;
    this.TA = globalThis[arrayName];
    this.elems = blockBytes / this.TA.BYTES_PER_ELEMENT;
    const L = SharedBlockCache._layout(slots, this.entries, stride);
    const E = this.entries;
    this._h = new Int32Array(sab, 0, HEADER_INTS);
    this._keyLo = new Uint32Array(sab, L.keyLo, E);
    this._keyHi = new Uint32Array(sab, L.keyHi, E);
    this._state = new Int32Array(sab, L.state, E);
    this._slotOf = new Int32Array(sab, L.slotOf, E);
    this._pins = new Int32Array(sab, L.pins, E);
    this._ref = new Uint8Array(sab, L.ref, E);
    this._free = new Int32Array(sab, L.free, slots);
    this._slab = L.slab;
  }

  // -------------------------------------------------------------------- the mutex (Drepper's three-state futex)

  _lock() {
    const h = this._h;
    let c = Atomics.compareExchange(h, H_LOCK, 0, 1);
    if (c === 0) return;
    if (c !== 2) c = Atomics.exchange(h, H_LOCK, 2);
    while (c !== 0) {
      try { Atomics.wait(h, H_LOCK, 2); } catch (_) { /* a thread that may not block: spin */ }
      c = Atomics.exchange(h, H_LOCK, 2);
    }
  }

  _unlock() {
    const h = this._h;
    if (Atomics.sub(h, H_LOCK, 1) !== 1) {
      Atomics.store(h, H_LOCK, 0);
      Atomics.notify(h, H_LOCK, 1);
    }
  }

  // -------------------------------------------------------------------------------------------- internals

  /** channel, gx, gy, gz -> [set, keyLo, keyHi] in this._k */
  _key(channel, gx, gy, gz) {
    const [nbx, nby, nbz] = this.grid;
    const k = ((channel * nbz + gz) * nby + gy) * nbx + gx; // < 2^53
    const hi = Math.floor(k / TWO32);
    const lo = k - hi * TWO32;
    let x = Math.imul(lo | 0, 0x9e3779b1) ^ Math.imul((hi + 0x7f4a7c15) | 0, 0x85ebca6b);
    x ^= x >>> 15;
    x = Math.imul(x, 0x2c1b3c6d);
    x ^= x >>> 12;
    this._kSet = (x >>> 0) & (this.sets - 1);
    this._kLo = lo;
    this._kHi = hi;
  }

  _find() {
    const base = this._kSet * WAYS, st = this._state;
    for (let e = base; e < base + WAYS; e++) {
      if (st[e] !== FREE && this._keyLo[e] === this._kLo && this._keyHi[e] === this._kHi) return e;
    }
    return -1;
  }

  _view(slot) {
    return new this.TA(this.sab, this._slab + slot * this.stride, this.elems);
  }

  /** The entry that a new block of this set goes to: a free way, else the best unpinned one (second chance); -1 if all are pinned. */
  _victim() {
    const base = this._kSet * WAYS, st = this._state;
    let unpinned = -1;
    for (let e = base; e < base + WAYS; e++) {
      if (st[e] === FREE) return e;
      if (this._pins[e] === 0) {
        if (this._ref[e] === 0) return e;
        if (unpinned < 0) unpinned = e;
      }
    }
    if (unpinned < 0) return -1;
    for (let e = base; e < base + WAYS; e++) this._ref[e] = 0; // everyone had a second chance: the next time one is oldest
    return unpinned;
  }

  _drop(e) {
    if (this._state[e] === DATA) {
      this._free[this._h[H_FREE]++] = this._slotOf[e];
      this._h[H_DATA]--;
    } else if (this._state[e] === EMPTY) this._h[H_EMPTY]--;
    this._state[e] = FREE;
  }

  /** A free slot: from the free list, else the one of the first unpinned block the clock hand finds. -1 if there is none. */
  _allocSlot() {
    const h = this._h;
    if (h[H_FREE] > 0) return this._free[--h[H_FREE]];
    const E = this.entries;
    let e = h[H_HAND] % E;
    for (let i = 0; i < 2 * E; i++, e = (e + 1) % E) {
      if (this._state[e] !== DATA || this._pins[e] !== 0) continue;
      if (this._ref[e]) { this._ref[e] = 0; continue; }
      h[H_HAND] = e + 1;
      this._drop(e);
      return this._free[--h[H_FREE]];
    }
    return -1;
  }

  _pin(e, pins) {
    if (!pins) return;
    this._pins[e]++;
    pins.push(e);
  }

  // ------------------------------------------------------------------------------------------------- API

  get(channel, gx, gy, gz, pins = null) {
    this._lock();
    try {
      this._key(channel, gx, gy, gz);
      const e = this._find();
      if (e < 0) return undefined;
      this._ref[e] = 1;
      if (this._state[e] === EMPTY) return null;
      this._pin(e, pins);
      return this._view(this._slotOf[e]);
    } finally {
      this._unlock();
    }
  }

  has(channel, gx, gy, gz) {
    this._lock();
    try {
      this._key(channel, gx, gy, gz);
      return this._find() >= 0;
    } finally {
      this._unlock();
    }
  }

  put(channel, gx, gy, gz, data, pins = null) {
    if (data && data.length !== this.elems) return data; // not a block of this volume: not cached
    this._lock();
    try {
      this._key(channel, gx, gy, gz);
      const found = this._find();
      if (found >= 0) { // another pane's worker fetched it meanwhile: the same voxels
        this._ref[found] = 1;
        if (this._state[found] === EMPTY) return null;
        this._pin(found, pins);
        return this._view(this._slotOf[found]);
      }
      const e = this._victim();
      if (e < 0) return data; // everything it could replace is pinned
      this._drop(e);
      if (data === null) {
        this._keyLo[e] = this._kLo; this._keyHi[e] = this._kHi;
        this._state[e] = EMPTY; this._ref[e] = 1; this._pins[e] = 0;
        this._h[H_EMPTY]++;
        return null;
      }
      const slot = this._allocSlot();
      if (slot < 0) return data; // the memory is all pinned blocks
      const view = this._view(slot);
      view.set(data);
      this._keyLo[e] = this._kLo; this._keyHi[e] = this._kHi;
      this._slotOf[e] = slot; this._state[e] = DATA; this._ref[e] = 1; this._pins[e] = 0;
      this._h[H_DATA]++;
      this._pin(e, pins);
      return view;
    } finally {
      this._unlock();
    }
  }

  release(pins) {
    if (!pins?.length) return;
    this._lock();
    try {
      for (const e of pins) this._pins[e]--;
    } finally {
      this._unlock();
    }
    pins.length = 0;
  }

  /** Readable from any thread (no lock: a snapshot). */
  stats() {
    const data = Atomics.load(this._h, H_DATA), empty = Atomics.load(this._h, H_EMPTY);
    return { blocks: data + empty, cacheMB: +((data * this.stride) / 1e6).toFixed(1) };
  }
}
