// main.js — entry point. Boots the canvas, wires the UI, owns the audio
// pipeline, and runs the render loop. Painting modules layer in next; for now
// the audio frames drive the input-level meter so we can see it listening.

import { createPaper } from "./visual/canvas.js";
import { wireControls } from "./ui/controls.js";
import { createLevelMeter } from "./ui/level.js";
import { createMicSource } from "./audio/source.js";
import { createAnalyzer } from "./audio/features.js";

const paperEl = document.getElementById("paper");
const paper = createPaper(paperEl);

const levelEl = document.getElementById("level");
const levelMeter = createLevelMeter(levelEl);

const PAPER_COLOR =
  getComputedStyle(document.body).getPropertyValue("background-color").trim() || "#f4ede1";

// Latest audio feature frame; renderers will read from here.
let latestFrame = null;
let sensitivity = 0.5;

// Live audio handles, kept so we can tear them down on Back.
let micSource = null;
let analyzer = null;

// ---- Render loop ----
function frame() {
  const { ctx, buffer, width, height } = paper.state;
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(buffer, 0, 0, buffer.width, buffer.height, 0, 0, width, height);

  levelMeter.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

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
  latestFrame = null;
}

// Called ~43x/sec with the latest features.
function onAudioFrame(f) {
  latestFrame = f;
  levelMeter.push(f.rms);
  // Onset detection + painting are wired in upcoming tasks.
}

// ---- Wire the interface ----
wireControls({
  onStart: startAudio,
  onBack: stopAudio,
  onClear: () => paper.clear(),
  onSave: () => paper.save(),
  onSensitivity: (value) => {
    sensitivity = value;
  },
});
