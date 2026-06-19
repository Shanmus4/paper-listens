// main.js — entry point. Boots the canvas, auto-starts listening, owns the
// audio pipeline, and runs the render loop that turns onsets into ink.

import { createPaper } from "./visual/canvas.js";
import { wireControls } from "./ui/controls.js";
import { createLevelMeter } from "./ui/level.js";
import { createMicSource, createFilePlayer } from "./audio/source.js";
import { createAnalyzer } from "./audio/features.js";
import { analyzeBuffer } from "./audio/offline.js";
import { createOnsetDetector } from "./audio/onset.js";
import { classifyOnset } from "./audio/classify.js";
import { createModeTracker } from "./audio/mode.js";
import { mapPitched, mapPercussive } from "./visual/synesthesia.js";
import { seededRng } from "./visual/rng.js";
import { drawGrid } from "./visual/grid.js";
import { createWatercolor } from "./visual/watercolor.js";
import { createPercussion } from "./visual/percussion.js";
import { createRecorder } from "./ui/record.js";

const paperEl = document.getElementById("paper");
const paper = createPaper(paperEl);
const levelMeter = createLevelMeter(document.getElementById("level"));
const headline = document.getElementById("headline");
const micHint = document.getElementById("micHint");

const watercolor = createWatercolor(paper);
const percussion = createPercussion(paper);
const recorder = createRecorder(paperEl);

const PAPER_COLOR =
  getComputedStyle(document.body).getPropertyValue("background-color").trim() || "#f4ede1";
const DEBUG = location.hostname === "localhost" || location.hostname === "127.0.0.1";

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
let fileEnv = null; // loudness envelope of the loaded song (drives the meter)
let fileEnvStep = 1; // seconds between envelope samples

// Loudness of the song at time `t`, sampled from the precomputed envelope.
function levelAt(t) {
  if (!fileEnv || !fileEnv.length) return 0;
  const i = Math.min(fileEnv.length - 1, Math.max(0, Math.floor(t / fileEnvStep)));
  return fileEnv[i];
}

