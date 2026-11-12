// Showing a volume on screen by itself: a 3D turntable, a 3D camera path or a sweep through the slices,
// looping for as long as the page is open. The same descriptions (specs) as the animation renderer; here
// they run on the clock instead of being rendered frame by frame.

import { passFraction, playPose, prepareSpec, readPose, resetTfSignature, sweepIndices, writePose } from "/js/animate.js?v=tl1";
import { afterFrames, waitForLoaded } from "/js/render-capture.js?v=org4";

const PRELOAD_MAX_POSES = 160;

/**
 * @param {object} o
 * @param {HTMLElement} o.host   the element the control bar goes into (it must be what goes fullscreen)
 * @param {() => object|null} o.getViewer   the KilnViewer (it is replaced when the volume reloads)
 * @param {() => object|null} o.getSlices   the SliceViews
 * @param {() => boolean} o.is3dVisible
 * @param {(state: string) => void} [o.onChange]  "idle" | "preloading" | "playing" | "paused"
 */
export function createPlayer({ host, getViewer, getSlices, is3dVisible, onChange = () => {} }) {
  let run = null; // the running session, null when idle
  const listeners = new Set([onChange]);
  const progressListeners = new Set();

  const emit = () => listeners.forEach((fn) => { try { fn(player.state); } catch (_) { /* a listener must not stop playback */ } });
  // where the animation is: u is the fraction 0..1 of one pass (the timeline's playhead), t the seconds into it
  const emitProgress = (u, t = 0) => progressListeners.forEach((fn) => { try { fn({ u, t, state: player.state }); } catch (_) { /* as above */ } });

  // -------------------------------------------------------------------------------- control bar
  function mountBar() {
    const bar = document.createElement("div");
    bar.className = "play-bar";
    bar.innerHTML = `
      <button type="button" data-pp title="Pause">\u23f8</button>
      <button type="button" data-stop title="Stop and go back to the view you had">\u23f9</button>
      <span class="play-info" data-info></span>
      <span class="play-progress"><i data-bar></i></span>`;
    host.append(bar);
    let hideTimer = null;
    const wake = () => { bar.classList.remove("idle"); clearTimeout(hideTimer); hideTimer = setTimeout(() => bar.classList.add("idle"), 3000); };
    host.addEventListener("pointermove", wake);
    wake();
    bar.querySelector("[data-pp]").addEventListener("click", () => (player.state === "paused" ? player.resume() : player.pause()));
    bar.querySelector("[data-stop]").addEventListener("click", () => player.stop());
    return {
      el: bar,
      info: (t) => { bar.querySelector("[data-info]").textContent = t; },
      progress: (f) => { bar.querySelector("[data-bar]").style.width = `${Math.round(100 * Math.min(1, Math.max(0, f)))}%`; },
      paused: (on) => { const b = bar.querySelector("[data-pp]"); b.textContent = on ? "\u25b6" : "\u23f8"; b.title = on ? "Play" : "Pause"; wake(); },
      destroy: () => { host.removeEventListener("pointermove", wake); clearTimeout(hideTimer); bar.remove(); },
    };
  }

  // ------------------------------------------------------------------------------------ 3D view
  // While the camera moves, kiln draws at its "interaction" scale (a quarter of the pixels by default).
  // For playback that would look blurry, so it is switched off and the view is drawn at the render scale.
  function adopt(viewer, session = run) {
    session.viewer = viewer;
    viewer.camera.setFreeRotation?.(true);
    if (viewer.engine) viewer.engine.interactionRenderScale = 0;
  }

  function release() {
    const v = getViewer();
    if (!v || !run?.saved) return;
    if (v.engine) v.engine.interactionRenderScale = run.saved.interactionScale;
    resetTfSignature(v);
    writePose(v.camera, run.saved.base, v.renderer, v);
    window.dispatchEvent(new CustomEvent("vg-tf-changed", { detail: { settled: true } }));
    v.camera.setFreeRotation?.(run.saved.wasFree);
    if (!run.saved.wasFree && run.saved.orbit) v.camera.setOrbitState(run.saved.orbit);
  }

  // Steps through the animation once, waiting for the data of every step, so that the loop that follows
  // finds it in the cache. Warns when the data of the whole path does not fit in graphics memory.
  async function preload(session) {
    const viewer = getViewer();
    const { spec } = session;
    const startStats = viewer.streamingManager.getStats();
    const steps = Math.min(PRELOAD_MAX_POSES, Math.max(24, Math.ceil(spec.duration * 4)));
    for (let i = 0; i < steps; i++) {
      if (session.cancelled) return;
      const v = getViewer();
      if (!v) throw new Error("The volume is not loaded");
      if (v !== session.viewer) adopt(v);
      // a path that stops must be sampled up to its last view, or the data of that view (and its clipping) is never loaded
      const frac = spec.end === "return" ? i / steps : i / (steps - 1);
      writePose(v.camera, playPose({ ...spec, end: spec.end === "pingpong" ? "stop" : spec.end }, session.base, session.worldUp, frac * spec.duration), v.renderer, v);
      await afterFrames();
      await waitForLoaded(v, { isCurrent: () => getViewer() === v, timeoutMs: 30000, minMs: 120 });
      if (session.cancelled) return;
      session.bar.progress((i + 1) / steps);
      session.bar.info(`Loading the data for the whole path\u2026 ${Math.round((100 * (i + 1)) / steps)}%`);
    }
    const end = getViewer()?.streamingManager.getStats();
    if (end && (end.evictedCount > startStats.evictedCount || end.allocationsRefused > startStats.allocationsRefused)) {
      session.warning = "The data of this path does not all fit in graphics memory, so some detail will still stream in while it plays. A higher VRAM allocation or a lower detail level helps.";
    }
  }

  function tick3d(now) {
    const v = getViewer();
    if (!v) return;
    if (v !== run.viewer) adopt(v);
    writePose(v.camera, playPose(run.spec, run.base, run.worldUp, run.elapsed), v.renderer, v);
    const D = run.spec.duration;
    const cycle = run.spec.end === "pingpong" ? 2 * D : D;
    run.bar.progress((run.elapsed % cycle) / cycle);
    emitProgress(passFraction(run.spec, run.elapsed), run.elapsed % cycle);
  }

  // ---------------------------------------------------------------------------------- slice sweep
  function sliceReady(idx) {
    const pane = run.views.panes[run.axis];
    return !!pane.shownKey && pane.shownKey.startsWith(`${idx}/`);
  }

  function tickSlices(now) {
    const { views, axis, indices, spec } = run;
    if (run.waitFor != null) {
      if (!sliceReady(run.waitFor)) return; // the next slice has not arrived: hold the one on screen
      run.waitFor = null;
      run.shownAt = now;
    }
    if (now - run.shownAt < 1000 / spec.speed) return;
    const idx = indices[run.pos];
    views.setSlice(axis, idx, "play");
    run.waitFor = idx;
    run.pos = (run.pos + 1) % indices.length;
    run.bar.progress(run.pos / indices.length);
    run.bar.info(`Slice ${idx + 1} of ${run.count}`);
    emitProgress(run.pos / indices.length, run.pos / spec.speed);
  }

  // ------------------------------------------------------------------------------------- the loop
  function loop(now) {
    if (!run) return;
    run.raf = requestAnimationFrame(loop);
    if (run.state !== "playing") { run.last = now; return; }
    const dt = Math.min(0.25, (now - run.last) / 1000); // a tab that was in the background must not jump ahead
    run.last = now;
    run.elapsed += dt;
    if (run.spec.kind === "slices") tickSlices(now); else tick3d(now);
  }

  function setState(state) {
    if (!run) return;
    run.state = state;
    run.bar?.paused(state === "paused");
    emit();
  }

  const onUserInput = (e) => {
    if (!run || e.target.closest?.(".play-bar")) return;
    if (run.state === "preloading") { player.stop(); return; } // the preload moves the camera: hands off
    if (run.state === "playing" && run.spec.pause_on_touch) player.pause("touch");
  };

  async function requestWakeLock() {
    try { run.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null; } catch (_) { /* optional */ }
  }
  const onVisible = () => { if (run && document.visibilityState === "visible" && !run.wakeLock) requestWakeLock(); };

  // ---------------------------------------------------------------------------------- public API
  const player = {
    get state() { return run ? run.state : "idle"; },
    get warning() { return run?.warning ?? ""; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** fn({ u, t, state }) while something plays or is moved with seek(): u is the fraction 0..1 of one pass. */
    onProgress(fn) { progressListeners.add(fn); return () => progressListeners.delete(fn); },

    /**
     * Starts playing `spec` (see PlaybackSpec in the backend). Replaces anything already playing.
     * `startAt` (0..1) begins that far into a pass. Slice sweeps never fetch ahead (prefetching is off while
     * one plays) and a 3D animation loads the data of its whole path first only if `spec.preload` is set.
     */
    async play(spec, { startAt = 0 } = {}) {
      player.stop(true);
      const kind = spec.kind;
      const session = { spec, state: "preloading", elapsed: 0, last: performance.now(), cancelled: false, warning: "" };
      if (kind === "slices") {
        const views = getSlices();
        const info = views?.visibleSlices().find((s) => s.axis === spec.axis);
        if (!info) throw new Error("Open the slice view you want to sweep through first");
        const to = Math.min(info.count - 1, spec.to_index);
        const from = Math.min(info.count - 1, spec.from_index);
        Object.assign(session, {
          views, axis: spec.axis, count: info.count, normal: info.normal,
          indices: sweepIndices(from, to, spec.step, spec.end === "pingpong"), pos: 0, waitFor: null, shownAt: 0,
          savedIndex: info.index,
        });
        session.pos = Math.min(session.indices.length - 1, Math.floor(Math.max(0, Math.min(0.9999, startAt)) * session.indices.length));
        views.setPrefetch?.(false);
      } else {
        const viewer = getViewer();
        if (!viewer || !is3dVisible()) throw new Error("Switch to the 3D or quad layout first");
        if (kind === "path" && (spec.keys?.length ?? 0) < 2) throw new Error("A camera path needs at least two views");
        const current = readPose(viewer.camera, viewer.renderer, viewer); // with the clipping box and transfer function: stopping gives them back
        resetTfSignature(viewer);
        session.spec = prepareSpec(spec, viewer); // keys that carry a transfer function know their colours
        session.elapsed = Math.max(0, Math.min(0.9999, startAt)) * spec.duration;
        session.base = spec.kind === "turntable" && spec.start ? structuredClone(spec.start) : current; // a bookmark can be the start
        session.worldUp = viewer.camera.upVector ?? [0, 1, 0];
        session.saved = {
          base: current, // what to go back to when stopped
          wasFree: viewer.camera.isFreeRotation?.(),
          orbit: viewer.camera.getOrbitState?.(),
          interactionScale: viewer.engine?.interactionRenderScale ?? 0.25,
        };
      }
      run = session;
      session.bar = mountBar();
      for (const type of ["pointerdown", "wheel", "keydown"]) host.addEventListener(type, onUserInput, true);
      document.addEventListener("visibilitychange", onVisible);
      requestWakeLock();
      emit();
      try {
        if (kind !== "slices") {
          adopt(getViewer(), session);
          if (spec.preload) await preload(session);
        }
        if (run !== session || session.cancelled) return; // stopped (or replaced) while preloading
        session.bar.progress(0);
        session.bar.info(session.warning || (kind === "slices" ? "" : { turntable: "Turntable", path: "Camera path" }[kind]));
        session.last = performance.now();
        session.state = "playing";
        session.bar.paused(false);
        session.raf = requestAnimationFrame(loop);
        emit();
      } catch (err) {
        if (run === session) player.stop(true);
        throw err;
      }
    },

    pause(reason) {
      if (!run || run.state !== "playing") return;
      run.pausedBy = reason || "user";
      setState("paused");
    },

    resume() {
      if (!run || run.state !== "paused") return;
      if (run.pausedBy === "touch" && run.spec.kind === "turntable") {
        // the user turned the view by hand: carry on from where they left it
        const v = getViewer();
        if (v) { run.base = readPose(v.camera, v.renderer, v); run.elapsed = 0; }
      }
      run.last = performance.now();
      setState("playing");
    },

    /**
     * Moves a running (or paused) animation to the fraction u (0..1) of a pass and shows it; false if nothing runs.
     * A 3D animation shows the pose there at once; a slice sweep shows that slice.
     */
    seek(u) {
      if (!run || run.state === "preloading") return false;
      u = Math.max(0, Math.min(1, u));
      const { spec } = run;
      if (spec.kind === "slices") {
        run.pos = Math.min(run.indices.length - 1, Math.floor(Math.min(0.9999, u) * run.indices.length));
        const idx = run.indices[run.pos];
        run.views.setSlice(run.axis, idx, "play");
        run.waitFor = idx;
        run.bar.progress(u);
        emitProgress(u, run.pos / spec.speed);
        return true;
      }
      const v = getViewer();
      if (!v) return false;
      run.elapsed = Math.min(u, 0.9999) * spec.duration;
      if (spec.end === "stop" && u >= 1) run.elapsed = spec.duration;
      run.last = performance.now();
      writePose(v.camera, playPose(spec, run.base, run.worldUp, run.elapsed), v.renderer, v);
      run.bar.progress(u);
      emitProgress(u, run.elapsed);
      return true;
    },

    /** Stops, and puts the view back as it was. `quiet`: do not announce it (a new play() follows). */
    stop(quiet = false) {
      if (!run) return;
      const ended = run;
      cancelAnimationFrame(ended.raf);
      ended.cancelled = true;
      for (const type of ["pointerdown", "wheel", "keydown"]) host.removeEventListener(type, onUserInput, true);
      document.removeEventListener("visibilitychange", onVisible);
      try { ended.wakeLock?.release(); } catch (_) { /* already released */ }
      try {
        if (ended.spec.kind === "slices") {
          ended.views.setPrefetch?.(true);
          ended.views.setSlice(ended.axis, ended.savedIndex, "play");
        } else release();
      } catch (err) { console.error("[playback] restore", err); }
      ended.bar?.destroy();
      run = null;
      if (!quiet) emit();
    },
  };
  return player;
}
