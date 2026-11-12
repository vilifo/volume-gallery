// `?debug=slices`: a small live read-out of what the slice views are doing.

export function mountDebugPanel(host, views) {
  const el = document.createElement("pre");
  el.className = "slice-debug";
  el.style.cssText = "position:absolute;right:8px;bottom:8px;z-index:20;margin:0;padding:6px 8px;max-width:46ch;font:11px/1.35 ui-monospace,monospace;color:#9fe;background:#000b;border:1px solid #fff2;border-radius:6px;pointer-events:none;white-space:pre-wrap";
  host.appendChild(el);
  const tick = () => {
    const d = views.debugInfo();
    const st = views.state;
    el.textContent = [
      `layout ${st.layout}   cursor ${st.pos.x.toFixed(1)},${st.pos.y.toFixed(1)},${st.pos.z.toFixed(1)}   window ${Math.round(st.window.center)}/${Math.round(st.window.width)}`,
      `volume ${st.dims.x}x${st.dims.y}x${st.dims.z} ${st.dtype}  level ${views.info.level} block ${views.info.blockSize}`,
      `requests: ${d.loads} planes, ${d.fetchedBlocks} blocks fetched, ${d.cachedBlocks} from cache, ${d.aborted} aborted, ${d.inflight} in flight, ${d.queued} queued`,
      `last plane: ${d.lastMs} ms (plan ${d.lastPlanMs} ms, server ${d.lastServerPlanMs} ms; first blocks ${d.lastFirstMs} ms; ${d.lastBlocks} blocks)`,
      `cache: ${d.blocks} blocks, ${d.cacheMB} MB   streamed: ${d.streamedMB} MB   uploaded: ${d.uploadMB} MB`,
      `orientation ${JSON.stringify(st.euler())}`,
      ...Object.entries(d.panes).map(([a, p]) => `${a.padEnd(9)} shown ${p.shown ?? "-"}  pending ${p.pending ?? "-"}`),
    ].join("\n");
  };
  tick();
  const timer = setInterval(tick, 400);
  const off = views.state.on("change", tick);
  return () => { clearInterval(timer); off(); el.remove(); };
}