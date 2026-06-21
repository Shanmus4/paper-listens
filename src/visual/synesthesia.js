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

// Color from HOW HARD the note is played, not from its pitch or its position on
// the grid. Soft = cool blue, medium = green, hard = hot red/orange. So the same
// note can be any color depending on attack, and colors never repeat going up/
// down (octave) or left/right (pitch class). Mode (vibrancy) nudges vividness.
export function loudColor(loud, vibrancy = 1) {
  const l = clamp(loud, 0, 1);
  const hue = 222 - l * 212; // ~222 blue (soft) -> green -> ~10 red (hard)
  const sat = clamp((76 + l * 18) * vibrancy, 58, 96);
  const light = clamp(52 - l * 12 + (vibrancy - 1) * 6, 34, 64);
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
    const color = loudColor(loudnessOf(frame.rms), vibrancy);
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
// `loud` is the held "attack force" (0..1) that colors the whole note, so a
// sustained note keeps the color of its pluck instead of drifting as it decays.
// Falls back to this frame's loudness when not supplied.
export function strokeSpec(midiFloat, frame, dims, vibrancy = 1, loud = null) {
  const { width, height } = dims;
  const minDim = Math.min(width, height);
  const { e } = intensity(frame.rms);
  const p = pitchToPoint(midiFloat, width, height);
  const color = loudColor(loud != null ? loud : loudnessOf(frame.rms), vibrancy);
  return {
    x: p.x,
    y: p.y,
    midi: midiFloat,
    h: color.h,
    s: color.s,
    l: color.l,
    radius: minDim * (0.032 + e * 0.04),
    alpha: 0.05 + e * 0.1,
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
