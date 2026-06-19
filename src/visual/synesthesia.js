// synesthesia.js — the deterministic bridge from sound to paint.
//
// Pure functions only. A note maps to a fixed cell on an invisible grid:
// columns are the 12 pitch classes (C..B, left to right), rows are octaves
// (high at the top, low at the bottom). So every note has one home on the
// page, and the same note always lands there. Color is fixed per pitch class.

export const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const OCT_MIN = 1; // C1 at the bottom
const OCT_MAX = 7; // B7 at the top

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Spectral centroid (Hz) -> 0..1 brightness. Log scale matches pitch hearing.
function brightness(centroidHz) {
  const lo = 200;
  const hi = 6000;
  const hz = clamp(centroidHz || 440, lo, hi);
  return clamp(Math.log2(hz / lo) / Math.log2(hi / lo), 0, 1);
}

// The invisible grid's geometry, shared by note placement and the (optional)
// visible overlay so they can never drift apart.
export function gridGeometry(width, height) {
  // No margins: the note map fills the viewport corner to corner. The overlay
  // draws its labels just inside these edges.
  const mx = 0;
  const myTop = 0;
  const myBot = 0;
  const cols = 12;
  const rows = OCT_MAX - OCT_MIN + 1;
  return {
    mx,
    myTop,
    myBot,
    cols,
    rows,
    cw: (width - 2 * mx) / cols,
    ch: (height - myTop - myBot) / rows,
    octMin: OCT_MIN,
    octMax: OCT_MAX,
  };
}

// Note (pitch class + octave) -> fixed cell center on the canvas grid.
export function gridCell(pc, octave, width, height) {
  const g = gridGeometry(width, height);
  const oct = clamp(octave, OCT_MIN, OCT_MAX);
  const row = OCT_MAX - oct; // high octave -> top
  return {
    x: g.mx + (pc + 0.5) * g.cw,
    y: g.myTop + (row + 0.5) * g.ch,
    cellW: g.cw,
    cellH: g.ch,
  };
}

// Pitch class -> color. Hue is fixed per note; vibrancy (mode), octave, and
// brightness shape saturation and lightness (higher/brighter = lighter).
export function noteColor(pc, octave, vibrancy, centroidHz) {
  const hue = pc * 30; // C=0(red) ... B=330
  const bright = brightness(centroidHz);
  const octT = clamp((octave - OCT_MIN) / (OCT_MAX - OCT_MIN), 0, 1);
  const sat = clamp(70 * vibrancy, 22, 96);
  const light = clamp(36 + (vibrancy - 1) * 12 + bright * 10 + octT * 14, 24, 72);
  return { h: hue, s: sat, l: light };
}

function intensity(rms) {
  const e = clamp(Math.sqrt(rms) * 2.2, 0.08, 1);
  return { e, alpha: 0.24 + e * 0.42 };
}

// Build ink-blot specs for a pitched onset (one per detected note).
export function mapPitched(classified, frame, vibrancy, dims, rng = Math.random) {
  const { width, height } = dims;
  const minDim = Math.min(width, height);
  const { e, alpha } = intensity(frame.rms);
  const bright = brightness(frame.centroidHz);

  return classified.notes.map(({ pc, octave, energy }) => {
    const cell = gridCell(pc, octave, width, height);
    const color = noteColor(pc, octave, vibrancy, frame.centroidHz);
    // Keep blots within their cell-ish footprint so the grid reads cleanly.
    const radius = Math.min(minDim * (0.02 + e * 0.045), cell.cellW * 0.5) * (0.7 + 0.3 * energy);
    return {
      x: cell.x,
      y: cell.y,
      h: color.h,
      s: color.s,
      l: color.l,
      radius,
      alpha,
      edge: 0.35 + bright * 0.45,
      seed: rng(),
    };
  });
}

// Percussive onset -> monochrome ink splatter. Position from centroid:
// low/dark -> lower-left, high/bright -> upper-right.
export function mapPercussive(classified, frame, dims, rng = Math.random) {
  const { width, height } = dims;
  const minDim = Math.min(width, height);
  const bright = brightness(frame.centroidHz);
  const { e } = intensity(frame.rms);

  const jitter = () => (rng() - 0.5) * 0.12;
  const x = width * clamp(0.15 + bright * 0.7 + jitter(), 0.05, 0.95);
  const y = height * clamp(0.85 - bright * 0.7 + jitter(), 0.05, 0.95);

  const sizeByDrum = { kick: 0.085, snare: 0.055, hihat: 0.032 };
  const radius = minDim * (sizeByDrum[classified.drum] || 0.05) * (0.6 + e * 0.6);

  return {
    x,
    y,
    drum: classified.drum,
    radius,
    alpha: 0.25 + e * 0.45,
    count: classified.drum === "hihat" ? 10 : 6,
    seed: rng(),
  };
}
