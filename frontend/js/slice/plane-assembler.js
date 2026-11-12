// Builds the image of a plane from the blocks of the volume it reads from, as they arrive. No DOM, no
// WebGPU: unit-tested in frontend/tests/.
//
// The server describes the image in a *plan* (POST .../plan, see backend/app/helpers/slices.py): pixel
// (col, row) samples the volume at p0 + row * dv + col * du (voxel index space: voxel i has its centre at i;
// x, y, z), and `blocks` lists the non-empty blocks the image reads from. A block is a cube of
// `blockSize`^3 voxels addressed by block coordinates (gx, gy, gz), its voxels in (z, y, x) order.
//
// Every pixel is a trilinear sample (edge voxels repeat; pixels outside the volume stay 0). A pixel is
// computed each time a block it reads from arrives, from the blocks that are there so far: a voxel of a block
// that has not arrived yet is replaced by the pixel's nearest voxel, so the picture is complete and sharpens
// as blocks come in; once the last block of a pixel has arrived its value is exact. Blocks the plan does not
// list are empty (zero). Work per block is bounded by the pixels near it: the rows and columns of the image
// that a block's box (grown by one voxel, for the interpolation) cuts are found by clipping, not by scanning.

import { clipPolygon, textureFormatFor } from "./geometry.js";

const EPS = 1e-6;
const TINY = 1e-12;

export class PlaneAssembler {
  /**
   * @param {object} plan  the server's plan: { width, height, dtype, blockSize, dims, p0, du, dv, blocks }
   * @param {{underlay?: {width, height, dtype, data}}} [o]  an earlier image of the same size: what the image
   *   shows (instead of zeros) until blocks overwrite it
   */
  constructor(plan, { underlay = null } = {}) {
    const fmt = textureFormatFor(plan.dtype);
    if (!fmt) throw new Error(`Unsupported plane data type ${plan.dtype}`);
    this.plan = plan;
    this.width = plan.width;
    this.height = plan.height;
    this.dims = [plan.dims.x, plan.dims.y, plan.dims.z];
    this.bs = plan.blockSize;
    this.pow2 = (this.bs & (this.bs - 1)) === 0;
    this.shift = this.pow2 ? Math.log2(this.bs) : 0;
    this.nb = this.dims.map((d) => Math.ceil(d / this.bs));
    this.p0 = plan.p0;
    this.du = plan.du;
    this.dv = plan.dv;
    this.integer = fmt.sample !== "float";

    this.needed = new Set();
    for (let i = 0; i < plan.blocks.length; i += 4) this.needed.add(this.key(plan.blocks[i], plan.blocks[i + 1], plan.blocks[i + 2]));
    this.pending = this.needed.size;
    this.loaded = new Map(); // key -> typed array, or null for an empty block

    const data = new fmt.array(this.width * this.height);
    if (underlay && underlay.width === this.width && underlay.height === this.height && underlay.data instanceof fmt.array) data.set(underlay.data);
    /** The image in the shape the renderer's upload() takes. */
    this.plane = { width: this.width, height: this.height, dtype: plan.dtype, data, stride: 1 };
    this.data = data;
    this.dirty = null;
  }

  key(gx, gy, gz) {
    return (gz * this.nb[1] + gy) * this.nb[0] + gx;
  }

  get complete() {
    return this.pending === 0;
  }

  has(gx, gy, gz) {
    return this.loaded.has(this.key(gx, gy, gz));
  }

