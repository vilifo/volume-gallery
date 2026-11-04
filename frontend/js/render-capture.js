// Capturing the kiln 3D render as pixels once it has finished refining: shared by the image export and
// the animation renderer.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export const accessExpiredError = () => Object.assign(new Error("Access to the volume\u2019s data expired"), { expired: true });

/**
 * Waits until the view has finished: nothing left to stream in, drawn at render scale 1.00 and the
 * progressive accumulation converged (it must hold for a few checks in a row). Gives up after `timeoutMs`
 * and carries on with what is there.
 * @param {object} viewer  the KilnViewer
 * `expired` tells when the data access token ran out (bricks refused): then this throws an error with
 * `.expired = true`, because what is on screen is incomplete and will not get better until access is renewed.
 * @param {{isCurrent?: () => boolean, onProgress?: (text: string) => void, timeoutMs?: number, minMs?: number, expired?: () => boolean}} [o]
 * @returns {Promise<{complete: boolean}>}
 */
export async function waitForRefined(viewer, { isCurrent = () => true, onProgress = () => {}, timeoutMs = 60000, minMs = 0, expired = () => false } = {}) {
  const started = performance.now();
  let calm = 0;
  while (calm < 4 || performance.now() - started < minMs) {
    if (!isCurrent()) throw new Error("The volume was reloaded. Try again.");
    if (expired()) throw accessExpiredError();
    const pending = viewer.streamingManager.getStats().pendingCount;
    const ready = pending === 0 && viewer.renderer.renderScale === 1 && viewer.renderer.isConverged;
    calm = ready ? calm + 1 : 0;
    if (performance.now() - started > timeoutMs) return { complete: false };
    onProgress(
      document.hidden ? "Keep this tab in front: the browser pauses drawing in the background"
        : ready ? "Rendering\u2026"
        : `Refining the view\u2026${pending ? ` (${pending} blocks to load)` : ""}`,
    );
    await sleep(150);
  }
  if (expired()) throw accessExpiredError();
  return { complete: true };
}

/** The current render as {width, height, rgba} (opaque). Call after waitForRefined. */
export async function captureRgba(viewer) {
  const bitmap = await createImageBitmap(await viewer.captureImage("image/png"));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
  return { width: canvas.width, height: canvas.height, rgba: image.data };
}

/** One still at render scale 1.00, once the view has finished refining. */
export async function captureStill(viewer, { isCurrent, onProgress, expired = () => false } = {}) {
  const previous = viewer.renderScale;
  viewer.renderScale = 1;
  try {
    await waitForRefined(viewer, { isCurrent, onProgress, expired });
    const image = await captureRgba(viewer);
    if (expired()) throw accessExpiredError();
    return image;
  } finally {
    viewer.renderScale = previous;
  }
}

/** Resolves after the browser has drawn at least two frames (a changed camera has reached the renderer). */
export async function afterFrames() {
  await nextFrame();
  await nextFrame();
}

/**
 * Makes the render canvas `width` x `height` pixels (CSS size = pixel size) and waits until the viewer has
 * resized its buffers to match. Returns a function that puts the canvas back.
 */
export async function resizeCanvasTo(canvas, pane, width, height) {
  const saved = { canvas: canvas.style.cssText, pane: pane.style.cssText };
  pane.style.overflow = "hidden";
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const restore = async () => {
    canvas.style.cssText = saved.canvas;
    pane.style.cssText = saved.pane;
    await sleep(50);
  };
  const started = performance.now();
  while (canvas.width !== width || canvas.height !== height) {
    if (performance.now() - started > 6000) {
      const got = `${canvas.width} \u00d7 ${canvas.height}`;
      await restore();
      throw new Error(`The graphics card could not provide a ${width} \u00d7 ${height} image (it gave ${got}). Choose a smaller size.`);
    }
    await sleep(100);
  }
  await afterFrames();
  return restore;
}
