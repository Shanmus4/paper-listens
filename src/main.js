// main.js — entry point. Boots the canvas, auto-starts listening, owns the
// audio pipeline, and runs the render loop that turns onsets into ink.

import { createPaper } from "./visual/canvas.js";
import { wireControls } from "./ui/controls.js";
import { createLevelMeter } from "./ui/level.js";
import { createMicSource, createFileSource } from "./audio/source.js";
import { createAnalyzer } from "./audio/features.js";
import { createOnsetDetector } from "./audio/onset.js";
import { classifyOnset } from "./audio/classify.js";
import { createModeTracker } from "./audio/mode.js";
import { mapPitched, mapPercussive } from "./visual/synesthesia.js";
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
let gridVisible = false; // overlay that reveals the note map

// ---- Render loop ----
function frame() {
  const { ctx, buffer, width, height } = paper.state;
  const now = performance.now();
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(buffer, 0, 0, buffer.width, buffer.height, 0, 0, width, height);
  watercolor.render(ctx, now);
  percussion.render(ctx, now);
  if (gridVisible) drawGrid(ctx, width, height);
  levelMeter.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

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
    source = await createFileSource(file, { onEnded: () => ui?.setPlaying(false) });
    analyzer = createAnalyzer(source, onAudioFrame);
    analyzer.start();
    source.start();
    micHint.hidden = true;
    currentSource = "file";
    clearCanvas(); // a new file always starts a fresh sheet
    ui?.showTransport(true);
    ui?.setPlaying(true);
  } catch (err) {
    console.error("[paper-listens] file failed:", err);
    micHint.hidden = false;
    micHint.textContent = "Could not read that audio file. Try another one.";
  }
}

// ---- Wire UI ----
ui = wireControls({
  onMic: startMic,
  onFile: startFile,
  onClear: clearCanvas,
  onSave: (name) => paper.save(name),
  onSensitivity: (value) => {
    sensitivity = value;
    onsetDetector.setSensitivity(value);
  },
  onGrid: (on) => {
    gridVisible = on;
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
      recorder.download(result.blob, result.ext, name || "paper-listens");
    } else if (recorder.start()) {
      ui.setRecording(true);
    }
  },
  onTogglePlay: () => {
    const ctx = source?.audioContext;
    if (!ctx) return;
    if (ctx.state === "running") {
      ctx.suspend();
      userPaused = true;
      ui.setPlaying(false);
    } else {
      userPaused = false;
      ctx.resume();
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
  window.__pl = { feed: onAudioFrame, paper, watercolor, percussion };
}
