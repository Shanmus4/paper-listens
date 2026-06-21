// chord.js — approximate polyphonic note extraction from a chroma vector.
//
// Our pitch engine (McLeod/Pitchy) is monophonic: it names ONE fundamental, so
// it can't tell you the notes inside a strummed chord. Meyda's chroma can — it
// reports the energy on each of the 12 pitch classes, and that works on
// polyphonic sound. We pick the pitch classes that stand out and voice them
// upward from a bass anchor, so a chord paints as several blooms spread across
// the canvas (different rows -> different positions AND colors), not one spot.
//
// This is an APPROXIMATION, not transcription. A single note's overtones (its
// 3rd harmonic is a fifth, its 5th is a major third) can light up extra pitch
// classes, so a lone note may occasionally bloom into its overtone chord.
// That's acceptable for a painting; tighten PICK to reduce it.

import { freqToNote, centroidToOctave } from "./notes.js";

const PICK = 0.62; // a pitch class counts if it's >= this fraction of the loudest
const MAX_NOTES = 5; // cap voices in one chord
const MIN_FOR_CHORD = 2; // fewer active classes than this is "a single note, not a chord"
const OCT_MIN = 1;
const OCT_MAX = 7;

// Returns an array of { pc, octave, energy } for a chord, or null when the
// frame isn't chord-like (silent, or a single dominant pitch class).
export function extractChord(frame) {
  const chroma = frame.chroma || [];
  let max = 0;
  for (const v of chroma) if (v > max) max = v;
  if (max <= 0) return null;

  // Pitch classes that stand out relative to the loudest one.
  const active = [];
  for (let pc = 0; pc < 12; pc++) {
    if (chroma[pc] >= max * PICK) active.push({ pc, energy: chroma[pc] / max });
  }
  if (active.length < MIN_FOR_CHORD) return null;

  // Bass anchor: the detected fundamental when it's a sane pitch, otherwise the
  // brightness-derived register. Every voice stacks upward from here.
  const pitchOk = frame.pitchHz >= 30 && frame.pitchHz <= 4100;
  const bass = pitchOk
    ? freqToNote(frame.pitchHz)
    : { pc: active[0].pc, octave: centroidToOctave(frame.centroidHz) };

  // Order the chord tones ascending from the bass pitch class (so a C-rooted
  // chord goes C, E, G... up the staff) and stack each in the first octave that
  // lands above the previous voice — a natural rising voicing.
  const ordered = active
    .slice()
    .sort((a, b) => ((a.pc - bass.pc + 12) % 12) - ((b.pc - bass.pc + 12) % 12))
    .slice(0, MAX_NOTES);

  let prevMidi = (bass.octave + 1) * 12 + bass.pc; // MIDI of the bass note
  const notes = [];
  for (const { pc, energy } of ordered) {
    let octave = Math.floor(prevMidi / 12) - 1;
    let midi = (octave + 1) * 12 + pc;
    while (midi < prevMidi) {
      octave++;
      midi += 12;
    }
    octave = Math.min(OCT_MAX, Math.max(OCT_MIN, octave));
    notes.push({ pc, octave, energy });
    prevMidi = (octave + 1) * 12 + pc;
  }

  return notes.length >= MIN_FOR_CHORD ? notes : null;
}
