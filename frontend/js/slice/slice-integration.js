// Glue between the viewer page and the slice views: lazy creation (nothing slice-related
// is fetched or allocated until a slice layout is chosen), the layout switcher, URL
// parameters, and the 3D overlay's link to the current kiln viewer.

import { SliceViews } from "./slice-views.js";
import { mountSliceControls, mountSlicePlaceholder } from "./slice-controls.js";
import { mountDebugPanel } from "./debug-panel.js";

/**
 * @param {object} o
 * @param {HTMLElement} o.grid        `.slice-grid`
 * @param {HTMLElement} o.seg         layout switcher: buttons with data-layout
 * @param {() => Promise<string>} o.getAccessUrl
 * @param {URLSearchParams} o.params  the page's initial query parameters
 * @param {(message: string) => void} o.onError
 * @param {boolean} [o.debug]
 */
export function setupSliceIntegration({ grid, seg, getAccessUrl, params, onError, debug = false, fetchFn }) {
  let views = null;
  let creating = null;
  let viewer = null;
  let unmountControls = null;
  let unmountDebug = null;
  let controlsHost = null;
  const buttons = [...seg.querySelectorAll("button[data-layout]")];

  const highlight = (layout) => {
    for (const b of buttons) b.classList.toggle("active", b.dataset.layout === layout);
  };
  highlight("3d");

  async function ensure() {
    if (views) return views;
    creating ??= SliceViews.create({ grid, getAccessUrl, params, fetchFn })
      .then((v) => {
        views = v;
        v.state.on("layout", ({ layout }) => highlight(layout));
        if (viewer) v.attachViewer(viewer);
        if (controlsHost) {
          unmountControls?.(); // the placeholder, if that is what is mounted
          unmountControls = mountSliceControls(controlsHost, v);
        }
        if (debug) unmountDebug = mountDebugPanel(grid.parentElement ?? grid, v);
        return v;
      })
      .finally(() => { creating = null; });
    return creating;
  }

  async function requestLayout(layout) {
    if (layout === "3d" && !views) { highlight("3d"); return; }
    seg.dataset.busy = "1";
    try {
      const v = await ensure();
      v.state.setLayout(layout);
      highlight(v.state.layout);
    } catch (err) {
      console.error("[slice] cannot start the slice views:", err);
      highlight(views?.state.layout ?? "3d");
      onError?.(`Slice views unavailable: ${err.message}`);
    } finally {
      delete seg.dataset.busy;
    }
  }

  /** "Cursor in 3D view" before the views exist: creates them (staying in the 3D layout). */
  async function enableCursor() {
    try {
      const v = await ensure();
      v.state.setOption("show3dCursor", true);
    } catch (err) {
      console.error("[slice] cannot start the slice views:", err);
      onError?.(`Slice views unavailable: ${err.message}`);
    }
  }

  for (const b of buttons) b.addEventListener("click", () => requestLayout(b.dataset.layout));

  return {
    requestLayout,
    /** Call when the page loads: opens the layout named in the URL, if any. */
    applyInitial() {
      const layout = params.get("layout");
      if (layout && layout !== "3d") return requestLayout(layout);
    },
    attachViewer(v) { viewer = v; views?.attachViewer(v); },
    detachViewer() { viewer = null; views?.detachViewer(); },
    /** (Re)builds the panel section; call after every control panel build. */
    mountControls(panelBody) {
      controlsHost = panelBody;
      unmountControls?.();
      unmountControls = views ? mountSliceControls(panelBody, views) : mountSlicePlaceholder(panelBody, enableCursor);
    },
    /** Extra query parameters for the page's URL sync (empty until the slice views exist). */
    toParams() { return views ? views.toParams() : {}; },
    get views() { return views; },
    dispose() {
      unmountControls?.();
      unmountDebug?.();
      views?.dispose();
      views = null;
    },
  };
}
