// grid.js — an optional, faint overlay that reveals the invisible note map.
//
// X axis = the 12 pitch classes (the actual note names C..B), left to right.
// Y axis = the OCTAVE (how high or low), high at the top (7) down to low (1).
// So a mark in column "C", row "oct 4" is the note C4. Every note has one fixed
// home on the page. The map fills the whole screen; this overlay just labels
// it. Drawn on the visible canvas each frame when enabled, never saved.

import { gridGeometry, PITCH_NAMES } from "./synesthesia.js";

const LINE = "rgba(58, 52, 44, 0.14)";
const LABEL = "rgba(58, 52, 44, 0.5)";

// Octave numbers are shown as Roman numerals (I, II, III…). Octaves are small
// positive integers, so a simple lookup-by-subtraction conversion is plenty.
const ROMAN = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];
function toRoman(n) {
  if (n <= 0) return String(n); // guard: octave 0 or negatives stay numeric
  let out = "";
  for (const [v, s] of ROMAN) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

export function drawGrid(ctx, width, height) {
  const g = gridGeometry(width, height);
  const right = g.mx + g.cols * g.cw;
  const bottom = g.myTop + g.rows * g.ch;
  const fs = Math.max(10, Math.round(width * 0.0095));

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = LINE;
  ctx.font = `600 ${fs}px Inter, ui-sans-serif, sans-serif`;
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

  ctx.fillStyle = LABEL;

  // Pitch-class (note) labels along the top, just inside the grid.
  ctx.textAlign = "center";
  for (let c = 0; c < g.cols; c++) {
    ctx.fillText(PITCH_NAMES[c], g.mx + (c + 0.5) * g.cw, g.myTop + fs);
  }

  // Octave labels down the left edge, just inside the grid. Shown as Roman
  // numerals (I, II, III…) so the octave axis reads distinctly from the notes.
  ctx.textAlign = "left";
  for (let r = 0; r < g.rows; r++) {
    const oct = g.octMax - r;
    ctx.fillText(toRoman(oct), g.mx + 4, g.myTop + (r + 0.5) * g.ch);
  }

  ctx.restore();
}
