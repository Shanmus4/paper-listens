// chord.js — approximate polyphonic note extraction from a chroma vector.
//
// Our pitch engine (McLeod/Pitchy) is monophonic: it names ONE fundamental, so
// it can't tell you the notes inside a strummed chord. Meyda's chroma can — it
// reports the energy on each of the 12 pitch classes. We use that to decide
// whether several real notes are sounding at once, and if so paint them all.
//
// THE HARD PROBLEM (and how we handle it): one plucked note is not a pure tone.
// Its overtones land on musical intervals above the fundamental — the 3rd
// harmonic is a fifth, the 5th harmonic a major third, the 7th a flat seventh.
// So a single low E lights up E, G#, B and D in the chroma and LOOKS like an E
// chord. That phantom is exactly the "random notes firing off a single string"
// bug. We kill it with a harmonic-explanation test: if every loud pitch class
// can be explained as an overtone of the strongest note, it is ONE note, not a
// chord, and we return null so the continuous painter handles it cleanly.
//
// The unavoidable cost: a major or power chord is spectrally almost identical to
// its root note played alone (its notes ARE the root's overtones), so those
// paint as a single flowing note. Chords that contain a "foreign" tone the
// overtone series can't produce (a minor third, a suspended fourth, sixths,
// added/extended tones) are recognised as real chords. Telling these apart
// perfectly needs an ML transcription model; this is the honest mono-mic limit.

import { freqToNote, centroidToOctave } from "./notes.js";

const PICK = 0.62; // a pitch class is "active" if it's >= this fraction of the loudest
const MAX_NOTES = 4; // cap voices in one chord
const MIN_FOR_CHORD = 2; // need at least this many active pitch classes
const OCT_MIN = 1;
const OCT_MAX = 7;

// Pitch-class offsets (mod 12) that a single note's overtones produce, so they
// must NOT be counted as separate chord tones: root(0), major 9th(2), major
// 3rd(4), perfect 5th(7), flat 7th(10). Anything outside this set is a "foreign"
// tone — real evidence of a second fundamental, i.e. an actual chord.
const HARMONIC_OFFSETS = new Set([0, 2, 4, 7, 10]);
const FOREIGN_MIN = 0.5; // a foreign tone must be at least this loud to count as real
const MIN_FOREIGN = 1; // a chord needs at least this many foreign tones to fire

const CLARITY_VETO = 0.62; // above this the pitch is one clear note, not a chord
const FLAT_VETO = 0.34; // above this the frame is a noisy transient, not a clean chord

// Returns an array of { pc, octave, energy } for a chord, or null when the
// frame is a single note (or its overtones), silent, or a noisy transient.
export function extractChord(frame) {
  // A confident single pitch (high McLeod clarity) is never a chord.
  if ((frame.clarity || 0) >= CLARITY_VETO) return null;
  // A noisy attack briefly flattens the spectrum; don't read a chord out of it.
  if ((frame.flatness || 0) >= FLAT_VETO) return null;

  const chroma = frame.chroma || [];
  let max = 0;
  let rootPc = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (chroma[pc] > max) {
      max = chroma[pc];
      rootPc = pc; // strongest bin = the most likely fundamental
    }
  }
  if (max <= 0) return null;

  // Pitch classes that stand out relative to the loudest one.
  const active = [];
  for (let pc = 0; pc < 12; pc++) {
    if (chroma[pc] >= max * PICK) active.push({ pc, energy: chroma[pc] / max });
  }
  if (active.length < MIN_FOR_CHORD) return null;

  // Harmonic-explanation test: count loud tones that the root's overtone series
  // CANNOT produce. With none, this is a single note ringing with its overtones
  // (the open-E-bass case), so we bail and let the continuous painter handle it.
  const foreign = active.filter(
    ({ pc, energy }) =>
      !HARMONIC_OFFSETS.has((pc - rootPc + 12) % 12) && energy >= FOREIGN_MIN
  );
  if (foreign.length < MIN_FOREIGN) return null;

  // Real chord. Bass anchor: the detected fundamental when it's a sane pitch,
  // else the brightness-derived register. Voice the tones ascending from there.
  const pitchOk = frame.pitchHz >= 30 && frame.pitchHz <= 4100;
  const bass = pitchOk
    ? freqToNote(frame.pitchHz)
    : { pc: rootPc, octave: centroidToOctave(frame.centroidHz) };

  // Order ascending from the bass pitch class, then voice them close together
  // (each tone in the next available slot at or above the previous one) so the
  // chord reads as a chord in one register instead of scattered across octaves.
  const ordered = active
    .slice()
    .sort((a, b) => ((a.pc - bass.pc + 12) % 12) - ((b.pc - bass.pc + 12) % 12))
    .slice(0, MAX_NOTES);

  let prevMidi = -Infinity;
  const notes = [];
  for (let i = 0; i < ordered.length; i++) {
    const { pc, energy } = ordered[i];
    const floorMidi = i === 0 ? (bass.octave + 1) * 12 + bass.pc : prevMidi + 1;
    let octave = Math.floor(floorMidi / 12) - 1;
    let midi = (octave + 1) * 12 + pc;
    while (midi < floorMidi) {
      octave++;
      midi += 12;
    }
    octave = Math.min(OCT_MAX, Math.max(OCT_MIN, octave));
    notes.push({ pc, octave, energy });
    prevMidi = (octave + 1) * 12 + pc;
  }

  return notes.length >= MIN_FOR_CHORD ? notes : null;
}
