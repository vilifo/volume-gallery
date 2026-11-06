// Saved things for a volume: paths (camera paths, turntables, slice sweeps; a "spec", see PlaybackSpec in the
// backend) and bookmarks (saved views, see BookmarkSpec). Two places for each:
//   "local"  - this browser (localStorage), for every user, private to them
//   "shared" - the database, written by editors and administrators, read by everybody who can see the volume;
//              these have a link that opens them by themselves (?play=<id> / ?bookmark=<id>)
//
// Self-contained: the `api` object is handed in by the page.

const newId = () => (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * @param {object} o
 * @param {string} o.storageKey  localStorage key
 * @param {string} o.linkParam   query parameter of the link that opens a shared entry
 * @param {boolean} o.canShare   may write to the database
 * @param {{list: Function, get: Function, create: Function, update: Function, remove: Function}} o.remote
 * @param {string} o.volumeId
 * @param {string} o.what        for messages ("path", "bookmark")
 */
function createStore({ storageKey, linkParam, canShare, remote, volumeId, what }) {
  const readLocal = () => {
    try { const v = JSON.parse(localStorage.getItem(storageKey) || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  };
  const writeLocal = (list) => localStorage.setItem(storageKey, JSON.stringify(list));

  return {
    canShare,

    /** All entries: the shared ones first, then this browser's. Each: {scope, id, name, spec, author?}. */
    async list() {
      let shared = [];
      try {
        shared = (await remote.list()).map((p) => ({ scope: "shared", id: p.id, name: p.name, spec: p.spec, author: p.created_by_name }));
      } catch (err) {
        console.warn(`[${what}s] could not load the shared ones:`, err);
      }
      return [...shared, ...readLocal().map((e) => ({ scope: "local", id: e.id, name: e.name, spec: e.spec }))];
    },

    /** Saves an entry; one with the same name in the same place is replaced. Resolves with the saved entry. */
    async save(scope, name, spec) {
      name = name.trim();
      if (!name) throw new Error(`Give the ${what} a name`);
      if (scope === "shared") {
        if (!canShare) throw new Error(`Only editors can save a ${what} for everybody`);
        const existing = (await this.list()).find((e) => e.scope === "shared" && sameName(e.name, name));
        const saved = existing ? await remote.update(existing.id, { name, spec }) : await remote.create({ name, spec });
        return { scope, id: saved.id, name: saved.name, spec: saved.spec };
      }
      const list = readLocal();
      const at = list.findIndex((e) => sameName(e.name, name));
      const entry = { id: at >= 0 ? list[at].id : newId(), name, spec };
      if (at >= 0) list[at] = entry; else list.push(entry);
      try {
        writeLocal(list);
      } catch (_) {
        throw new Error("This browser has no room left to save it");
      }
      return { scope, ...entry };
    },

    async remove(entry) {
      if (entry.scope === "shared") await remote.remove(entry.id);
      else writeLocal(readLocal().filter((e) => e.id !== entry.id));
    },

    /** One shared entry by id (what the link opens). */
    async getShared(id) {
      const p = await remote.get(id);
      return { scope: "shared", id: p.id, name: p.name, spec: p.spec };
    },

    /** The link that opens the viewer on this entry (shared entries only). */
    link(entry) {
      if (entry.scope !== "shared") return null;
      const url = new URL("/viewers/volume.html", window.location.origin);
      url.searchParams.set("id", String(volumeId));
      url.searchParams.set(linkParam, String(entry.id));
      return url.toString();
    },
  };
}

/** @param {{api: object, volumeId: number|string, canShare: boolean}} o */
export function createPathStore({ api, volumeId, canShare }) {
  return createStore({
    storageKey: `vg_paths_v1_${volumeId}`, linkParam: "play", canShare, volumeId, what: "path",
    remote: {
      list: () => api.listVolumePaths(volumeId),
      get: (id) => api.getVolumePath(volumeId, id),
      create: (body) => api.createVolumePath(volumeId, body),
      update: (id, body) => api.updateVolumePath(volumeId, id, body),
      remove: (id) => api.deleteVolumePath(volumeId, id),
    },
  });
}

/** @param {{api: object, volumeId: number|string, canShare: boolean}} o */
export function createBookmarkStore({ api, volumeId, canShare }) {
  return createStore({
    storageKey: `vg_bookmarks_v1_${volumeId}`, linkParam: "bookmark", canShare, volumeId, what: "bookmark",
    remote: {
      list: () => api.listVolumeBookmarks(volumeId),
      get: (id) => api.getVolumeBookmark(volumeId, id),
      create: (body) => api.createVolumeBookmark(volumeId, body),
      update: (id, body) => api.updateVolumeBookmark(volumeId, id, body),
      remove: (id) => api.deleteVolumeBookmark(volumeId, id),
    },
  });
}