  /** Rows [r0, r1] changed since the last call, or null. */
  takeDirty() {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  /** A block has arrived (data: its voxels, a typed array of blockSize^3, or null when it is empty). */
  add(gx, gy, gz, data) {
    const key = this.key(gx, gy, gz);
    if (this.loaded.has(key)) return;
    this.loaded.set(key, data);
    if (this.needed.has(key)) this.pending--;
    if (data) this._evalBlock(gx, gy, gz);
  }

  // ------------------------------------------------------------------ internals

  _markRows(r0, r1) {
    if (!this.dirty) this.dirty = { r0, r1 };
    else {
      this.dirty.r0 = Math.min(this.dirty.r0, r0);
      this.dirty.r1 = Math.max(this.dirty.r1, r1);
    }
  }

  /** Recomputes the pixels that read from block (gx, gy, gz): those whose position is within a voxel of it. */
  _evalBlock(gx, gy, gz) {
    const { bs, dims, p0, du, dv, width: w, height: h } = this;
    const g = [gx, gy, gz];
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.max(g[k] * bs - 1 - EPS, -0.5);
      hi[k] = Math.min(g[k] * bs + bs + EPS, dims[k] - 0.5);
      if (lo[k] >= hi[k]) return;
    }
    // the part of the image (columns c = x, rows r = y) whose positions are inside the box: a convex polygon
    let poly = [[-0.5, -0.5], [w - 0.5, -0.5], [w - 0.5, h - 0.5], [-0.5, h - 0.5]];
    for (let k = 0; k < 3 && poly.length; k++) {
      poly = clipPolygon(poly, du[k], dv[k], hi[k] - p0[k]);
      if (poly.length) poly = clipPolygon(poly, -du[k], -dv[k], p0[k] - lo[k]);
    }
    if (!poly.length) return;
    let rMin = Infinity, rMax = -Infinity;
    for (const p of poly) { rMin = Math.min(rMin, p[1]); rMax = Math.max(rMax, p[1]); }
    const r0 = Math.max(0, Math.floor(rMin)), r1 = Math.min(h - 1, Math.ceil(rMax));
    let touched = false;
    for (let r = r0; r <= r1; r++) {
      const bx = p0[0] + r * dv[0], by = p0[1] + r * dv[1], bz = p0[2] + r * dv[2];
      const base = [bx, by, bz];
      let cLo = -Infinity, cHi = Infinity, skip = false;
      for (let k = 0; k < 3; k++) {
        const a = du[k];
        if (Math.abs(a) < TINY) {
          if (base[k] < lo[k] || base[k] >= hi[k]) { skip = true; break; }
          continue;
        }
        let t1 = (lo[k] - base[k]) / a, t2 = (hi[k] - base[k]) / a;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > cLo) cLo = t1;
        if (t2 < cHi) cHi = t2;
      }
      if (skip || cLo > cHi) continue;
      const c0 = Math.max(0, Math.floor(cLo)), c1 = Math.min(w - 1, Math.ceil(cHi));
      const row = r * w;
      for (let c = c0; c <= c1; c++) this._pixel(row + c, bx + c * du[0], by + c * du[1], bz + c * du[2]);
      if (c1 >= c0) touched = true;
    }
    if (touched) this._markRows(r0, r1);
  }

  /** The voxel at (x, y, z) (inside the volume): a number, null when the block is empty, undefined while it is on its way. */
  _voxel(x, y, z) {
    const bs = this.bs;
    const sh = this.shift;
    const gx = this.pow2 ? x >> sh : Math.floor(x / bs), gy = this.pow2 ? y >> sh : Math.floor(y / bs), gz = this.pow2 ? z >> sh : Math.floor(z / bs);
    const key = (gz * this.nb[1] + gy) * this.nb[0] + gx;
    const blk = this.loaded.get(key);
    if (blk === undefined) return this.needed.has(key) ? undefined : 0;
    if (blk === null) return 0;
    return blk[((z - gz * bs) * bs + (y - gy * bs)) * bs + (x - gx * bs)];
  }

  _corner(x, y, z, fallback) {
    const c = this._voxel(x, y, z);
    return c === undefined ? fallback : c;
  }

  /** Computes pixel i, which samples the volume at (px, py, pz), from the blocks that are there. */
  _pixel(i, px, py, pz) {
    const [nx, ny, nz] = this.dims;
    const data = this.data;
    if (!(px >= -0.5 && px < nx - 0.5 && py >= -0.5 && py < ny - 0.5 && pz >= -0.5 && pz < nz - 0.5)) {
      data[i] = 0;
      return;
    }
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const fx = px - ix, fy = py - iy, fz = pz - iz;
    const x0 = ix < 0 ? 0 : ix, y0 = iy < 0 ? 0 : iy, z0 = iz < 0 ? 0 : iz;
    const x1 = Math.min(ix + 1, nx - 1), y1 = Math.min(iy + 1, ny - 1), z1 = Math.min(iz + 1, nz - 1);

    let v;
    const sh = this.shift, bs = this.bs;
    if (this.pow2 && x0 >> sh === x1 >> sh && y0 >> sh === y1 >> sh && z0 >> sh === z1 >> sh) {
      // all eight voxels are in one block (nearly every pixel): no lookups per voxel
      const gx = x0 >> sh, gy = y0 >> sh, gz = z0 >> sh;
      const blk = this.loaded.get((gz * this.nb[1] + gy) * this.nb[0] + gx);
      if (blk === undefined) {
        if (this.needed.has((gz * this.nb[1] + gy) * this.nb[0] + gx)) return; // not here yet: keep what the pixel shows
        data[i] = 0;
        return;
      }
      if (blk === null) { data[i] = 0; return; }
      const m = bs - 1;
      const o = ((z0 & m) * bs + (y0 & m)) * bs + (x0 & m);
      const sx = x1 - x0, sy = (y1 - y0) * bs, sz = (z1 - z0) * bs * bs;
      if (fx === 0 && fy === 0 && fz === 0) v = blk[o];
      else {
        const c000 = blk[o], c100 = blk[o + sx], c010 = blk[o + sy], c110 = blk[o + sx + sy];
        const c001 = blk[o + sz], c101 = blk[o + sx + sz], c011 = blk[o + sy + sz], c111 = blk[o + sx + sy + sz];
        const a0 = c000 + (c100 - c000) * fx, a1 = c010 + (c110 - c010) * fx;
        const b0 = c001 + (c101 - c001) * fx, b1 = c011 + (c111 - c011) * fx;
        const d0 = a0 + (a1 - a0) * fy, d1 = b0 + (b1 - b0) * fy;
        v = d0 + (d1 - d0) * fz;
      }
    } else {
      const home = this._voxel(x0, y0, z0);
      if (home === undefined) return; // the block of its nearest voxel is not here yet: keep what the pixel shows
      if (fx === 0 && fy === 0 && fz === 0) {
        v = home;
      } else {
        // corners that are on their way count as the nearest voxel for now
        const c000 = home, c100 = this._corner(x1, y0, z0, home), c010 = this._corner(x0, y1, z0, home), c110 = this._corner(x1, y1, z0, home);
        const c001 = this._corner(x0, y0, z1, home), c101 = this._corner(x1, y0, z1, home), c011 = this._corner(x0, y1, z1, home), c111 = this._corner(x1, y1, z1, home);
        const a0 = c000 + (c100 - c000) * fx, a1 = c010 + (c110 - c010) * fx;
        const b0 = c001 + (c101 - c001) * fx, b1 = c011 + (c111 - c011) * fx;
        const d0 = a0 + (a1 - a0) * fy, d1 = b0 + (b1 - b0) * fy;
        v = d0 + (d1 - d0) * fz;
      }
    }
    data[i] = this.integer ? Math.round(v) : v;
  }
}

