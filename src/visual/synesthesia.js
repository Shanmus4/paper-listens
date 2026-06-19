// synesthesia.js — the deterministic bridge from sound to paint.
//
// Pure functions only: given a classified onset and the current vibrancy, it
// returns *what* to paint (color, position, size). The watercolor/percussion
// renderers decide *how*. Keeping it pure means the same note always yields
// the same anchor and color — the synesthesia is reproducible, not random.

export const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Seat the 12 pitch classes around a wheel by the circle of fifths, so
// musically related notes sit next to each other. Each note has one fixed seat.
const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]; // C G D A E B F# C# G# D# A# F
const SEAT = new Array(12);
FIFTHS.forEach((pc, i) => (SEAT[pc] = i));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Spectral centroid (Hz) -> 0..1 brightness. Log scale matches pitch perception.
function brightness(centroidHz) {
  const lo = 200;
  const hi = 6000;
  const hz = clamp(centroidHz || 440, lo, hi);
  return clamp(Math.log2(hz / lo) / Math.log2(hi / lo), 0, 1);
}

// Pitch class -> fixed anchor point on the canvas (the note's "seat").
export function noteAnchor(pc, width, height) {
  const angle = (SEAT[pc] / 12) * Math.PI * 2 - Math.PI / 2; // 12 o'clock = C
  const radius = Math.min(width, height) * 0.34;
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  };
}

// Pitch class -> color. Hue is fixed per note; vibrancy (mode) and brightness
// (centroid) shape saturation and lightness.
export function noteColor(pc, vibrancy, centroidHz) {
  const hue = pc * 30; // C=0(red) ... B=330
  const bright = brightness(centroidHz);
  const sat = clamp(70 * vibrancy, 22, 96);
  const light = clamp(40 + (vibrancy - 1) * 14 + bright * 12, 26, 70);
  return { h: hue, s: sat, l: light };
}

// Loudness -> blot footprint. Returns a normalized energy and concrete-ish
// size/alpha the renderer scales against canvas size.
function intensity(rms) {
  const e = clamp(Math.sqrt(rms) * 2.2, 0.08, 1);
  return { e, alpha: 0.22 + e * 0.4 };
}

// Build blot specs for a pitched onset (one per dominant pitch class).
export function mapPitched(classified, frame, vibrancy, dims, rng = Math.random) {
  const { width, height } = dims;
  const minDim = Math.min(width, height);
  const { e, alpha } = intensity(frame.rms);
  const bright = brightness(frame.centroidHz);

  return classified.pitches.map(({ pc, energy }) => {
    const anchor = noteAnchor(pc, width, height);
    const color = noteColor(pc, vibrancy, frame.centroidHz);
    // Strongest pitch paints biggest; quieter chord tones a touch smaller.
    const radius = minDim * (0.025 + e * 0.06) * (0.7 + 0.3 * energy);
    return {
      x: anchor.x,
      y: anchor.y,
      h: color.h,
      s: color.s,
      l: color.l,
      radius,
      alpha,
      edge: 0.35 + bright * 0.45, // brighter sound -> crisper edge
      seed: rng(),
    };
  });
}

// Build a splatter spec for a percussive onset. Position from centroid:
// low/dark -> lower-left (kicks), high/bright -> upper-right (cymbals).
export function mapPercussive(classified, frame, dims, rng = Math.random) {
  const { width, height } = dims;
  const minDim = Math.min(width, height);
  const bright = brightness(frame.centroidHz);
  const { e } = intensity(frame.rms);

  const jitter = () => (rng() - 0.5) * 0.12;
  const x = width * clamp(0.15 + bright * 0.7 + jitter(), 0.05, 0.95);
  const y = height * clamp(0.85 - bright * 0.7 + jitter(), 0.05, 0.95);

  // Kicks big and heavy, hats small and fine.
  const sizeByDrum = { kick: 0.09, snare: 0.06, hihat: 0.035 };
  const radius = minDim * (sizeByDrum[classified.drum] || 0.05) * (0.6 + e * 0.6);

  return {
    x,
    y,
    drum: classified.drum,
    radius,
    alpha: 0.25 + e * 0.45,
    count: classified.drum === "hihat" ? 10 : 6, // hats = finer spray
    seed: rng(),
  };
}
