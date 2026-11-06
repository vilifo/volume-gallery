// Shared by the gallery and the manage page: the folder tree, the form that edits an item's details
// (title, description, tags, folder) and the dialogs built on them.
//
// Self-contained on purpose (no imports): the `api` object is handed in by the page, so the version
// query string of api.js does not matter here.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const compareNames = (a, b) => collator.compare(a, b);

/** "a, b ,A" -> ["a", "b"]: commas separate tags; empty ones and case-insensitive duplicates are dropped. */
export function parseTags(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text || "").split(",")) {
    const tag = part.trim().replace(/\s+/g, " ");
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out;
}

/** Lookups over the flat folder list the API returns: [{ id, name, parent_id }]. */
export function folderIndex(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const kids = new Map(); // parent id (null = top level) -> child folders, by name
  for (const f of folders) {
    const key = byId.has(f.parent_id) ? f.parent_id : null; // a parent the user cannot see counts as the top
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(f);
  }
  for (const list of kids.values()) list.sort((a, b) => compareNames(a.name, b.name));

  /** Folders from the top level down to (and including) `id`. */
  const chain = (id) => {
    const out = [];
    const seen = new Set();
    while (id != null && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      out.unshift(byId.get(id));
      id = byId.get(id).parent_id;
    }
    return out;
  };
  /** "Batch 1 / Scans", or "" for the top level. */
  const pathOf = (id) => chain(id).map((f) => f.name).join(" / ");
  /** `id` and every folder below it. */
  const subtree = (id) => {
    const out = new Set([id]);
    const stack = [id];
    while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!out.has(k.id)) { out.add(k.id); stack.push(k.id); }
    return out;
  };
  /** Every folder, depth first, with its nesting depth. */
  const flatten = () => {
    const out = [];
    const walk = (parent, depth) => { for (const f of kids.get(parent) || []) { out.push({ folder: f, depth }); walk(f.id, depth + 1); } };
    walk(null, 0);
    return out;
  };
  return { byId, kids, chain, pathOf, subtree, flatten };
}

/** <option>s for a folder picker. `exclude` leaves out a folder and everything below it (for moving a folder). */
export function folderOptionsHtml(idx, selectedId, { exclude = null, topLabel = "Top level (no folder)" } = {}) {
  const skip = exclude != null ? idx.subtree(exclude) : new Set();
  const opts = [`<option value=""${selectedId == null ? " selected" : ""}>${escapeHtml(topLabel)}</option>`];
  for (const { folder, depth } of idx.flatten()) {
    if (skip.has(folder.id)) continue;
    const pad = "\u2003".repeat(depth);
    opts.push(`<option value="${folder.id}"${folder.id === selectedId ? " selected" : ""}>${pad}${escapeHtml(folder.name)}</option>`);
  }
  return opts.join("");
}

// ------------------------------------------------------------------------------- item details

/** The form for an item's title, description, tags and folder. `p` prefixes the element ids. */
export function detailsFormHtml(item, idx, p = "details") {
  return `
    <div id="${p}-error" class="error-box" style="display:none"></div>
    <div class="field">
      <label for="${p}-title">Title</label>
      <input id="${p}-title" value="${escapeHtml(item.title)}" maxlength="200" required />
    </div>
    <div class="field">
      <label for="${p}-desc">Description</label>
      <textarea id="${p}-desc" rows="3" maxlength="5000" placeholder="Optional">${escapeHtml(item.description || "")}</textarea>
    </div>
    <div class="field">
      <label for="${p}-tags">Tags <span class="dim">(separated by commas)</span></label>
      <input id="${p}-tags" value="${escapeHtml((item.tags || []).join(", "))}" placeholder="e.g. battery, 2026, reference" />
    </div>
    <div class="field">
      <label for="${p}-folder">Folder</label>
      <select id="${p}-folder">${folderOptionsHtml(idx, item.folder_id ?? null)}</select>
    </div>`;
}

