// main.js — entry point. Boots the canvas, auto-starts listening, owns the
// audio pipeline, and runs the render loop that turns onsets into ink.

import { createRenderer } from "./visual/renderer.js";
import { wireControls } from "./ui/controls.js";
import { createLevelMeter } from "./ui/level.js";
import { createMicSource, createFilePlayer } from "./audio/source.js";
import { createAnalyzer } from "./audio/features.js";
import { analyzeBuffer } from "./audio/offline.js";
import { createOnsetDetector } from "./audio/onset.js";
import { createModeTracker } from "./audio/mode.js";
import { mapPercussive, spectralSpec, washSpec, timeHue, PITCH_NAMES } from "./visual/synesthesia.js";
import { freqToNote } from "./audio/notes.js";
import { createSpectralPainter } from "./audio/spectral.js";
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

// Live readout: a small panel showing what the analyzer hears each frame — the
// raw pitch, clarity, loudness, brightness and noisiness, plus what was last
// painted and whether the engine read a chord or a single note. It makes the
// gates and the chord/note decision visible so you can see exactly why the app
// painted what it did. Toggled from Controls ("Show live readout"); off by
// default (the toggle is the source of truth and sets this on load).
let hudEl = null;
let hudVisible = false;
let lastPaintedLabel = "-";
let lastDecision = "-"; // "chord A C E" or "single E2" — set wherever we paint

// Top pitch classes in the chroma (the notes the chord test actually sees).
function topChroma(chroma, n = 4) {
  if (!chroma || !chroma.length) return "--";
  let max = 0;
  for (const v of chroma) if (v > max) max = v;
  if (max <= 0) return "--";
  return chroma
    .map((v, pc) => ({ pc, v: v / max }))
    .filter((c) => c.v >= 0.5)
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((c) => PITCH_NAMES[c.pc])
    .join(" ");
}

function setHudVisible(on) {
  hudVisible = on;
  if (hudEl) hudEl.style.display = on ? "block" : "none";
}

function updateHud(f) {
  if (!hudVisible) return;
  if (!hudEl) {
    hudEl = document.createElement("div");
    hudEl.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:9;font:12px ui-monospace,monospace;" +
      "background:rgba(0,0,0,.72);color:#fff;padding:9px 12px;border-radius:8px;" +
      "white-space:pre;pointer-events:none;line-height:1.5";
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
    `loudness ${(f.rms || 0).toFixed(4)}   clarity ${(f.clarity || 0).toFixed(2)}\n` +
    `pitch    ${String(Math.round(hz)).padStart(4)}Hz (${note})\n` +
    `bright   ${Math.round(f.centroidHz || 0)}Hz   noisy ${(f.flatness || 0).toFixed(2)}\n` +
    `chroma   ${topChroma(f.chroma)}\n` +
    `read as  ${lastDecision}\n` +
    `painted  ${lastPaintedLabel}`;
}

// Keep the paint surface and the grid overlay sized to the window.
window.addEventListener("resize", () => renderer.resize());

// Onset sensitivity is fixed at the value that tested best. There's no user
// slider: note detection is gated by the tracker's clarity/range logic, not by
// this — the onset detector only triggers re-pluck timing and drum splats, so a
// single well-chosen value serves every input.
const ONSET_SENSITIVITY = 0.5;

// Audio state. onsetDetector/modeTracker are recreated when the source changes.
let onsetDetector = createOnsetDetector({ sensitivity: ONSET_SENSITIVITY });
let modeTracker = createModeTracker();
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

// ---- Timeline painting (file playback + seeking) ----
// Paint one analyzed event, either animated (live playback) or baked instantly
// (rebuilding the painting at a seek position).
function paintEvent(ev, nowMs, instant) {
  const dims = renderer.dims();
  if (ev.type === "spectral") {
    // One analyzed frame of the song: paint every spectral peak at its pitch, plus
    // a grey wash if the frame was noisy (drums). Colour is derived from the
    // event's own time so a seek rebuilds the identical palette.
    const hue = timeHue(ev.t);
    const pts = ev.points || [];
    if (!instant) {
      lastPaintedLabel = pts[0] ? noteName(pts[0].midi) : ev.wash > 0.15 ? "wash" : "-";
      lastDecision = `${pts.length} tones${ev.wash > 0.15 ? " + wash" : ""}`;
      updateHud(ev.frame);
    }
    for (const pt of pts) {
      const spec = spectralSpec(pt.midi, pt.energy, ev.frame, dims, hue, ev.vibrancy);
      if (instant) renderer.bake(spec);
      else renderer.addBlot(spec, nowMs);
    }
    if (ev.wash > 0.02) {
      const w = washSpec(ev.wash, ev.frame, dims);
      if (instant) renderer.bake(w);
      else renderer.addBlot(w, nowMs);
    }
  } else if (ev.type === "percussive") {
    const splat = mapPercussive(ev.cls, ev.frame, dims, seededRng(ev.seed));
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

// ---- Live mic: spectral painting ----
// Every frame we read the magnitude spectrum and paint a mark wherever there is
// energy (see audio/spectral.js), so voice, strings, piano and drums all leave
// their own coloured marks at their real pitch — instead of one "winning" note,
// which is what made a whistle scatter and a full song ignore everything but the
// loudest instrument. Mic and upload share the exact same painter.
let micSpectral = null; // built lazily once we know the sample rate / spectrum size

// Fractional MIDI -> note name (e.g. 57.2 -> "A3"), for the live readout.
const noteName = (midi) => {
  const r = Math.round(midi);
  return `${PITCH_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
};

function onAudioFrame(f) {
  levelMeter.push(f.rms);
  modeTracker.update(f.chroma, f.rms);
  modeTracker.evaluate();
  updateHud(f); // raw readout every frame, even when nothing paints

  if (!f.spectrumHi) return;
  if (!micSpectral) {
    micSpectral = createSpectralPainter({ sampleRate: f.sampleRate, fftSize: f.spectrumHi.length * 2 });
  }
  const { points, wash } = micSpectral.analyze(f.spectrumHi, f);
  if (!points.length && wash <= 0.02) return; // silence / room noise: paint nothing

  const now = performance.now();
  const hue = timeHue(micSimT);
  const dims = renderer.dims();
  const vib = modeTracker.getVibrancy();
  for (const pt of points) renderer.addBlot(spectralSpec(pt.midi, pt.energy, f, dims, hue, vib), now);
  if (wash > 0.02) renderer.addBlot(washSpec(wash, f, dims), now);

  lastPaintedLabel = points[0] ? noteName(points[0].midi) : "wash";
  lastDecision = `${points.length} tones${wash > 0.15 ? " + wash" : ""}`;
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
  micSimT = 0; // reset the mic sim clock to match the reset fluid field
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
  micSpectral = null; // rebuilt for the next source (sample rate may differ)
  events = [];
  fileEnv = null;
  evtPtr = 0;
  renderedT = 0;
  scrubbing = false;
  renderer.purge();
  resetTracker();
  onsetDetector = createOnsetDetector({ sensitivity: ONSET_SENSITIVITY });
  modeTracker = createModeTracker();
}

// Reset the live painter state (new source / fresh sheet). The spectral painter
// keeps no cross-frame state (its histogram is rebuilt each frame), so there's
// nothing to clear here; kept as a hook in case that changes.
function resetTracker() {}

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
    const result = analyzeBuffer(p.audioBuffer, { sensitivity: ONSET_SENSITIVITY });
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
  onGrid: (on) => {
    gridVisible = on;
  },
  onLiveView: (on) => setHudVisible(on),
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
    getDecision: () => lastDecision,
  };
}
