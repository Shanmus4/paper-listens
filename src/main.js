// main.js — entry point. Boots the canvas, auto-starts listening, owns the
// audio pipeline, and runs the render loop that turns onsets into ink.

import { createRenderer } from "./visual/renderer.js";
import { wireControls } from "./ui/controls.js";
import { createLevelMeter } from "./ui/level.js";
import { createMicSource, createFilePlayer } from "./audio/source.js";
import { createAnalyzer } from "./audio/features.js";
import { analyzeBuffer } from "./audio/offline.js";
import { createOnsetDetector } from "./audio/onset.js";
import { classifyOnset } from "./audio/classify.js";
import { createModeTracker } from "./audio/mode.js";
import { mapPitched, mapPercussive, PITCH_NAMES } from "./visual/synesthesia.js";
import { freqToNote } from "./audio/notes.js";
import { createNoteTracker } from "./audio/tracker.js";
import { seededRng } from "./visual/rng.js";
import { createRecorder } from "./ui/record.js";

const paperEl = document.getElementById("paper");
const overlayEl = document.getElementById("overlay");
// One facade over either the WebGL ink renderer or the Canvas 2D fallback.
const renderer = createRenderer(paperEl, overlayEl);
const levelMeter = createLevelMeter(document.getElementById("level"));
const headline = document.getElementById("headline");
const micHint = document.getElementById("micHint");

const recorder = createRecorder(paperEl);

const DEBUG = location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Live readout (local dev only): updates EVERY frame with the raw pitch, clarity
// and rms the analyzer sees, plus the last note painted. This makes it obvious
// when the input sits below a gate (e.g. clarity under the voiced threshold), so
// the thresholds can be dialed to your mic instead of guessed.
let hudEl = null;
let lastPaintedLabel = "-";
function updateHud(f) {
  if (!DEBUG) return;
  if (!hudEl) {
    hudEl = document.createElement("div");
    hudEl.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:9;font:13px ui-monospace,monospace;" +
      "background:rgba(0,0,0,.72);color:#fff;padding:8px 11px;border-radius:8px;white-space:pre;pointer-events:none";
    document.body.appendChild(hudEl);
  }
  const hz = f.pitchHz || 0;
  const inRange = hz >= 40 && hz <= 2500;
  let note = "--";
  if (inRange) {
    const n = freqToNote(hz);
    note = `${PITCH_NAMES[n.pc]}${n.octave}`;
  }
  hudEl.textContent =
    `rms ${(f.rms || 0).toFixed(4)}    clarity ${(f.clarity || 0).toFixed(2)}\n` +
    `pitch ${Math.round(hz)}Hz  (${note})\n` +
    `last painted: ${lastPaintedLabel}`;
}

// Keep the paint surface and the grid overlay sized to the window.
window.addEventListener("resize", () => renderer.resize());

// Audio state. onsetDetector/modeTracker are recreated when the source changes.
let onsetDetector = createOnsetDetector({ sensitivity: 0.5 });
let modeTracker = createModeTracker();
let sensitivity = 0.5;
let source = null;
let analyzer = null;
let firstPaint = false;
let currentSource = null; // "mic" | "file"
let ui = null; // controls API, set after wiring
let userPaused = false; // true only when the user hit pause on purpose
let gridVisible = true; // overlay that reveals the note map (on by default)

// File playback timeline (set when a song is loaded).
let player = null;
let events = []; // [{ t, type, cls, frame, vibrancy, seed }] sorted by time
let evtPtr = 0; // next event to paint
let renderedT = 0; // the song time the painting currently reflects (sec)
let scrubbing = false; // true while the user drags the seek bar
let scrubTargetT = 0; // latest scrub position, repainted at most once per frame
let lastAnchor = null; // previous pitched note's home, for melodic spread direction
let micSimT = 0; // mic mode has no timeline, so we drive the fluid by wall time
let lastFrameMs = performance.now();
let fileEnv = null; // loudness envelope of the loaded song (drives the meter)
let fileEnvStep = 1; // seconds between envelope samples
// Bumped on every teardown. A file load (which is async) captures the token at
// its start and bails if it changes, so a load that's superseded by a new
// upload or a source switch can never start a second, orphaned audio node.
let loadToken = 0;

// Loudness of the song at time `t`, sampled from the precomputed envelope.
function levelAt(t) {
  if (!fileEnv || !fileEnv.length) return 0;
  const i = Math.min(fileEnv.length - 1, Math.max(0, Math.floor(t / fileEnvStep)));
  return fileEnv[i];
}

