// grid.js — an optional, faint overlay that reveals the invisible note map.
//
// X axis = the 12 pitch classes (C..B), left to right.
// Y axis = octaves, high at the top (B7) down to low at the bottom (C1).
// So every note has one fixed home on the page. Drawn on the visible canvas
// each frame when enabled; never baked into the saved painting.

import { gridGeometry, PITCH_NAMES } from "./synesthesia.js";

const LINE = "rgba(58, 52, 44, 0.16)";
const LABEL = "rgba(58, 52, 44, 0.55)";
const CAPTION = "rgba(58, 52, 44, 0.4)";

export function drawGrid(ctx, width, height) {
  const g = gridGeometry(width, height);
  const right = g.mx + g.cols * g.cw;
  const bottom = g.myTop + g.rows * g.ch;
  const fs = Math.max(9, Math.round(width * 0.0085));

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = LINE;
  ctx.font = `500 ${fs}px Inter, ui-sans-serif, sans-serif`;
  ctx.textBaseline = "middle";

  // Vertical lines (pitch-class columns).
  for (let c = 0; c <= g.cols; c++) {
    const x = g.mx + c * g.cw;
    ctx.beginPath();
    ctx.moveTo(x, g.myTop);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }

  // Horizontal lines (octave rows).
  for (let r = 0; r <= g.rows; r++) {
    const y = g.myTop + r * g.ch;
    ctx.beginPath();
    ctx.moveTo(g.mx, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  // Pitch-class labels along the top.
  ctx.fillStyle = LABEL;
  ctx.textAlign = "center";
  for (let c = 0; c < g.cols; c++) {
    ctx.fillText(PITCH_NAMES[c], g.mx + (c + 0.5) * g.cw, g.myTop - fs);
  }

  // Octave labels down the left edge.
  ctx.textAlign = "right";
  for (let r = 0; r < g.rows; r++) {
    const oct = g.octMax - r;
    ctx.fillText("C" + oct, g.mx - 6, g.myTop + (r + 0.5) * g.ch);
  }

  // Axis captions.
  ctx.fillStyle = CAPTION;
  ctx.textAlign = "center";
  ctx.fillText("pitch: low to high", (g.mx + right) / 2, bottom + fs * 1.6);

  // Vertical caption, only when the left margin has room (skipped on mobile,
  // where the C7..C1 labels already make the octave axis clear).
  const capX = g.mx - fs * 3;
  if (capX > fs) {
    ctx.save();
    ctx.translate(capX, (g.myTop + bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("octave: low to high", 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