// ------------------------------------------------------------------------------------- the wire format

export const STREAM_END = 0xffffffff;
export const BLOCK_ERROR = 0xfffffffe;
const HEADER = 16;

/**
 * Parses the body of POST .../blocks as it arrives in chunks of any size: records of a 16-byte header
 * (gx, gy, gz, payload bytes; uint32 little-endian) and the block's voxels. A payload size of 0 is an empty
 * block, BLOCK_ERROR one the server could not read; a record whose gx, gy, gz are all STREAM_END closes the stream
 * (its size field is the number of blocks sent).
 */
export class BlockStreamParser {
  /**
   * @param {object} o
   * @param {Function} o.Array       typed array constructor of the voxels
   * @param {number} o.blockBytes    the payload size of a full block
   * @param {(gx, gy, gz, data: ArrayBufferView|null) => void} o.onBlock
   */
  constructor({ Array: TA, blockBytes, onBlock }) {
    this.TA = TA;
    this.blockBytes = blockBytes;
    this.onBlock = onBlock;
    this.buf = new Uint8Array(0);
    this.ended = false;
    this.count = 0;     // blocks seen
    this.sent = null;   // what the closing record says
  }

  push(chunk) {
    if (this.ended || !chunk?.length) return;
    let buf = chunk;
    if (this.buf.length) {
      buf = new Uint8Array(this.buf.length + chunk.length);
      buf.set(this.buf);
      buf.set(chunk, this.buf.length);
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 0;
    while (buf.length - pos >= HEADER) {
      const gx = dv.getUint32(pos, true), gy = dv.getUint32(pos + 4, true), gz = dv.getUint32(pos + 8, true), n = dv.getUint32(pos + 12, true);
      if (gx === STREAM_END && gy === STREAM_END && gz === STREAM_END) {
        this.ended = true;
        this.sent = n;
        pos = buf.length;
        break;
      }
      if (n === 0) {
        pos += HEADER;
        this.count++;
        this.onBlock(gx, gy, gz, null);
        continue;
      }
      if (n === BLOCK_ERROR) throw new Error(`The server could not read block (${gx}, ${gy}, ${gz})`);
      if (n !== this.blockBytes) throw new Error(`Block (${gx}, ${gy}, ${gz}) has ${n} bytes, expected ${this.blockBytes}`);
      if (buf.length - pos - HEADER < n) break;
      const copy = buf.slice(pos + HEADER, pos + HEADER + n); // a fresh, aligned buffer
      pos += HEADER + n;
      this.count++;
      this.onBlock(gx, gy, gz, new this.TA(copy.buffer));
    }
    this.buf = pos < buf.length ? buf.slice(pos) : new Uint8Array(0);
  }

  /** Whether the stream was closed properly and every block it announced arrived. */
  get complete() {
    return this.ended && this.sent === this.count && this.buf.length === 0;
  }
}
