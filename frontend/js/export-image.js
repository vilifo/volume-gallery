// Saving the view as an image file: PNG, JPEG, WebP (through the browser's canvas encoders) and
// TIFF (written here: uncompressed, 8-bit grey / 8-bit RGB for what is displayed, and the raw 8/16-bit
// integer or 32-bit float voxel values of a slice).

import { openFloatingPanel } from "./floating-panel.js";

// ------------------------------------------------------------------------------------- TIFF

const TIFF_STRIP_BYTES = 8 * 1024 * 1024;

/**
 * Encodes an uncompressed baseline TIFF.
 * @param {object} o
 * @param {number} o.width @param {number} o.height
 * @param {1|3} o.channels  1 = black is zero, 3 = RGB
 * @param {Uint8Array|Int8Array|Uint16Array|Int16Array|Float32Array} o.data  interleaved samples, row by row
 * @param {string} [o.description]
 * @returns {Blob}
 */
export function encodeTiff({ width, height, channels, data, description = "" }) {
  const bytesPer = data.BYTES_PER_ELEMENT;
  const bits = bytesPer * 8;
  const sampleFormat = data instanceof Float32Array ? 3 : data instanceof Int8Array || data instanceof Int16Array ? 2 : 1;
  if (data.length !== width * height * channels) throw new Error("TIFF: the data does not match the image size");

  const rowBytes = width * channels * bytesPer;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(TIFF_STRIP_BYTES / rowBytes)));
  const strips = Math.ceil(height / rowsPerStrip);
  const total = rowBytes * height;
  if (total > 0xf0000000) throw new Error("This image is too large for a TIFF file (4 GB limit). Export the visible area instead.");

  const enc = new TextEncoder();
  const desc = enc.encode(`${description}\0`);
  const software = enc.encode("Volume Gallery\0");

  const entries = []; // [tag, type, count, inline value | bytes to place after the table]
  const SHORT = 3, LONG = 4, ASCII = 2;
  const shorts = (n, v) => Array.from({ length: n }, () => v);
  entries.push([256, LONG, 1, [width]]);
  entries.push([257, LONG, 1, [height]]);
  entries.push([258, SHORT, channels, shorts(channels, bits)]);
  entries.push([259, SHORT, 1, [1]]); // no compression
  entries.push([262, SHORT, 1, [channels === 3 ? 2 : 1]]);
  if (description) entries.push([270, ASCII, desc.length, desc]);
  entries.push([273, LONG, strips, null]); // strip offsets, filled in below
  entries.push([277, SHORT, 1, [channels]]);
  entries.push([278, LONG, 1, [rowsPerStrip]]);
  entries.push([279, LONG, strips, Array.from({ length: strips }, (_, i) => Math.min(rowsPerStrip, height - i * rowsPerStrip) * rowBytes)]);
  entries.push([305, ASCII, software.length, software]);
  entries.push([339, SHORT, channels, shorts(channels, sampleFormat)]);

  const tableBytes = 2 + entries.length * 12 + 4;
  const sizeOf = (type, count) => count * (type === SHORT ? 2 : type === LONG ? 4 : 1);
  // out-of-line values (those over 4 bytes) go after the table, each word aligned
  let extra = 0;
  const place = new Map();
  for (const e of entries) {
    const n = sizeOf(e[1], e[2]);
    if (n > 4) { place.set(e, 8 + tableBytes + extra); extra += (n + 1) & ~1; }
  }
  const stripBase = 8 + tableBytes + extra;
  entries.find((e) => e[0] === 273)[3] = Array.from({ length: strips }, (_, i) => stripBase + i * rowsPerStrip * rowBytes);

  const meta = new ArrayBuffer(stripBase);
  const dv = new DataView(meta);
  const bytes = new Uint8Array(meta);
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); // "II", little endian
  dv.setUint16(8, entries.length, true);
  const writeValues = (offset, type, values) => {
    if (values instanceof Uint8Array) { bytes.set(values, offset); return; }
    values.forEach((v, i) => (type === SHORT ? dv.setUint16(offset + i * 2, v, true) : dv.setUint32(offset + i * 4, v, true)));
  };
  entries.forEach((e, i) => {
    const at = 10 + i * 12;
    const [tag, type, count, values] = e;
    dv.setUint16(at, tag, true);
    dv.setUint16(at + 2, type, true);
    dv.setUint32(at + 4, count, true);
    if (place.has(e)) {
      dv.setUint32(at + 8, place.get(e), true);
      writeValues(place.get(e), type, values);
    } else {
      writeValues(at + 8, type, values);
    }
  });
  dv.setUint32(10 + entries.length * 12, 0, true); // no further image

  const parts = [meta];
  for (let i = 0; i < strips; i++) {
    const start = i * rowsPerStrip * width * channels;
    const rows = Math.min(rowsPerStrip, height - i * rowsPerStrip);
    parts.push(new Uint8Array(data.buffer, data.byteOffset + start * bytesPer, rows * rowBytes));
  }
  return new Blob(parts, { type: "image/tiff" });
}

