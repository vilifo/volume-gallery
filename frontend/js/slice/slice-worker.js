// One pane's slice worker (see worker-plane-client.js, which starts three: xy, xz, yz).
//
// It does what the main thread's PlaneClient does for a plane - POST .../plan, the missing blocks streamed from
// POST .../blocks, a PlaneAssembler building the image - off the main thread, against the block cache that the
// three workers share (block-cache.js). The page gets the picture as it fills in: the whole image once, then the
// rows that changed (about every 8 ms while blocks arrive), and draws them with WebGPU as before.
//
// Messages from the page:  init { baseUrl, cache, maxInflight } | url { baseUrl } | load { id, spec, channel,
//   priority, prefetch, underlayId } | abort { id } | shown { id } | dispose
// Messages to the page:    refresh { stale } (the token ran out: send a new url) | update { id, init?, rows?, pending, complete }
//   | done { id, plan, stats } | error { id, name, message, status }

import { PlaneClient, PlaneError } from "./plane-client.js?v=mpr2";
import { SharedBlockCache } from "./block-cache.js?v=mpr2";

const FLUSH_MS = 8;

let client = null;
let pendingUrl = null;     // resolvers of a refresh in flight
const jobs = new Map();    // id -> { ac, asm, sentInit, timer }
let shown = null;          // { id, data, width, height, dtype }: the image the page shows (the underlay of the next one)
let lastDone = null;       // { id, asm } of the job that finished last (the page tells us it shows it a moment later)

function refreshUrl(refused) {
  return new Promise((resolve) => {
    if (!pendingUrl) {
      pendingUrl = [];
      self.postMessage({ type: "refresh", stale: refused }); // (the url that was refused: the page may have a newer one already)
    }
    pendingUrl.push(resolve);
  });
}

function init({ baseUrl, cache, maxInflight }) {
  client = new PlaneClient({ baseUrl, refreshUrl, cache: new SharedBlockCache(cache), maxInflight });
}

function sendUpdate(id, job, final) {
  clearTimeout(job.timer);
  job.timer = 0;
  const asm = job.asm;
  if (!asm) return;
  const w = asm.width;
  const msg = { type: "update", id, pending: asm.pending, complete: asm.complete };
  const transfer = [];
  if (!job.sentInit) {
    job.sentInit = true;
    asm.takeDirty();
    const buffer = asm.data.slice().buffer; // the whole image, once
    msg.init = { width: w, height: asm.height, dtype: asm.plane.dtype, buffer };
    transfer.push(buffer);
  } else {
    const rows = asm.takeDirty();
    if (!rows && !final) return;
    if (rows) {
      const buffer = asm.data.slice(rows.r0 * w, (rows.r1 + 1) * w).buffer;
      msg.rows = { r0: rows.r0, r1: rows.r1, buffer };
      transfer.push(buffer);
    }
  }
  self.postMessage(msg, transfer);
}

function load({ id, spec, channel, priority, prefetch, underlayId }) {
  const job = { ac: new AbortController(), asm: null, sentInit: false, timer: 0 };
  jobs.set(id, job);
  const underlay = !prefetch && shown && shown.id === underlayId ? shown : null;
  client
    .loadPlane(spec, {
      channel,
      priority,
      prefetch,
      signal: job.ac.signal,
      underlay,
      onUpdate: (asm) => {
        if (!asm) return;
        job.asm = asm;
        if (!job.sentInit) sendUpdate(id, job, false); // the first image goes at once
        else job.timer ||= setTimeout(() => sendUpdate(id, job, false), FLUSH_MS);
      },
    })
    .then(({ plan, assembler }) => {
      if (job.ac.signal.aborted) return;
      if (assembler) {
        job.asm = assembler;
        sendUpdate(id, job, true);
        lastDone = { id, asm: assembler };
      }
      self.postMessage({ type: "done", id, plan: { ...plan, blocks: [] }, stats: client.stats() });
    })
    .catch((err) => {
      clearTimeout(job.timer);
      if (job.ac.signal.aborted) return;
      self.postMessage({ type: "error", id, name: err?.name ?? "Error", message: err?.message ?? String(err), status: err instanceof PlaneError ? err.status : 0 });
    })
    .finally(() => jobs.delete(id));
}

function setShown(id) {
  const asm = jobs.get(id)?.asm ?? (lastDone?.id === id ? lastDone.asm : null);
  shown = asm ? { id, width: asm.width, height: asm.height, dtype: asm.plane.dtype, data: asm.data } : null;
  if (lastDone && lastDone.id !== id) lastDone = null; // (only what the page may still tell us it shows is kept)
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case "init": init(m); break;
    case "url":
      client.baseUrl = m.baseUrl;
      for (const resolve of pendingUrl ?? []) resolve(m.baseUrl);
      pendingUrl = null;
      break;
    case "load": load(m); break;
    case "abort": jobs.get(m.id)?.ac.abort(); break;
    case "shown": setShown(m.id); break;
    case "dispose":
      for (const job of jobs.values()) job.ac.abort();
      client?.dispose();
      self.close();
      break;
    default: break;
  }
};
