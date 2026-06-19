// main.js — entry point. Boots the canvas, wires the UI, owns the audio
// pipeline, and runs the render loop that turns onsets into watercolor.

import { createPaper } from "./visual/canvas.js";
import { wireControls } from "./ui/controls.js";
import { createLevelMeter } from "./ui/level.js";
import { createMicSource } from "./audio/source.js";
import { createAnalyzer } from "./audio/features.js";
import { createOnsetDetector } from "./audio/onset.js";
import { classifyOnset } from "./audio/classify.js";
import { createModeTracker } from "./audio/mode.js";
import { mapPitched, mapPercussive } from "./visual/synesthesia.js";
import { createWatercolor } from "./visual/watercolor.js";
import { createPercussion } from "./visual/percussion.js";

const paperEl = document.getElementById("paper");
const paper = createPaper(paperEl);

const levelEl = document.getElementById("level");
const levelMeter = createLevelMeter(levelEl);

const watercolor = createWatercolor(paper);
const percussion = createPercussion(paper);
const onsetDetector = createOnsetDetector({ sensitivity: 0.5 });
const modeTracker = createModeTracker();

const PAPER_COLOR =
  getComputedStyle(document.body).getPropertyValue("background-color").trim() || "#f4ede1";

let micSource = null;
let analyzer = null;

// ---- Render loop ----
function frame() {
  const { ctx, buffer, width, height } = paper.state;
  const now = performance.now();

  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(buffer, 0, 0, buffer.width, buffer.height, 0, 0, width, height);

  watercolor.render(ctx, now); // wet blots over the dried paper
  percussion.render(ctx, now); // ink splatters + kick pulse

  levelMeter.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Audio frame -> painting ----
function onAudioFrame(f) {
  levelMeter.push(f.rms);
  modeTracker.update(f.chroma, f.rms);
  modeTracker.evaluate();

  const now = performance.now();
  const onset = onsetDetector.process(f.flux, f.rms, now);
  if (!onset) return;

  const cls = classifyOnset(f);
  const dims = { width: paper.state.width, height: paper.state.height };

  if (cls.type === "pitched") {
    for (const blot of mapPitched(cls, f, modeTracker.getVibrancy(), dims)) {
      watercolor.addBlot(blot, now);
    }
  } else {
    percussion.addSplat(mapPercussive(cls, f, dims), now);
  }
}

// ---- Audio start / stop ----
async function startAudio() {
  micSource = await createMicSource();
  analyzer = createAnalyzer(micSource, onAudioFrame);
  analyzer.start();
}

function stopAudio() {
  analyzer?.stop();
  micSource?.stop();
  analyzer = null;
  micSource = null;
}

// ---- Wire the interface ----
wireControls({
  onStart: startAudio,
  onBack: stopAudio,
  onClear: () => {
    paper.clear();
    watercolor.clear();
    percussion.clear();
  },
  onSave: () => paper.save(),
  onSensitivity: (value) => onsetDetector.setSensitivity(value),
});

// Dev hook for local testing only (feed synthetic frames without a mic).
// Not attached on deployed sites.
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  window.__pl = { feed: onAudioFrame, paper, watercolor, percussion };
}
