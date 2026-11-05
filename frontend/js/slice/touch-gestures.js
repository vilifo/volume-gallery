// Touch input for a slice pane, independent of the drawing code so that it can be tested on its own.
//
//   one finger   a tap moves the crosshair; a drag does what the chosen tool says (move the crosshair,
//                pan, scroll through the slices, or window / level); a double tap resets the view
//   two fingers  pinch to zoom and drag to pan, at the same time, whatever the tool
//
// Mouse and pen input stay with the pane's own handlers: only pointerType "touch" is handled here.

const SLOP = 8;          // px a finger must move before a touch counts as a drag and not a tap
const TAP_MS = 400;      // longest touch that is still a tap
const DOUBLE_MS = 350;   // two taps this close in time ...
const DOUBLE_PX = 32;    // ... and place make a double tap

/**
 * @param {HTMLElement} el
 * @param {object} h  the pane's side of it:
 *   local(e) -> {x, y}   position inside the pane in CSS px
 *   tool() -> "cursor" | "pan" | "scroll" | "window"
 *   focus(), begin(), end()    begin / end of a manipulation (previews are used in between)
 *   tap(x, y), doubleTap(x, y)
 *   drag(tool, x, y, dx, dy)   one finger moved (dx, dy since the last call)
 *   pinch({factor, cx, cy, dx, dy})   two fingers: zoom `factor` about (cx, cy), the midpoint moved by (dx, dy)
 * @returns {{destroy: () => void}}
 */
export function bindTouchGestures(el, h) {
  const touches = new Map(); // pointerId -> {x, y, sx, sy, t}
  let drag = null;           // one finger: {id, started, px, py}
  let pinch = null;          // two fingers: {ids, dist, cx, cy}
  let lastTap = null;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const isTouch = (e) => e.pointerType === "touch";

  function onDown(e) {
    if (!isTouch(e) || e.target.closest?.(".slice-head, .slice-tools")) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* not an active pointer (synthetic) */ }
    h.focus?.();
    const p = h.local(e);
    touches.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now() });
    if (touches.size === 1) {
      drag = { id: e.pointerId, started: false, px: p.x, py: p.y };
    } else if (touches.size === 2) {
      if (drag?.started) h.end();
      drag = null;
      const [a, b] = [...touches.values()];
      pinch = { ids: [...touches.keys()].slice(0, 2), dist: Math.max(1, dist(a, b)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      h.begin();
    } // a third finger is ignored
  }

  function onMove(e) {
    if (!isTouch(e)) return;
    const t = touches.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    const p = h.local(e);
    t.x = p.x;
    t.y = p.y;
    if (pinch && pinch.ids.includes(e.pointerId)) {
      const a = touches.get(pinch.ids[0]);
      const b = touches.get(pinch.ids[1]);
      const d = Math.max(1, dist(a, b));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      h.pinch({ factor: d / pinch.dist, cx: pinch.cx, cy: pinch.cy, dx: cx - pinch.cx, dy: cy - pinch.cy });
      pinch.dist = d;
      pinch.cx = cx;
      pinch.cy = cy;
      return;
    }
    if (drag && drag.id === e.pointerId) {
      if (!drag.started) {
        if (Math.hypot(p.x - t.sx, p.y - t.sy) < SLOP) return; // still a tap
        drag.started = true;
        drag.px = t.sx;
        drag.py = t.sy;
        h.begin();
      }
      h.drag(h.tool(), p.x, p.y, p.x - drag.px, p.y - drag.py);
      drag.px = p.x;
      drag.py = p.y;
    }
  }

  function onUp(e) {
    if (!isTouch(e)) return;
    const t = touches.get(e.pointerId);
    if (!t) return;
    touches.delete(e.pointerId);
    if (pinch && pinch.ids.includes(e.pointerId)) {
      // The finger that is left must lift and touch again before it does anything: it would jump otherwise
      pinch = null;
      drag = null;
      h.end();
    } else if (drag && drag.id === e.pointerId) {
      const wasDrag = drag.started;
      drag = null;
      if (wasDrag) h.end();
      else if (e.type === "pointerup" && performance.now() - t.t < TAP_MS) tap(t.sx, t.sy);
    }
  }

  function tap(x, y) {
    const now = performance.now();
    if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_PX) {
      lastTap = null;
      h.doubleTap(x, y);
    } else {
      lastTap = { t: now, x, y };
      h.tap(x, y);
    }
  }

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  return {
    destroy() {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    },
  };
}