// ------------------------------------------------------------------------------- the encoders

export const FORMATS = {
  png: { label: "PNG", mime: "image/png", ext: "png" },
  jpeg: { label: "JPEG", mime: "image/jpeg", ext: "jpg", lossy: true },
  webp: { label: "WebP", mime: "image/webp", ext: "webp", lossy: true },
  tiff: { label: "TIFF", mime: "image/tiff", ext: "tif" },
};

const MAX_DIMENSION = { png: 32767, jpeg: 65535, webp: 16383 }; // limits of the encoders

/**
 * @param {object} image
 *   rendered: {width, height, rgba: Uint8ClampedArray, gray?: boolean}   (what is on screen)
 *   raw:      {width, height, raw: Uint8Array|Int8Array|Uint16Array|Int16Array|Float32Array}   (voxel values)
 * @param {"png"|"jpeg"|"webp"|"tiff"} format
 * @param {number} quality 0..1, for the lossy formats
 * @param {string} description  stored in the TIFF
 */
export async function encodeImage(image, format, quality = 0.95, description = "") {
  const { width, height } = image;
  if (format === "tiff") {
    if (image.raw) return encodeTiff({ width, height, channels: 1, data: image.raw, description });
    const px = width * height;
    if (image.gray) {
      const g = new Uint8Array(px);
      for (let i = 0; i < px; i++) g[i] = image.rgba[i * 4];
      return encodeTiff({ width, height, channels: 1, data: g, description });
    }
    const rgb = new Uint8Array(px * 3);
    for (let i = 0, j = 0; i < px; i++, j += 3) {
      rgb[j] = image.rgba[i * 4]; rgb[j + 1] = image.rgba[i * 4 + 1]; rgb[j + 2] = image.rgba[i * 4 + 2];
    }
    return encodeTiff({ width, height, channels: 3, data: rgb, description });
  }

  if (image.raw) throw new Error("Raw voxel values can only be saved as TIFF");
  const f = FORMATS[format];
  if (Math.max(width, height) > MAX_DIMENSION[format]) {
    throw new Error(`${f.label} cannot hold an image this large (${width} \u00d7 ${height}). Use TIFF, or export the visible area.`);
  }
  const data = new ImageData(image.rgba, width, height);
  let blob;
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d").putImageData(data, 0, 0);
      blob = await canvas.convertToBlob({ type: f.mime, quality });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").putImageData(data, 0, 0);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, f.mime, quality));
    }
  } catch (err) {
    throw new Error(`The browser could not encode a ${width} \u00d7 ${height} ${f.label} image (${err.message}). Use TIFF, or export the visible area.`);
  }
  if (!blob) throw new Error(`The browser could not encode a ${width} \u00d7 ${height} ${f.label} image. Use TIFF, or export the visible area.`);
  if (blob.type !== f.mime) throw new Error(`This browser cannot save ${f.label} images. Choose another format.`);
  return blob;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "image";

// --------------------------------------------------------------------------------- the panel

const MAX_PIXELS = 600e6; // beyond this the browser (or the GPU readback) will give up

/**
 * Opens (or closes) the export panel. It is not modal: the view stays usable, and the panel can stay open
 * while you move to another slice and export again.
 *
 * @param {object} o
 * @param {Element} o.anchor  the button that opens it
 * @param {string} o.baseName  start of the file names
 * @param {string} o.description  stored in TIFF files
 * @param {() => Array<{id: string, label: string, kind: "3d"|"slice", name: string}>} o.targets  what can be exported now
 * @param {(id: string, area: string) => ({width: number, height: number}|null)} o.sizeOf  size of the result, if known up front
 * @param {(id: string, opts: {area: string, raw: boolean}, onProgress: (text: string) => void) => Promise<object>} o.capture
 * @param {() => string} [o.note3d]  an extra sentence about the 3D render (e.g. the Max detail level in use)
 */
