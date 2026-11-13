// The Bookmarks panel of the volume viewer: save the view you have (camera, render settings, slice position,
// with a small picture) and come back to it later. Not modal. Bookmarks can also be used as the views of a
// camera path (see the Animate panel).

import { openFloatingPanel } from "./floating-panel.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * @param {object} o
 * @param {Element} o.anchor
 * @param {object} o.store   the bookmark store (saved-paths.js)
 * @param {() => Promise<object>} o.capture   the current view as a BookmarkSpec
 * @param {(entry: object) => Promise<void>} o.restore
 * @param {() => void} [o.onChange]  called after the list changed (the animate panel shows the same bookmarks)
 */
export function openBookmarksPanel({ anchor, store, capture, restore, onChange, onClose }) {
  const root = document.createElement("div");
  root.className = "export-form bookmarks";
  root.innerHTML = `
    <div id="bm-list" class="bm-list"></div>
    <div class="field" style="margin-top:0.8em"><label for="bm-name">Bookmark the view you have now</label>
      <input id="bm-name" maxlength="80" placeholder="Name" />
      <div class="actions" style="margin-top:0.4em;flex-wrap:wrap"><button type="button" class="primary" id="bm-save-local">Save in this browser</button><button type="button" id="bm-save-shared">Save for everyone</button></div>
      <p class="hint" id="bm-hint"></p></div>
    <div class="actions"><span class="status" id="bm-status" role="status"></span></div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const setStatus = (t, error = false) => { $("bm-status").textContent = t; $("bm-status").classList.toggle("error", error); };
  let entries = [];

  $("bm-save-shared").hidden = !store.canShare;
  $("bm-hint").textContent = store.canShare
    ? "A bookmark saved in this browser is private to you. One saved for everyone is kept on the server: everybody who can see this volume can restore it, and it has a link that opens the viewer on it."
    : "A bookmark saved here stays in this browser. Editors can also save bookmarks for everybody.";

  async function refresh() {
    entries = await store.list();
    const card = (e) => `
      <div class="bm-card" data-key="${e.scope}:${e.id}" tabindex="0" role="button" title="Go to this view">
        <div class="bm-thumb">${e.spec.thumb ? `<img src="${esc(e.spec.thumb)}" alt="" />` : "<span>no picture</span>"}</div>
        <div class="bm-meta"><div class="bm-name">${esc(e.name)}</div>
          <div class="bm-sub">${e.scope === "shared" ? `For everyone${e.author ? ` \u00b7 ${esc(e.author)}` : ""}` : "This browser"}</div></div>
        <div class="bm-actions">
          ${e.scope === "shared" ? `<button type="button" data-act="link" title="Copy a link that opens this view">Link</button>` : ""}
          ${e.scope === "local" || store.canShare ? `<button type="button" data-act="delete" title="Delete">\u00d7</button>` : ""}
        </div>
      </div>`;
    $("bm-list").innerHTML = entries.length ? entries.map(card).join("") : `<p class="hint">No bookmarks yet.</p>`;
  }

  const find = (el) => entries.find((e) => `${e.scope}:${e.id}` === el.closest(".bm-card")?.dataset.key);

  $("bm-list").addEventListener("click", async (ev) => {
    const entry = find(ev.target);
    if (!entry) return;
    const act = ev.target.closest("[data-act]")?.dataset.act;
    try {
      if (act === "delete") {
        if (!confirm(`Delete the bookmark \u201c${entry.name}\u201d${entry.scope === "shared" ? " for everybody" : ""}?`)) return;
        await store.remove(entry);
        await refresh();
        onChange?.();
      } else if (act === "link") {
        const url = store.link(entry);
        try { await navigator.clipboard.writeText(url); setStatus("Link copied."); } catch (_) { window.prompt("Copy this link", url); }
      } else {
        setStatus(`Going to \u201c${entry.name}\u201d\u2026`);
        await restore(entry);
        setStatus("");
      }
    } catch (err) {
      console.error("[bookmarks]", err);
      setStatus(err.message || String(err), true);
    }
  });
  $("bm-list").addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.classList?.contains("bm-card")) { ev.preventDefault(); ev.target.click(); }
  });

  for (const scope of ["local", "shared"]) {
    $(`bm-save-${scope}`).addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        const name = $("bm-name").value.trim() || `View ${entries.length + 1}`;
        const entry = await store.save(scope, name, await capture());
        $("bm-name").value = "";
        await refresh();
        onChange?.();
        setStatus(`Saved \u201c${entry.name}\u201d ${scope === "shared" ? "for everyone" : "in this browser"}.`);
      } catch (err) {
        console.error("[bookmarks]", err);
        setStatus(err.message || String(err), true);
      } finally {
        ev.target.disabled = false;
      }
    });
  }

  const panel = openFloatingPanel({ id: "bookmarks", title: "Bookmarks", content: root, anchor, align: "right", width: 360, onClose });
  if (panel) refresh();
  return panel;
}
