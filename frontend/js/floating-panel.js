// A small floating panel that is NOT modal: no backdrop, the page behind stays usable. It can be
// dragged by its title bar and closed with the x button or Escape. Used for the full description of
// an item and for the image export of the volume viewer.

const panels = new Map(); // id -> { el, close }

/**
 * @param {object} o
 * @param {string} o.id          one panel per id: opening it again closes it (a toggle)
 * @param {string} o.title
 * @param {Node}   o.content
 * @param {Element} [o.anchor]   the panel opens just below this element
 * @param {"left"|"right"} [o.align]  which edge of the anchor the panel lines up with
 * @param {number} [o.width]     in CSS pixels
 * @param {() => void} [o.onClose]
 * @returns {{el: HTMLElement, close: () => void} | null}  null when the call closed an open panel
 */
export function openFloatingPanel({ id, title, content, anchor = null, align = "left", width = 380, onClose }) {
  const existing = panels.get(id);
  if (existing) {
    existing.close();
    return null;
  }

  const el = document.createElement("div");
  el.className = "float-panel";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", title);
  el.tabIndex = -1;
  el.style.width = `${width}px`;

  const head = document.createElement("div");
  head.className = "float-panel-head";
  const heading = document.createElement("span");
  heading.className = "grow";
  heading.textContent = title;
  heading.title = title;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "float-panel-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "\u00d7";
  head.append(heading, closeBtn);

  const body = document.createElement("div");
  body.className = "float-panel-body";
  body.append(content);
  el.append(head, body);
  document.body.append(el);

  // Position: under the anchor if there is one, else top right. Always kept inside the window.
  const place = (left, top) => {
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - 48))}px`;
  };
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    place(align === "right" ? a.right - el.offsetWidth : a.left, a.bottom + 8);
  } else {
    place(window.innerWidth - el.offsetWidth - 16, 72);
  }

  // Drag by the title bar
  head.addEventListener("pointerdown", (e) => {
    if (e.target === closeBtn || e.button !== 0) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  });

  const close = () => {
    if (!panels.delete(id)) return;
    el.remove();
    onClose?.();
  };
  closeBtn.addEventListener("click", close);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  panels.set(id, { el, close });
  return { el, close };
}

export const isPanelOpen = (id) => panels.has(id);
