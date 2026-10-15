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
      `layout ${st.layout}   cursor ${st.cursor.x},${st.cursor.y},${st.cursor.z}   window ${Math.round(st.window.center)}/${Math.round(st.window.width)}`,
      `volume ${st.dims.x}x${st.dims.y}x${st.dims.z} ${st.dtype}  level ${views.info.level}`,
      `requests: ${d.fetches} fetched, ${d.hits} cache hits, ${d.aborted} aborted, ${d.inflight} in flight, ${d.queued} queued`,
      `last plane: ${d.lastMs} ms total, server ${d.lastServerMs} ms (${d.lastSource || "-"})`,
      `cache: ${d.planes} planes, ${d.cacheMB} MB   uploaded: ${d.uploadMB} MB`,
      ...Object.entries(d.panes).map(([a, p]) => `${a.padEnd(9)} shown ${p.shown ?? "-"}  pending ${p.pending ?? "-"}`),
    ].join("\n");
  };
  tick();
  const timer = setInterval(tick, 400);
  const off = views.state.on("change", tick);
  return () => { clearInterval(timer); off(); el.remove(); };
}