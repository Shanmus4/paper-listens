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

// Continuous pitch (fractional MIDI) -> canvas point. Unlike gridCell this isn't
// snapped to a note, so a slide or bend moves the paint smoothly between cells.
// The note axis follows the chromatic position (0..12) within the octave; the
// octave axis stays on its row. A slide that crosses an octave wraps the note
// axis (back to the start) and steps the octave axis, matching the grid layout.
export function pitchToPoint(midiFloat, width, height) {
  const g = gridGeometry(width, height);
  const pcc = (((midiFloat % 12) + 12) % 12); // 0..12 continuous pitch class
  const octave = clamp(Math.floor(midiFloat / 12) - 1, OCT_MIN, OCT_MAX);
  const row = OCT_MAX - octave;
  const noteCoord = (pcc + 0.5) * g.noteSpan;
  const octCoord = (row + 0.5) * g.octSpan;
  return { x: g.notesOnX ? noteCoord : octCoord, y: g.notesOnX ? octCoord : noteCoord };
}

// Raw rms loudness -> a 0..1 "how hard you played it" value, stretched across a
// realistic range (a soft fingerpick up to a hard strum).
export function loudnessOf(rms) {
  const e = clamp(Math.sqrt(rms || 0) * 3.0, 0, 1);
  return clamp((e - 0.12) / 0.6, 0, 1);
}

// Color is RANDOM, not tied to pitch, octave, position, or loudness — the user
// asked for this directly. Each new note picks a hue and keeps it for its whole
// sustain (the caller holds `hue` across the note), so a note doesn't shimmer as
// it rings, but every fresh note is a fresh color. `hue` is 0..360; pass null
// for a one-off random pick. Mode (vibrancy) only nudges how vivid it is.
export function randomHsl(hue, vibrancy = 1) {
  const h = hue == null ? Math.random() * 360 : ((hue % 360) + 360) % 360;
  const sat = clamp(80 * vibrancy, 60, 96);
  const light = clamp(50 + (vibrancy - 1) * 6, 40, 60);
  return { h, s: sat, l: light };
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
    const color = randomHsl(rng() * 360, vibrancy); // each chord tone its own color
    // A struck note (strum/chord tone) is a single moderate puff. Sustain growth
    // comes from the per-frame strokeSpec path, so this stays modest to avoid
    // flooding the sheet.
    const radius = minDim * (0.035 + e * 0.05) * (0.7 + 0.3 * energy);
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

// Build one small per-frame "stroke" puff for a continuously sounding pitch
// (fractional MIDI). Called every frame a note is voiced: a held note stacks
// many puffs at one spot so the bloom GROWS, a quick note leaves a single small
// puff, and a slide lays a moving, color-shifting trail. Keep alpha/radius low
// because these accumulate frame after frame.
// `hue` (0..360) is the note's random color, held by the caller for the whole
// sustain so the note keeps one color instead of shimmering as it decays.
// `slide` thickens the stroke: a bend/slide lays a noticeably fatter trail than
// a held note sitting in place, so gestures read clearly as moving ink.
export function strokeSpec(midiFloat, frame, dims, vibrancy = 1, hue = null, slide = false) {
  const { width, height } = dims;
  const minDim = Math.min(width, height);
  const { e } = intensity(frame.rms);
  const p = pitchToPoint(midiFloat, width, height);
  const color = randomHsl(hue, vibrancy);
  const fat = slide ? 2.1 : 1; // slides/bends paint thicker than a still note
  return {
    x: p.x,
    y: p.y,
    midi: midiFloat,
    h: color.h,
    s: color.s,
    l: color.l,
    radius: minDim * (0.032 + e * 0.04) * fat,
    alpha: (0.05 + e * 0.1) * (slide ? 1.3 : 1),
    speed: 0.15,
    edge: 0.45,
    grain: clamp(frame.flatness || 0, 0, 1),
    seed: 0,
  };
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
