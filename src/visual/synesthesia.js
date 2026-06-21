// synesthesia.js — the deterministic bridge from sound to paint.
//
// Pure functions only. A note maps to a fixed cell on an invisible grid.
// There are 12 pitch classes (C..B) but only 7 octaves, so the LONGER side of
// the viewport always carries the notes and the shorter side carries octaves:
//   • Landscape (width >= height): notes left-to-right, octaves top (high) to
//     bottom (low). The original layout.
//   • Portrait (width < height): notes top-to-bottom, octaves left (high) to
//     right (low).
// Every note still has one fixed home, and the same note always lands there.

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
// visible overlay so they can never drift apart. No margins: the note map fills
// the viewport corner to corner. The overlay draws labels just inside the edges.
export function gridGeometry(width, height) {
  const notesOnX = width >= height; // the longer side carries the 12 notes
  const noteCount = 12;
  const octCount = OCT_MAX - OCT_MIN + 1; // 7
  return {
    notesOnX,
    noteCount,
    octCount,
    octMin: OCT_MIN,
    octMax: OCT_MAX,
    // Pixel size of one step along each axis.
    noteSpan: (notesOnX ? width : height) / noteCount,
    octSpan: (notesOnX ? height : width) / octCount,
  };
}

// Note (pitch class + octave) -> fixed cell center on the canvas grid.
export function gridCell(pc, octave, width, height) {
  const g = gridGeometry(width, height);
  const oct = clamp(octave, OCT_MIN, OCT_MAX);
  const row = OCT_MAX - oct; // high octave first (top in landscape, left in portrait)
  const noteCoord = (pc + 0.5) * g.noteSpan;
  const octCoord = (row + 0.5) * g.octSpan;
  return {
    x: g.notesOnX ? noteCoord : octCoord,
    y: g.notesOnX ? octCoord : noteCoord,
    cellW: g.noteSpan,
    cellH: g.octSpan,
  };
}

// Sound -> color by brightness/mood (not by pitch class — position already
// carries which note). "Brightness" is the character of the sound: how bright
// its timbre is AND how high/low it sits (register). Low, heavy sounds paint
// deep warm tones; high, airy sounds paint cool light tones. Because register
// is per-note, a chord that spans octaves paints several colors at once, and a
// melody that climbs sweeps warm -> cool, giving the canvas real color variety
// without ever coloring by note name. Mode (vibrancy) nudges the vividness.
export function noteColor(pc, octave, vibrancy, centroidHz) {
  const timbre = brightness(centroidHz);
  const register = clamp((octave - OCT_MIN) / (OCT_MAX - OCT_MIN), 0, 1);
  // Register leads strongly so low vs high notes clearly split warm vs cool
  // (timbre only tints), otherwise a bright-centroid song collapses to one color.
  const score = clamp(0.85 * register + 0.15 * timbre, 0, 1);
  const hue = 10 + score * 230; // ~10 (deep warm red/orange) -> ~240 (cool blue)
  // Richer floor so the paint reads as vivid watercolor, not washed-out tint.
  const sat = clamp((96 - score * 16) * vibrancy, 58, 98);
  const light = clamp(34 + score * 26 + (vibrancy - 1) * 6, 26, 74);
  return { h: hue, s: sat, l: light };
}

function intensity(rms) {
  // Higher gain + floor so even a softly played guitar fills the sheet instead
  // of leaving it mostly empty. Quiet notes still bloom; loud ones bloom more.
  const e = clamp(Math.sqrt(rms) * 3.0, 0.18, 1);
  return { e, alpha: 0.32 + e * 0.42 };
}

// Build ink-blot specs for a pitched onset (one per detected note).
export function mapPitched(classified, frame, vibrancy, dims, rng = Math.random) {
  const { width, height } = dims;
  const minDim = Math.min(width, height);
  const { e, alpha } = intensity(frame.rms);
  const bright = brightness(frame.centroidHz);

  // Noisiness of the sound -> granulation. Pure tones paint smooth, noisy ones
  // (breathy vocals, distorted strings) get a grainy, speckled texture.
  const grain = clamp(frame.flatness || 0, 0, 1);

  return classified.notes.map(({ pc, octave, energy }) => {
    const cell = gridCell(pc, octave, width, height);
    const color = noteColor(pc, octave, vibrancy, frame.centroidHz);
    // Generous billows that spill well past the note's home cell so a few notes
    // already fill space and chords overlap and mix, instead of leaving the
    // sheet sparse. Louder/stronger tones bloom larger.
    const radius = minDim * (0.06 + e * 0.1) * (0.7 + 0.3 * energy);
    return {
      x: cell.x,
      y: cell.y,
      h: color.h,
      s: color.s,
      l: color.l,
      radius,
      alpha,
      // How hard the note pushes into the water (drives the velocity impulse).
      speed: 0.3 + e * 0.7,
      edge: 0.35 + bright * 0.45,
      grain,
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