/** Reads the form made by detailsFormHtml and saves it. Resolves with the updated item. */
export async function saveDetailsForm(api, kind, item, p = "details") {
  const folder = document.getElementById(`${p}-folder`).value;
  return api.updateAsset(kind, item.id, {
    title: document.getElementById(`${p}-title`).value,
    description: document.getElementById(`${p}-desc`).value,
    tags: parseTags(document.getElementById(`${p}-tags`).value),
    folder_id: folder === "" ? null : Number(folder),
  });
}

// ---------------------------------------------------------------------------------- dialogs

function openModal(html, { className = "" } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(backdrop);
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  return { el: backdrop.firstElementChild, close };
}

const showError = (id, message) => {
  const box = document.getElementById(id);
  box.textContent = message;
  box.style.display = "block";
};

/** The "Edit details" dialog of the gallery: the details form of an item in a modal. */
export function openEditDialog({ api, kind, item, idx, onSaved }) {
  const { el, close } = openModal(`
    <h2 style="margin-top:0">Edit details</h2>
    <p class="dim mono" style="margin-top:-0.6em;font-size:0.85em">${escapeHtml(item.slug)}</p>
    ${detailsFormHtml(item, idx, "ed")}
    <div class="modal-actions">
      <button type="button" data-act="cancel">Cancel</button>
      <button type="button" class="primary" data-act="save">Save</button>
    </div>`, { className: "edit-modal" });
  el.querySelector('[data-act="cancel"]').addEventListener("click", close);
  el.querySelector('[data-act="save"]').addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      await saveDetailsForm(api, kind, item, "ed");
      close();
      onSaved?.();
    } catch (err) {
      showError("ed-error", err.message);
      e.target.disabled = false;
    }
  });
  document.getElementById("ed-title").select();
}

/** Create a folder (`folder` = null; it is made inside `parentId`), or rename / move / delete one. */
export function openFolderDialog({ api, folder = null, parentId = null, idx, onSaved }) {
  const editing = folder !== null;
  const { el, close } = openModal(`
    <h2 style="margin-top:0">${editing ? "Edit folder" : "New folder"}</h2>
    <div id="fd-error" class="error-box" style="display:none"></div>
    <div class="field">
      <label for="fd-name">Name</label>
      <input id="fd-name" value="${escapeHtml(editing ? folder.name : "")}" maxlength="80" required />
    </div>
    <div class="field">
      <label for="fd-parent">Inside</label>
      <select id="fd-parent">${folderOptionsHtml(idx, editing ? folder.parent_id : parentId, { exclude: editing ? folder.id : null, topLabel: "Top level" })}</select>
    </div>
    ${editing ? `<p class="dim" style="font-size:0.85em">Deleting a folder keeps its items and subfolders: they move up into the folder above.</p>` : ""}
    <div class="modal-actions">
      ${editing ? `<button type="button" class="danger" data-act="delete" style="margin-right:auto">Delete folder</button>` : ""}
      <button type="button" data-act="cancel">Cancel</button>
      <button type="button" class="primary" data-act="save">${editing ? "Save" : "Create"}</button>
    </div>`);
  const run = async (fn) => {
    try { await fn(); close(); onSaved?.(); } catch (err) { showError("fd-error", err.message); }
  };
  el.querySelector('[data-act="cancel"]').addEventListener("click", close);
  el.querySelector('[data-act="save"]').addEventListener("click", () => run(() => {
    const name = document.getElementById("fd-name").value;
    const parent = document.getElementById("fd-parent").value;
    const parent_id = parent === "" ? null : Number(parent);
    return editing ? api.updateFolder(folder.id, { name, parent_id }) : api.createFolder(name, parent_id);
  }));
  el.querySelector('[data-act="delete"]')?.addEventListener("click", () => {
    if (confirm(`Delete the folder \u201c${folder.name}\u201d? Its items and subfolders are kept and move up one level.`)) run(() => api.deleteFolder(folder.id));
  });
  el.querySelector("#fd-name").addEventListener("keydown", (e) => { if (e.key === "Enter") el.querySelector('[data-act="save"]').click(); });
  document.getElementById("fd-name").focus();
}
