// grid.js — an optional, faint overlay that reveals the invisible note map.
//
// The 12 pitch classes (note names C..B) run along the viewport's LONGER side
// and the 7 octaves (high -> low) along the shorter side. So in landscape notes
// go left-to-right with octaves stacked top(high)->bottom(low); in portrait
// notes go top-to-bottom with octaves left(high)->right(low). Either way every
// note has one fixed home. The map fills the whole screen; this overlay just
// labels it. Drawn on the visible canvas each frame when enabled, never saved.

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

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

export function drawGrid(ctx, width, height) {
  const g = gridGeometry(width, height);
  const fs = Math.max(10, Math.round(Math.min(width, height) * 0.0095));

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = LINE;
  ctx.font = `600 ${fs}px Inter, ui-sans-serif, sans-serif`;
  ctx.textBaseline = "middle";

  if (g.notesOnX) {
    // Notes are columns (vertical lines); octaves are rows (horizontal lines).
    for (let c = 0; c <= g.noteCount; c++) line(ctx, c * g.noteSpan, 0, c * g.noteSpan, height);
    for (let r = 0; r <= g.octCount; r++) line(ctx, 0, r * g.octSpan, width, r * g.octSpan);

    ctx.fillStyle = LABEL;
    ctx.textAlign = "center"; // note names along the top
    for (let c = 0; c < g.noteCount; c++) ctx.fillText(PITCH_NAMES[c], (c + 0.5) * g.noteSpan, fs);
    ctx.textAlign = "left"; // octave numerals down the left edge
    for (let r = 0; r < g.octCount; r++) ctx.fillText(toRoman(g.octMax - r), 4, (r + 0.5) * g.octSpan);
  } else {
    // Notes are rows (horizontal lines); octaves are columns (vertical lines).
    for (let r = 0; r <= g.noteCount; r++) line(ctx, 0, r * g.noteSpan, width, r * g.noteSpan);
    for (let c = 0; c <= g.octCount; c++) line(ctx, c * g.octSpan, 0, c * g.octSpan, height);

    ctx.fillStyle = LABEL;
    ctx.textAlign = "left"; // note names down the left edge
    for (let r = 0; r < g.noteCount; r++) ctx.fillText(PITCH_NAMES[r], 4, (r + 0.5) * g.noteSpan);
    ctx.textAlign = "center"; // octave numerals along the top
    for (let c = 0; c < g.octCount; c++) ctx.fillText(toRoman(g.octMax - c), (c + 0.5) * g.octSpan, fs);
  }

  ctx.restore();
}
