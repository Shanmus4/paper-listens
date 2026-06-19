// notes.js — musical note math shared across the audio and visual layers.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Frequency (Hz) -> note. Octave uses the standard convention where A4 = 440Hz
// and middle C (C4) = MIDI 60.
export function freqToNote(hz) {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { pc, octave, midi };
}

// For polyphonic input (chords/songs) we have no single fundamental, so we
// place notes in a register derived from the sound's brightness (centroid).
export function centroidToOctave(hz) {
  const lo = 150;
  const hi = 3000;
  const t = clamp(Math.log2(clamp(hz, lo, hi) / lo) / Math.log2(hi / lo), 0, 1);
  return Math.round(2 + t * 4); // octaves 2..6
}