// ---- Render loop ----
function frame() {
  const now = performance.now();
  // Drive file playback. The fluid sim is path-dependent, so we don't rebuild it
  // every frame while scrubbing (that would re-simulate from the start on each
  // drag event); we just move the meter and rebuild once on release.
  if (player && currentSource === "file") {
    if (scrubbing) {
      levelMeter.push(levelAt(scrubTargetT));
    } else {
      const pos = player.position();
      paintToTime(pos, false, now); // advances the fluid sim and injects notes
      ui?.setSeekValue(pos);
      // Feed the meter from the song so it moves during playback, not just mic.
      levelMeter.push(player.isPlaying() ? levelAt(pos) : 0);
    }
  } else if (currentSource === "mic") {
    // No timeline in mic mode: advance the fluid by real elapsed time.
    micSimT += Math.min(0.05, (now - lastFrameMs) / 1000);
    renderer.stepTo(micSimT);
  }
  lastFrameMs = now;

  renderer.render(now);
  renderer.renderGrid(gridVisible);
  levelMeter.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Give a pitched blot its spread direction from the melody: ink reaches from the
// previous note's home toward this one. Notes that repeat the same spot get a
// gentle seeded puff so they still billow. Direction is consumed by the fluid
// renderer as a velocity impulse; the Canvas 2D fallback ignores it.
function seededDir(seed) {
  const a = (seed != null ? seed : 0.5) * Math.PI * 2 * 5 + 0.7;
  return [Math.cos(a), Math.sin(a)];
}
function attachMotion(blot) {
  if (lastAnchor) {
    const dx = blot.x - lastAnchor.x;
    const dy = blot.y - lastAnchor.y;
    const len = Math.hypot(dx, dy);
    blot.dir = len > 1 ? [dx / len, dy / len] : seededDir(blot.seed);
  } else {
    blot.dir = seededDir(blot.seed);
  }
  lastAnchor = { x: blot.x, y: blot.y };
  return blot;
}

// ---- Timeline painting (file playback + seeking) ----
// Paint one analyzed event, either animated (live playback) or baked instantly
// (rebuilding the painting at a seek position).
function paintEvent(ev, nowMs, instant) {
  const dims = renderer.dims();
  const rng = seededRng(ev.seed);
  if (ev.type === "pitched") {
    // Drive the live readout during playback too (skip seek rebuilds so it
    // doesn't flicker through every event at once).
    if (!instant) {
      const ns = ev.cls.notes || [];
      lastPaintedLabel = ns.map((n) => `${PITCH_NAMES[n.pc]}${n.octave}`).join(" ");
      updateHud(ev.frame);
    }
    for (const blot of mapPitched(ev.cls, ev.frame, ev.vibrancy, dims, rng)) {
      attachMotion(blot);
      if (instant) renderer.bake(blot);
      else renderer.addBlot(blot, nowMs);
    }
  } else {
    const splat = mapPercussive(ev.cls, ev.frame, dims, rng);
    if (instant) renderer.bakeSplat(splat);
    else renderer.addSplat(splat, nowMs);
  }
}

// Make the painting reflect song time `t`. Moving forward paints only the new
// events; moving backward clears and replays from the start (ink can't be
// un-painted). `instant` bakes without the wet animation (used while seeking).
function paintToTime(t, instant, nowMs = performance.now()) {
  if (t < renderedT) {
    clearCanvas();
    evtPtr = 0;
  }
  let painted = false;
  while (evtPtr < events.length && events[evtPtr].t <= t) {
    renderer.stepTo(events[evtPtr].t); // evolve the fluid up to this note's time
    paintEvent(events[evtPtr], nowMs, instant);
    evtPtr++;
    painted = true;
  }
  renderer.stepTo(t); // finish evolving to the requested moment
  renderedT = t;
  if (painted) fadeHeadline();
}

// ---- Live mic: continuous, tuner-style note tracking ----
// Frames flow through the shared note tracker (audio/tracker.js), the same one
// the offline file analysis uses, so mic and upload behave identically. The
// tracker reads pitch every frame and reports a note the instant a clear pitch
// stabilizes — it never averages the noisy attack and never invents a chord.
// Lower silence floor than the file path: a mic picks up low notes faintly, so
// a higher floor would treat them as silence before pitch is even checked.
const micTracker = createNoteTracker({ silenceRms: 0.0015 });

function onAudioFrame(f) {
  levelMeter.push(f.rms);
  modeTracker.update(f.chroma, f.rms);
  modeTracker.evaluate();
  updateHud(f); // raw readout every frame, even when nothing paints

  const now = performance.now();
  const onset = onsetDetector.process(f.flux, f.rms, now);
  const r = micTracker.process(f, onset);
  if (!r) return;

  if (r.type === "note") {
    paintNote(r.pc, r.octave, f, now);
  } else if (r.type === "perc") {
    // A noisy attack with no clear pitch -> percussion splatter (drums only).
    const cls = classifyOnset(f);
    if (cls.type === "percussive") {
      lastPaintedLabel = `drum:${cls.drum}`;
      renderer.addSplat(mapPercussive(cls, f, renderer.dims()), now);
      fadeHeadline();
    }
  }
}

// Paint one confirmed monophonic note.
function paintNote(pc, octave, frame, now) {
  const cls = { type: "pitched", notes: [{ pc, octave, energy: 1 }], centroidHz: frame.centroidHz };
  lastPaintedLabel = `${PITCH_NAMES[pc]}${octave}`;
  if (DEBUG) console.log(`[note] ${lastPaintedLabel}`, Math.round(frame.pitchHz) + "Hz");
  const dims = renderer.dims();
  for (const blot of mapPitched(cls, frame, modeTracker.getVibrancy(), dims)) {
    attachMotion(blot);
    renderer.addBlot(blot, now);
  }
  fadeHeadline();
}

function fadeHeadline() {
  if (firstPaint) return;
  firstPaint = true;
  headline.classList.add("faded");
}

// ---- Source management ----
function clearCanvas() {
  renderer.clear();
  lastAnchor = null; // a fresh sheet restarts the melodic spread chain
  micSimT = 0; // and the mic sim clock, to match the reset fluid field
  resetTracker();
  firstPaint = false;
  headline.classList.remove("faded");
}

function teardownSource() {
  loadToken++; // invalidate any file load still in flight
  analyzer?.stop();
  source?.stop();
  // Stop a file player even if it hasn't been promoted to `source` yet (i.e. a
  // load that was interrupted mid-decode), so its audio node never lingers.
  if (player && player !== source) player.stop();
  analyzer = null;
  source = null;
  player = null;
  events = [];
  fileEnv = null;
  evtPtr = 0;
  renderedT = 0;
  scrubbing = false;
  renderer.purge();
  resetTracker();
  onsetDetector = createOnsetDetector({ sensitivity });
  modeTracker = createModeTracker();
}

// Reset the live monophonic tracker (new source / fresh sheet).
function resetTracker() {
  micTracker.reset();
}

async function startMic() {
  const changed = currentSource !== "mic";
  teardownSource();
  userPaused = false;
  try {
    source = await createMicSource();
    analyzer = createAnalyzer(source, onAudioFrame);
    analyzer.start();
    source.start();
    micHint.hidden = true;
    currentSource = "mic";
    ui?.showTransport(false);
    ui?.showProcessing(false);
    if (changed) clearCanvas(); // switching mode starts a fresh sheet
  } catch (err) {
    console.error("[paper-listens] mic failed:", err);
    micHint.hidden = false;
  }
}

async function startFile(file) {
  teardownSource(); // bumps loadToken
  const token = loadToken; // this load's generation
  userPaused = false;
  ui?.showTransport(false);
  ui?.showProcessing(true); // tell the user we're reading the song
  try {
    const p = await createFilePlayer(file, {
      onEnded: () => {
        if (player === p) ui?.setPlaying(false);
      },
    });
    // Superseded while decoding (new upload, or switched to mic): drop it.
    if (token !== loadToken) {
      p.stop();
      return;
    }
    // Promote now so a later teardown can stop this node if it interrupts us.
    player = p;
    source = p;
    // Let the processing pill paint before the (blocking) analysis pass.
    await new Promise((r) => setTimeout(r, 16));
    if (token !== loadToken) {
      p.stop();
      return;
    }
    const result = analyzeBuffer(p.audioBuffer, { sensitivity });
    if (token !== loadToken) {
      p.stop();
      return;
    }
    events = result.events;
    fileEnv = result.env;
    fileEnvStep = result.envStep;
    evtPtr = 0;
    renderedT = 0;

    currentSource = "file";
    micHint.hidden = true;
    clearCanvas(); // a new file always starts a fresh sheet
    ui?.showProcessing(false);
    ui?.setLoaded();
    ui?.showTransport(true);
    ui?.setSeekDuration(result.duration);
    ui?.setSeekValue(0);
    p.start();
    ui?.setPlaying(true);
  } catch (err) {
    if (token !== loadToken) return; // a newer action already moved on
    console.error("[paper-listens] file failed:", err);
    ui?.showProcessing(false);
    micHint.hidden = false;
    micHint.textContent = "Could not read that audio file. Try another one.";
  }
}

// Jump playback + painting to song time `t` (seconds).
function seekTo(t) {
  if (currentSource !== "file" || !player) return;
  player.seek(t);
  paintToTime(t, true);
  ui?.setSeekValue(t);
  ui?.setPlaying(player.isPlaying()); // seeking off the end resumes play
}

// The audio currently being heard, so a recording can include sound (the
// uploaded song, or the live mic). Null if there's nothing to capture.
function currentAudioStream() {
  if (currentSource === "file") return player?.audioStream || null;
  if (currentSource === "mic") return source?.stream || null;
  return null;
}

// ---- Wire UI ----
ui = wireControls({
  onMic: startMic,
  onFile: startFile,
  // Entering Upload fresh (e.g. coming back from the mic): tear down any prior
  // playback and hide the transport. We do NOT auto-replay the last song — the
  // user chooses a file again. The canvas art is left untouched.
  onUploadEnter: () => {
    teardownSource();
    currentSource = null;
    ui?.showTransport(false);
    ui?.showProcessing(false);
    ui?.setPlaying(false);
  },
  onClear: clearCanvas,
  onSave: (name) => renderer.save(name),
  onSensitivity: (value) => {
    sensitivity = value;
    onsetDetector.setSensitivity(value);
  },
  onGrid: (on) => {
    gridVisible = on;
  },
  // Dragging the seek bar: just record the target. The render loop repaints to
  // it once per frame, so rapid drag events don't pile up expensive rebuilds.
  // Audio waits for release so scrubbing doesn't machine-gun it with restarts.
  onSeek: (t) => {
    scrubbing = true;
    scrubTargetT = t;
  },
  // Released the seek bar: jump the audio to match and resume normal playback.
  onSeekCommit: (t) => {
    scrubbing = false;
    if (player) {
      player.seek(t);
      ui?.setPlaying(player.isPlaying()); // seeking off the end resumes play
    }
    paintToTime(t, true);
  },
  onRecordToggle: async () => {
    // Recording is fully independent of playback: it only starts/stops the
    // canvas capture and never touches the audio transport.
    if (recorder.isActive()) {
      ui.setRecording(false);
      const result = await recorder.stop();
      if (!result) return;
      const name = await ui.promptName({
        title: "Name your recording",
        sub: "It will be saved as a video to your device. Leave blank to skip.",
        confirmLabel: "Save video",
      });
      if (name === null) return; // cancelled: discard, don't save
      recorder.download(result.blob, result.ext, name || "paper-listens");
    } else if (recorder.start(currentAudioStream())) {
      ui.setRecording(true);
    }
  },
  onTogglePlay: async () => {
    if (currentSource !== "file" || !player) return;
    if (player.isEnded()) {
      // Finished: a tap replays from the start.
      seekTo(0);
      userPaused = false;
      await player.play();
      ui.setPlaying(true);
    } else if (player.audioContext.state === "running") {
      player.pause();
      userPaused = true;
      ui.setPlaying(false);
    } else {
      userPaused = false;
      await player.play();
      ui.setPlaying(true);
    }
  },
});
if (!recorder.supported()) ui.hideRecord();

// iOS/Safari start audio contexts suspended until a user gesture. Resume on
// the first gesture, but never override an intentional pause (otherwise tapping
// Save or Record would secretly restart paused playback).
function resumeOnGesture() {
  if (userPaused) return;
  if (source?.audioContext?.state === "suspended") source.audioContext.resume();
}
document.addEventListener("pointerdown", resumeOnGesture, { once: false });

// Jump straight in: start listening on load (browser shows its mic prompt).
startMic();

// Dev hook for local testing without a mic.
if (DEBUG) {
  window.__pl = {
    feed: onAudioFrame,
    renderer,
    startFile,
    seekTo,
    getEvents: () => events,
    getPlayer: () => player,
  };
}