export function openExportPanel({ anchor, baseName, description, targets, sizeOf, capture, note3d, onClose }) {
  const root = document.createElement("div");
  root.className = "export-form";
  root.innerHTML = `
    <div class="field"><label for="ex-what">Export</label><select id="ex-what"></select></div>
    <div class="row">
      <div class="field"><label for="ex-format">Format</label>
        <select id="ex-format">${Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join("")}</select></div>
      <div class="field" id="ex-q-wrap" hidden><label for="ex-quality">Quality</label>
        <select id="ex-quality"><option value="1">Maximum</option><option value="0.95" selected>High (95)</option><option value="0.85">Medium (85)</option></select></div>
    </div>
    <div id="ex-slice-opts">
      <div class="field"><label for="ex-area">Area</label>
        <select id="ex-area"><option value="whole">Whole slice</option><option value="visible">Visible area only</option></select></div>
      <div class="field"><label for="ex-data">Pixel values</label>
        <select id="ex-data"><option value="shown">As displayed (window, colours)</option><option value="raw">Raw voxel values (TIFF only)</option></select></div>
    </div>
    <p class="hint" id="ex-info"></p>
    <div class="actions"><button type="button" class="primary" id="ex-go">Save image</button><span class="status" id="ex-status" role="status"></span></div>`;
  const $ = (id) => root.querySelector(`#${id}`);

  const current = () => targets().find((t) => t.id === $("ex-what").value);

  function fillTargets() {
    const keep = $("ex-what").value;
    const list = targets();
    $("ex-what").innerHTML = list.length
      ? list.map((t) => `<option value="${t.id}">${t.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</option>`).join("")
      : `<option value="">Nothing to export yet</option>`;
    if (list.some((t) => t.id === keep)) $("ex-what").value = keep;
    refresh();
  }

  function refresh() {
    const t = current();
    const isSlice = t?.kind === "slice";
    const format = $("ex-format").value;
    $("ex-slice-opts").hidden = !isSlice;
    $("ex-q-wrap").hidden = !FORMATS[format].lossy;
    const rawOption = $("ex-data").querySelector('option[value="raw"]');
    rawOption.disabled = format !== "tiff";
    if (format !== "tiff" && $("ex-data").value === "raw") $("ex-data").value = "shown";
    $("ex-go").disabled = !t;
    let info = "";
    if (t) {
      const size = sizeOf(t.id, $("ex-area").value);
      if (isSlice) {
        info = size ? `${size.width} \u00d7 ${size.height} px, one pixel per voxel (the full resolution of the data).` : "";
      } else {
        info = `${size ? `${size.width} \u00d7 ${size.height} px. ` : ""}Drawn at render scale 1.00 once the view has finished loading.`;
        const extra = note3d?.();
        if (extra) info += ` ${extra}`;
      }
    }
    $("ex-info").textContent = info;
  }

  const setStatus = (text, error = false) => {
    $("ex-status").textContent = text;
    $("ex-status").classList.toggle("error", error);
  };

  $("ex-what").addEventListener("pointerdown", fillTargets); // the layout may have changed since the panel opened
  $("ex-what").addEventListener("change", refresh);
  $("ex-format").addEventListener("change", refresh);
  $("ex-area").addEventListener("change", refresh);

  $("ex-go").addEventListener("click", async () => {
    const t = current();
    if (!t) return;
    const format = $("ex-format").value;
    const area = $("ex-area").value;
    const raw = t.kind === "slice" && $("ex-data").value === "raw";
    $("ex-go").disabled = true;
    setStatus("Preparing\u2026");
    try {
      const size = sizeOf(t.id, area);
      if (size && size.width * size.height > MAX_PIXELS) throw new Error(`${size.width} \u00d7 ${size.height} px is too large to export in one piece. Export the visible area instead.`);
      const image = await capture(t.id, { area, raw }, setStatus);
      setStatus("Encoding\u2026");
      const blob = await encodeImage(image, format, Number($("ex-quality").value), description);
      const suffix = raw ? "_raw" : "";
      downloadBlob(blob, `${fileSafe(baseName)}_${fileSafe(t.name)}${suffix}.${FORMATS[format].ext}`);
      setStatus(`Saved ${image.width} \u00d7 ${image.height} px, ${(blob.size / 1048576).toFixed(1)} MB.`);
    } catch (err) {
      console.error("[export]", err);
      setStatus(err.message || String(err), true);
    } finally {
      $("ex-go").disabled = false;
    }
  });

  const panel = openFloatingPanel({ id: "export", title: "Export image", content: root, anchor, align: "right", width: 340, onClose });
  if (panel) fillTargets();
  return panel;
}
