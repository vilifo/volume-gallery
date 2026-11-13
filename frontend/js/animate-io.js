// Where the frames of an animation go: a zip of image files (split into parts below ~1.8 GB), or an
// H.264 MP4 video written with WebCodecs and a small built-in MP4 muxer.

import { encodeImage, FORMATS, fileSafe } from "./export-image.js";

// ------------------------------------------------------------------------------------- ZIP

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive with stored (uncompressed) entries: the frames are PNG/JPEG/TIFF already. No zip64. */
export class ZipWriter {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.count = 0;
    const d = new Date();
    this.dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    this.dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }

  get size() { return this.offset; }

  add(name, bytes) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // names are UTF-8
    head.setUint16(8, 0, true); // stored
    head.setUint16(10, this.dosTime, true);
    head.setUint16(12, this.dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, bytes.length, true);
    head.setUint32(22, bytes.length, true);
    head.setUint16(26, nameBytes.length, true);
    head.setUint16(28, 0, true);
    this.parts.push(head.buffer, nameBytes, bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, this.dosTime, true);
    cd.setUint16(14, this.dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, bytes.length, true);
    cd.setUint32(24, bytes.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, this.offset, true);
    this.central.push(cd.buffer, nameBytes);
    this.offset += 30 + nameBytes.length + bytes.length;
    this.count++;
  }

  finish() {
    const centralSize = this.central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: "application/zip" });
  }
}

const ZIP_PART_LIMIT = 1.8 * 1024 ** 3;
const ZIP_PART_FRAMES = 60000;

/** Frames as numbered image files in a zip (several zips when the frames add up to a lot). */
export class ZipSink {
  /** @param {{format: "png"|"jpeg"|"webp"|"tiff", quality?: number, baseName: string, description?: string}} o */
  constructor({ format, quality = 0.95, baseName, description = "" }) {
    this.format = format;
    this.quality = quality;
    this.base = fileSafe(baseName);
    this.description = description;
    this.zip = new ZipWriter();
    this.done = [];
  }

  async add(frame, index) {
    const blob = await encodeImage(frame, this.format, this.quality, this.description);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (this.zip.count > 0 && (this.zip.size + bytes.length > ZIP_PART_LIMIT || this.zip.count >= ZIP_PART_FRAMES)) this.#closePart();
    this.zip.add(`${this.base}_${String(index).padStart(5, "0")}.${FORMATS[this.format].ext}`, bytes);
  }

  #closePart() {
    this.done.push(this.zip.finish());
    this.zip = new ZipWriter();
  }

  async finish() {
    if (this.zip.count > 0) this.#closePart();
    const n = this.done.length;
    return this.done.map((blob, i) => ({ blob, filename: n === 1 ? `${this.base}_frames.zip` : `${this.base}_frames_part${i + 1}.zip` }));
  }

  abort() { this.done = []; this.zip = new ZipWriter(); }
}

// ------------------------------------------------------------------------------------- MP4

const u8 = (...a) => Uint8Array.from(a);
const be16 = (n) => u8(n >> 8, n & 255);
const be32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...payload) => { const body = concat(...payload); return concat(be32(body.length + 8), ascii(type), body); };
const fullBox = (type, version, flags, ...payload) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
const zeros = (n) => new Uint8Array(n);
const MATRIX = concat(be32(0x00010000), zeros(12), be32(0x00010000), zeros(12), be32(0x40000000));

/**
 * Writes an MP4 with one H.264 video track from length-prefixed ("avc" format) samples, with the moov box
 * in front of the media data so the file can be played while it downloads.
 */
export class Mp4Writer {
  /** @param {{width: number, height: number, fps: number, avcC: Uint8Array}} o */
  constructor({ width, height, fps, avcC }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.avcC = avcC;
    this.timescale = fps * 1000;
    this.samples = []; // Uint8Array
    this.keys = []; // 1-based indices of key frames
    this.bytes = 0;
  }

  addSample(data, isKey) {
    this.samples.push(data);
    if (isKey) this.keys.push(this.samples.length);
    this.bytes += data.length;
  }