// ---- Render loop ----
function frame() {
  const { ctx, buffer, width, height } = paper.state;
  const now = performance.now();
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(buffer, 0, 0, buffer.width, buffer.height, 0, 0, width, height);
  // Drive file playback. While the user scrubs, repaint to the latest drag
  // position at most once per frame (cheap thanks to the blot cache); when
  // playing normally, advance with the play position and move the seek bar.
  if (player && currentSource === "file") {
    if (scrubbing) {
      if (scrubTargetT !== renderedT) paintToTime(scrubTargetT, true);
      levelMeter.push(levelAt(scrubTargetT));
    } else {
      const pos = player.position();
      paintToTime(pos, false, now);
      ui?.setSeekValue(pos);
      // Feed the meter from the song so it moves during playback, not just mic.
      levelMeter.push(player.isPlaying() ? levelAt(pos) : 0);
    }
  }

  watercolor.render(ctx, now);
  percussion.render(ctx, now);
  if (gridVisible) drawGrid(ctx, width, height);
  levelMeter.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Timeline painting (file playback + seeking) ----
// Paint one analyzed event, either animated (live playback) or baked instantly
// (rebuilding the painting at a seek position).
function paintEvent(ev, nowMs, instant) {
  const dims = { width: paper.state.width, height: paper.state.height };
  const rng = seededRng(ev.seed);
  if (ev.type === "pitched") {
    for (const blot of mapPitched(ev.cls, ev.frame, ev.vibrancy, dims, rng)) {
      if (instant) watercolor.bake(blot);
      else watercolor.addBlot(blot, nowMs);
    }
  } else {
    const splat = mapPercussive(ev.cls, ev.frame, dims, rng);
    if (instant) percussion.bake(splat);
    else percussion.addSplat(splat, nowMs);
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
    paintEvent(events[evtPtr], nowMs, instant);
    evtPtr++;
    painted = true;
  }
  renderedT = t;
  if (painted) fadeHeadline();
}

// ---- Onset -> classify -> paint, classifying from the SUSTAIN not the attack.
const CLASSIFY_FRAMES = 3;
let pending = null;

function onAudioFrame(f) {
  levelMeter.push(f.rms);
  modeTracker.update(f.chroma, f.rms);
  modeTracker.evaluate();

  const now = performance.now();
  const onset = onsetDetector.process(f.flux, f.rms, now);

  if (pending) {
    for (let i = 0; i < 12; i++) pending.chroma[i] += f.chroma[i];
    pending.centroidSum += f.centroidHz;
    pending.flatSum += f.flatness || 0;
    pending.rmsMax = Math.max(pending.rmsMax, f.rms);
    if ((f.clarity || 0) > pending.bestClarity) {
      pending.bestClarity = f.clarity;
      pending.bestPitch = f.pitchHz;
    }
    if (++pending.count >= CLASSIFY_FRAMES) finalizeOnset(now);
    return;
  }

  if (onset) {
    pending = {
      count: 0,
      chroma: new Array(12).fill(0),
      centroidSum: 0,
      flatSum: 0,
      rmsMax: f.rms,
      bestClarity: f.clarity || 0,
      bestPitch: f.pitchHz || 0,
    };
  }
}

function finalizeOnset(now) {
  const p = pending;
  pending = null;
  const n = p.count || 1;
  const frame = {
    rms: p.rmsMax,
    centroidHz: p.centroidSum / n,
    flatness: p.flatSum / n,
    clarity: p.bestClarity,
    pitchHz: p.bestPitch,
    chroma: p.chroma.map((v) => v / n),
  };

  const cls = classifyOnset(frame);
  if (DEBUG) console.log(`[onset] ${cls.type}`, cls.diag);

  const dims = { width: paper.state.width, height: paper.state.height };
  if (cls.type === "pitched") {
    for (const blot of mapPitched(cls, frame, modeTracker.getVibrancy(), dims)) {
      watercolor.addBlot(blot, now);
    }
  } else {
    percussion.addSplat(mapPercussive(cls, frame, dims), now);
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
  paper.clear();
  watercolor.clear();
  percussion.clear();
  firstPaint = false;
  headline.classList.remove("faded");
}

function teardownSource() {
  analyzer?.stop();
  source?.stop();
  analyzer = null;
  source = null;
  player = null;
  events = [];
  fileEnv = null;
  evtPtr = 0;
  renderedT = 0;
  scrubbing = false;
  watercolor.purge();
  pending = null;
  onsetDetector = createOnsetDetector({ sensitivity });
  modeTracker = createModeTracker();
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
    if (changed) clearCanvas(); // switching mode starts a fresh sheet
  } catch (err) {
    console.error("[paper-listens] mic failed:", err);
    micHint.hidden = false;
  }
}

async function startFile(file) {
  teardownSource();
  userPaused = false;
  try {
    player = await createFilePlayer(file, { onEnded: () => ui?.setPlaying(false) });
    // Let the "Reading…" state paint before the (blocking) analysis pass.
    await new Promise((r) => setTimeout(r, 16));
    const result = analyzeBuffer(player.audioBuffer, { sensitivity });
    events = result.events;
    fileEnv = result.env;
    fileEnvStep = result.envStep;
    evtPtr = 0;
    renderedT = 0;

    source = player;
    currentSource = "file";
    micHint.hidden = true;
    clearCanvas(); // a new file always starts a fresh sheet
    ui?.setLoaded();
    ui?.showTransport(true);
    ui?.setSeekDuration(result.duration);
    ui?.setSeekValue(0);
    player.start();
    ui?.setPlaying(true);
  } catch (err) {
    console.error("[paper-listens] file failed:", err);
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
    ui?.setPlaying(false);
  },
  onClear: clearCanvas,
  onSave: (name) => paper.save(name),
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
    if (player) player.seek(t);
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
    paper,
    watercolor,
    percussion,
    startFile,
    seekTo,
    getEvents: () => events,
    getPlayer: () => player,
  };
}
