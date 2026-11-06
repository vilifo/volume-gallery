// The description of an item is clipped where space is short (the viewer's top bar, a gallery row).
// Making that text clickable opens the whole of it in a floating panel (see floating-panel.js).

import { openFloatingPanel } from "/js/floating-panel.js?v=org2";

/**
 * @param {HTMLElement} el   the element showing the (possibly clipped) description
 * @param {{title: string, text: string}} o
 */
export function makeDescriptionExpandable(el, { title, text }) {
  el.classList.add("desc-expandable");
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.title = "Click to read the whole description";
  const open = () => {
    const body = document.createElement("div");
    body.className = "desc-full";
    body.textContent = text; // textContent: the description is plain text
    openFloatingPanel({ id: "description", title, content: body, anchor: el, width: 420 });
  };
  el.addEventListener("click", (e) => {
    if (window.getSelection()?.toString()) return; // the user is selecting text, not opening
    e.stopPropagation();
    open();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
}
