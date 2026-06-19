// main.js — entry point. Boots the canvas, wires the UI, and runs the render
// loop. The audio pipeline and painting are layered in by later modules; for
// now the loop just keeps the paper drawn so the shell is testable.

import { createPaper } from "./visual/canvas.js";
import { wireControls } from "./ui/controls.js";

const paperEl = document.getElementById("paper");
const paper = createPaper(paperEl);

// Paper fill color, read once from CSS so the look stays in one place.
const PAPER_COLOR =
  getComputedStyle(document.body).getPropertyValue("background-color").trim() || "#f4ede1";

// ---- Render loop ----
// Each frame: repaint the paper, then stamp the dried painting buffer on top.
// Wet (animating) blots will be drawn here too once the renderer lands.
function frame() {
  const { ctx, buffer, width, height } = paper.state;
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);
  // Draw the buffer at CSS size (it is stored at DPR scale, hence the source rect).
  ctx.drawImage(buffer, 0, 0, buffer.width, buffer.height, 0, 0, width, height);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Audio start (stub) ----
// Replaced in the audio task with real getUserMedia + Meyda setup.
// Returning a resolved promise lets the gate transition be tested today.
async function startAudio() {
  // TODO(audio): request mic, build AudioContext + Meyda, begin analysis.
  return Promise.resolve();
}

function stopAudio() {
  // TODO(audio): tear down the mic stream and analyser.
}

// ---- Wire the interface ----
wireControls({
  onStart: startAudio,
  onBack: stopAudio,
  onClear: () => paper.clear(),
  onSave: () => paper.save(),
  onSensitivity: (value) => {
    // TODO(audio): feed sensitivity into onset thresholds.
    void value;
  },
});
