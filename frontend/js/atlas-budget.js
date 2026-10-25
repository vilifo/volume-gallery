// VRAM budget for kiln-render's 3D brick atlas.
//
// kiln-render keeps streamed bricks in one cubic GPU texture per channel
// (gridSize^3 slots of 66^3 voxels). The atlas is as large as the VRAM
// allocation the user picked in the viewer's Advanced section, except that it
// is never larger than the dataset can fill. A larger atlas keeps more bricks
// resident, so fewer are evicted and downloaded again; the unused remainder
// of an oversized atlas would only waste VRAM.
//
// The GPU is deliberately not probed: the choice is the user's. The bundled
// engine still clamps the grid to the device's 3D texture limit and steps it
// down if the allocation does not fit (see the patch in kiln-render.js).

// Mirrors of kiln-render constants.
const PHYSICAL_BRICK_SIZE = 66;
const LOGICAL_BRICK_SIZE = 64;
const MIN_GRID = 6;
const MAX_GRID = 32;
const MB = 1e6;

export const ATLAS_VRAM_OPTIONS_MB = [256, 512, 1000, 2000, 3000, 4000, 6000];
export const DEFAULT_ATLAS_VRAM_MB = 1000;

const STORAGE_KEY = "volumeGallery.atlasVramMB";

export function formatVram(mb) {
  return mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`;
}

/** The remembered choice (per browser), or the default. Never throws. */
export function loadSavedAtlasMB() {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    if (ATLAS_VRAM_OPTIONS_MB.includes(v)) return v;
  } catch {
    // storage unavailable (private mode, blocked): fall through
  }
  return DEFAULT_ATLAS_VRAM_MB;
}

export function saveAtlasMB(mb) {
  try {
    localStorage.setItem(STORAGE_KEY, String(mb));
  } catch {
    // not remembered; the selection still applies to this page
  }
}

// ---------------------------------------------------------------------------
// Dataset probe
// ---------------------------------------------------------------------------

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return res.json();
}

function bytesPerSourceVoxel(dtype) {
  const m = String(dtype).match(/(\d+)$/); // "|u1", "<u2", "<f4" / "uint16", "float32"
  if (!m) return 2;
  const n = parseInt(m[1], 10);
  return /^[|<>=]?[uifb]\d$/.test(dtype) ? n : n / 8;
}

/**
 * Reads shape / dtype of the finest LOD this sharded volume exposes (the backend
 * already truncates the pyramid to the user's "max detail level"). The files
 * are the ones kiln-render fetches first anyway and are served with immutable
 * cache headers, so this costs no extra transfer.
 * Resolves to null when anything is unexpected.
 *
 * @param {string} baseUrl signed sharded-volume URL (ends with "/")
 * @returns {Promise<null | {dims: number[], channels: number, texBytes: number}>}
 */
export async function probeDataset(baseUrl, signal) {
  try {
    const root = await fetchJson(baseUrl.endsWith("/") ? `${baseUrl}volume.json` : `${baseUrl}/volume.json`, signal);
    const level = root?.levels?.[0];
    const dims = level?.dimensions; // [width, height, depth]
    if (!Array.isArray(dims) || dims.length !== 3) return null;
    const dtype = String(root?.format ?? "uint8").toLowerCase();
    const channels = 1; // kiln sharded binary is single-channel scalar data
    const texBytes = dtype === "uint8" ? 1 : 2;
    if (dims.some((d) => !(Number(d) > 0))) return null;
    return { dims: [Number(dims[2]), Number(dims[1]), Number(dims[0])], channels, texBytes };
  } catch (err) {
    if (err?.name !== "AbortError") console.warn("[atlas] dataset probe failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Smallest grid that holds every brick of the finest level plus the coarser ones. */
function gridToHold(dims) {
  const bricks = dims.reduce((n, d) => n * Math.ceil(d / LOGICAL_BRICK_SIZE), 1);
  const slots = Math.ceil((bricks * 8) / 7); // the rest of the pyramid adds 1/8 + 1/64 + ...
  return Math.max(MIN_GRID, Math.min(MAX_GRID, Math.ceil(Math.cbrt(slots))));
}

function budgetForGrid(grid, channels, texBytes) {
  // +0.5 % so float rounding in the engine's cbrt() cannot land one grid short.
  return Math.ceil(channels * texBytes * (grid * PHYSICAL_BRICK_SIZE) ** 3 * 1.005);
}

/**
 * The `atlasBudgetBytes` to hand to KilnViewer.create().
 *
 * @param {string} baseUrl signed sharded-volume URL
 * @param {{vramMB: number, signal?: AbortSignal}} opts the user's VRAM choice
 * @returns {Promise<{budgetBytes: number, source: "selected limit"|"dataset fits"}>}
 */
export async function planAtlas(baseUrl, { vramMB, signal }) {
  const limitBytes = vramMB * MB;
  const dataset = await probeDataset(baseUrl, signal);
  if (!dataset) return { budgetBytes: limitBytes, source: "selected limit" };

  const needBytes = budgetForGrid(gridToHold(dataset.dims), dataset.channels, dataset.texBytes);
  return needBytes < limitBytes
    ? { budgetBytes: needBytes, source: "dataset fits" }
    : { budgetBytes: limitBytes, source: "selected limit" };
}
