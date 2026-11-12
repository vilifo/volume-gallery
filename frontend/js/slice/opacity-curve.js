// Editor for an opacity curve: a polyline over x = 0..1 (the windowed value) with y = 0..1 (opacity), drawn on a
// canvas with handles on a transparent overlay that also receives all pointer input.
//
// It behaves like the opacity curve of the 3D transfer function: drag a point or a line segment to move it,
// double-click empty space or a line to add a point, double-click a point to remove it. Pointer capture keeps a
// drag alive when the cursor leaves the canvas (values are clamped to 0..1, so every extreme is reachable). The
// first and last point stay at x = 0 and x = 1; only their opacity moves. A press only becomes a drag after a few
// pixels of travel, so a click or double-click never nudges a point.
//
// What is drawn behind the handles (histogram, colour fill, the line itself) is up to the caller's `paint`.

export const X_GAP = 0.002; // closest two points may get along x
const DRAG_SLOP = 3; // px a press must travel before it is a drag
const POINT_R = 5.5;
const POINT_R_LIT = 7;
const HIT_POINT = 11; // px
const HIT_LINE = 10; // px

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Index of the point nearest to (x, y) in px, within `threshold`, or -1. `pts` are in 0..1; w, h in px. */
export function nearestPoint(pts, x, y, w, h, threshold = HIT_POINT) {
  let best = -1, bestDist = Infinity;
  pts.forEach((p, i) => {
    const d = Math.hypot(p.x * w - x, (1 - p.y) * h - y);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return bestDist <= threshold ? best : -1;
}

/** Index i of the segment pts[i]..pts[i + 1] nearest to (x, y) in px, within `threshold`, or -1. */
export function nearestSegment(pts, x, y, w, h, threshold = HIT_LINE) {
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x * w, ay = (1 - pts[i].y) * h;
    const bx = pts[i + 1].x * w, by = (1 - pts[i + 1].y) * h;
    const abx = bx - ax, aby = by - ay;
    const lenSq = abx * abx + aby * aby;
    const t = lenSq > 0 ? Math.min(1, Math.max(0, ((x - ax) * abx + (y - ay) * aby) / lenSq)) : 0;
    const d = Math.hypot(x - (ax + t * abx), y - (ay + t * aby));
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return bestDist <= threshold ? best : -1;
}

/** Where point `idx` goes when the pointer is at (x, y) (0..1): end points keep x, others stay between their neighbours. */
export function movePoint(pts, idx, x, y) {
  let nx = x;
  if (idx === 0) nx = 0;
  else if (idx === pts.length - 1) nx = 1;
  else {
    const lo = pts[idx - 1].x + X_GAP, hi = pts[idx + 1].x - X_GAP;
    nx = lo > hi ? (pts[idx - 1].x + pts[idx + 1].x) / 2 : Math.min(hi, Math.max(lo, x));
  }
  return { x: nx, y: clamp01(y) };
}

/** The two moved end points of segment `idx` dragged by (dx, dy) from where it started. A segment that has the
 *  first or last point as one end only slides up and down (that point must stay at x = 0 or 1). */
export function moveSegment(pts, idx, startP0, startP1, dx, dy) {
  const pinned = idx === 0 || idx + 1 === pts.length - 1;
  const minDx = pinned ? 0 : pts[idx - 1].x + X_GAP - startP0.x;
  const maxDx = pinned ? 0 : pts[idx + 2].x - X_GAP - startP1.x;
  const cdx = minDx > maxDx ? 0 : Math.min(maxDx, Math.max(minDx, dx));
  const minDy = -Math.min(startP0.y, startP1.y);
  const maxDy = 1 - Math.max(startP0.y, startP1.y);
  const cdy = Math.min(maxDy, Math.max(minDy, dy));
  return [{ x: startP0.x + cdx, y: startP0.y + cdy }, { x: startP1.x + cdx, y: startP1.y + cdy }];
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas   the backdrop, sized by CSS; its box is the 0..1 x 0..1 area of the curve
 * @param {HTMLCanvasElement} o.overlay  covers the canvas (and may be larger, to give the end handles room)
 * @param {() => {x:number,y:number}[]} o.getPoints  copy of the current points
 * @param {(points: {x:number,y:number}[]) => void} o.setPoints
 * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} o.paint  draws the backdrop (CSS px, origin top-left)
 * @param {string} [o.color]  handle colour
 * @returns {{ redraw: () => void, destroy: () => void }}
 */
export function mountCurveEditor({ canvas, overlay, getPoints, setPoints, paint, color = "#e8a33d" }) {
  let drag = null; // { type: "point" | "line", index, startX, startY (client px), moved, startPt?, startP0?, startP1? }
  let hover = -1;

  function redraw() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // hidden
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, rect.width, rect.height);
    paint(c, rect.width, rect.height);

    const sr = overlay.getBoundingClientRect();
    const ow = Math.round(sr.width * dpr), oh = Math.round(sr.height * dpr);
    if (overlay.width !== ow || overlay.height !== oh) { overlay.width = ow; overlay.height = oh; }
    const ctx = overlay.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, sr.width, sr.height);
    const ox = rect.left - sr.left, oy = rect.top - sr.top;
    const pts = getPoints();
    const at = (p) => [ox + p.x * rect.width, oy + (1 - p.y) * rect.height];

    if (drag?.type === "line" && pts[drag.index] && pts[drag.index + 1]) {
      const [x0, y0] = at(pts[drag.index]);
      const [x1, y1] = at(pts[drag.index + 1]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke();
    }
    ctx.lineWidth = 2;
    pts.forEach((p, i) => {
      const active = (drag?.type === "point" && drag.index === i) || (drag?.type === "line" && (drag.index === i || drag.index + 1 === i));
      const lit = active || (!drag && hover === i);
      const [x, y] = at(p);
      ctx.beginPath();
      ctx.arc(x, y, lit ? POINT_R_LIT : POINT_R, 0, Math.PI * 2);
      ctx.fillStyle = lit ? "#ffc15e" : color;
      ctx.strokeStyle = lit ? "#ffffff" : "rgba(20,23,28,0.9)";
      ctx.fill(); ctx.stroke();
    });
  }

  // pointer -> 0..1 (clamped, so a pointer that left the canvas maps to its nearest edge) and px in the canvas box
  function locate(evt) {
    const r = canvas.getBoundingClientRect();
    const px = evt.clientX - r.left, py = evt.clientY - r.top;
    return { w: r.width, h: r.height, px, py, x: clamp01(px / r.width), y: clamp01(1 - py / r.height) };
  }

  function apply(points) { setPoints(points); redraw(); }

  function endDrag() {
    if (drag === null) return;
    drag = null;
    overlay.style.cursor = "crosshair";
    redraw();
  }

  overlay.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    evt.preventDefault();
    const at = locate(evt);
    const pts = getPoints();
    const press = { startX: evt.clientX, startY: evt.clientY, moved: false };
    const pi = nearestPoint(pts, at.px, at.py, at.w, at.h);
    if (pi >= 0) drag = { type: "point", index: pi, ...press };
    else {
      const si = nearestSegment(pts, at.px, at.py, at.w, at.h);
      if (si >= 0) drag = { type: "line", index: si, startPt: { x: at.x, y: at.y }, startP0: { ...pts[si] }, startP1: { ...pts[si + 1] }, ...press };
    }
    if (drag) {
      overlay.setPointerCapture(evt.pointerId);
      overlay.style.cursor = "grabbing";
      redraw();
    }
  });

  overlay.addEventListener("pointermove", (evt) => {
    const at = locate(evt);
    if (drag === null) {
      const pts = getPoints();
      const pi = nearestPoint(pts, at.px, at.py, at.w, at.h);
      overlay.style.cursor = pi >= 0 || nearestSegment(pts, at.px, at.py, at.w, at.h) >= 0 ? "grab" : "crosshair";
      if (pi !== hover) { hover = pi; redraw(); }
      return;
    }
    if (!drag.moved) {
      if (Math.hypot(evt.clientX - drag.startX, evt.clientY - drag.startY) < DRAG_SLOP) return;
      drag.moved = true;
    }
    const pts = getPoints();
    if (drag.type === "point") {
      if (drag.index >= pts.length) return;
      pts[drag.index] = movePoint(pts, drag.index, at.x, at.y);
      apply(pts);
    } else {
      if (drag.index + 1 >= pts.length) return;
      const [p0, p1] = moveSegment(pts, drag.index, drag.startP0, drag.startP1, at.x - drag.startPt.x, at.y - drag.startPt.y);
      pts[drag.index] = p0;
      pts[drag.index + 1] = p1;
      apply(pts);
    }
  });

  overlay.addEventListener("pointerleave", () => { if (!drag && hover !== -1) { hover = -1; redraw(); } });
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);
  overlay.addEventListener("lostpointercapture", endDrag);

  overlay.addEventListener("dblclick", (evt) => {
    const at = locate(evt);
    const pts = getPoints();
    const pi = nearestPoint(pts, at.px, at.py, at.w, at.h);
    if (pi >= 0) {
      if (pi === 0 || pi === pts.length - 1) return; // the end points stay
      pts.splice(pi, 1);
    } else {
      if (pts.some((p) => Math.abs(p.x - at.x) < X_GAP)) return; // no room: a point is already there along x
      pts.push({ x: at.x, y: at.y });
      pts.sort((a, b) => a.x - b.x);
    }
    apply(pts);
  });

  const ro = new ResizeObserver(() => redraw());
  ro.observe(overlay);
  redraw();
  return { redraw, destroy: () => ro.disconnect() };
}