  #moov(chunkOffset) {
    const n = this.samples.length;
    const duration = n * 1000; // frame duration is timescale / fps = 1000 ticks
    const mvhd = fullBox("mvhd", 0, 0, be32(0), be32(0), be32(this.timescale), be32(duration), be32(0x00010000), be16(0x0100), zeros(10), MATRIX, zeros(24), be32(2));
    const tkhd = fullBox("tkhd", 0, 3, be32(0), be32(0), be32(1), zeros(4), be32(duration), zeros(8), be16(0), be16(0), be16(0), zeros(2), MATRIX, be32(this.width << 16), be32(this.height << 16));
    const mdhd = fullBox("mdhd", 0, 0, be32(0), be32(0), be32(this.timescale), be32(duration), be16(0x55c4), be16(0));
    const hdlr = fullBox("hdlr", 0, 0, be32(0), ascii("vide"), zeros(12), ascii("VideoHandler\0"));
    const vmhd = fullBox("vmhd", 0, 1, zeros(8));
    const dinf = box("dinf", fullBox("dref", 0, 0, be32(1), fullBox("url ", 0, 1)));
    const avc1 = box("avc1", zeros(6), be16(1), zeros(16), be16(this.width), be16(this.height), be32(0x00480000), be32(0x00480000), zeros(4), be16(1), zeros(32), be16(0x18), be16(0xffff), box("avcC", this.avcC)); // colours: players read the matrix from the stream's own VUI data
    const stsd = fullBox("stsd", 0, 0, be32(1), avc1);
    const stts = fullBox("stts", 0, 0, be32(1), be32(n), be32(1000));
    const stss = this.keys.length === n ? new Uint8Array(0) : fullBox("stss", 0, 0, be32(this.keys.length), ...this.keys.map(be32));
    const stsc = fullBox("stsc", 0, 0, be32(1), be32(1), be32(n), be32(1));
    const stsz = fullBox("stsz", 0, 0, be32(0), be32(n), ...this.samples.map((s) => be32(s.length)));
    const stco = fullBox("stco", 0, 0, be32(1), be32(chunkOffset));
    const stbl = box("stbl", stsd, stts, stss, stsc, stsz, stco);
    const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", vmhd, dinf, stbl)));
    return box("moov", mvhd, trak);
  }

  finish() {
    if (this.samples.length === 0) throw new Error("The video has no frames");
    if (this.bytes > 0xf0000000) throw new Error("The video is larger than 4 GB: lower the quality or the size, or save an image sequence");
    const ftyp = box("ftyp", ascii("isom"), be32(512), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
    const moovSize = this.#moov(0).length;
    const moov = this.#moov(ftyp.length + moovSize + 8);
    return new Blob([ftyp, moov, be32(this.bytes + 8), ascii("mdat"), ...this.samples], { type: "video/mp4" });
  }
}

const H264_LEVELS = ["avc1.64001f", "avc1.640028", "avc1.640033", "avc1.640034"]; // High profile, levels 3.1 4.0 5.1 5.2
const QUALITY_BPP = { medium: 0.08, high: 0.16, max: 0.3 }; // bits per pixel per frame

export async function h264Config(width, height, fps, quality = "high") {
  const bitrate = Math.min(250e6, Math.round(width * height * fps * (QUALITY_BPP[quality] ?? QUALITY_BPP.high)));
  const pixels = width * height;
  const start = pixels <= 921600 ? 0 : pixels <= 2088960 ? 1 : 2;
  for (const codec of H264_LEVELS.slice(start)) {
    const config = { codec, width, height, bitrate, framerate: fps, avc: { format: "avc" }, latencyMode: "quality", bitrateMode: "variable" };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch (_) { /* try the next level */ }
  }
  return null;
}

/** Whether this browser can write an H.264 video of this size. */
export async function canEncodeVideo(width, height, fps) {
  if (typeof VideoEncoder === "undefined") return false;
  return (await h264Config(width - (width % 2), height - (height % 2), fps)) !== null;
}

/** Frames into an H.264 MP4. Odd sizes lose their last row / column (H.264 needs even sizes). */
export class Mp4Sink {
  /** @param {{width: number, height: number, fps: number, quality?: "medium"|"high"|"max", baseName: string}} o */
  constructor({ width, height, fps, quality = "high", baseName }) {
    this.width = width - (width % 2);
    this.height = height - (height % 2);
    this.fps = fps;
    this.quality = quality;
    this.base = fileSafe(baseName);
    this.writer = null;
    this.error = null;
    this.encoder = null;
  }

  async #start() {
    const config = await h264Config(this.width, this.height, this.fps, this.quality);
    if (!config) throw new Error(`This browser cannot encode ${this.width} \u00d7 ${this.height} H.264 video. Save an image sequence instead, or choose a smaller size.`);
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (!this.writer) {
          const description = meta?.decoderConfig?.description;
          if (!description) { this.error = new Error("The encoder did not provide the H.264 parameters"); return; }
          this.writer = new Mp4Writer({ width: this.width, height: this.height, fps: this.fps, avcC: new Uint8Array(description.buffer ? description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength) : description) });
        }
        this.writer.addSample(data, chunk.type === "key");
      },
      error: (e) => { this.error = e; },
    });
    this.encoder.configure(config);
  }

  async add(frame, index) {
    if (!this.encoder) await this.#start();
    if (this.error) throw this.error;
    const { rgba } = frame;
    if (!rgba) throw new Error("Video needs rendered frames, not raw voxel values");
    let data = rgba;
    if (frame.width !== this.width || frame.height !== this.height) {
      if (frame.width < this.width || frame.height < this.height) throw new Error("The frames changed size during the animation");
      data = new Uint8ClampedArray(this.width * this.height * 4);
      for (let y = 0; y < this.height; y++) data.set(rgba.subarray(y * frame.width * 4, (y * frame.width + this.width) * 4), y * this.width * 4);
    }
    while (this.encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 10));
    const videoFrame = new VideoFrame(data, { format: "RGBA", codedWidth: this.width, codedHeight: this.height, timestamp: Math.round((index * 1e6) / this.fps), duration: Math.round(1e6 / this.fps) });
    this.encoder.encode(videoFrame, { keyFrame: index % (this.fps * 2) === 0 });
    videoFrame.close();
  }

  async finish() {
    if (this.encoder) await this.encoder.flush();
    if (this.error) throw this.error;
    if (!this.writer) throw new Error("The video has no frames");
    this.encoder.close();
    return [{ blob: this.writer.finish(), filename: `${this.base}.mp4` }];
  }

  abort() {
    try { this.encoder?.close(); } catch (_) { /* already closed */ }
    this.writer = null;
  }
}
