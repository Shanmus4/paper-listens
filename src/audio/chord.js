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

// Single rich notes (piano, a sustained guitar string) have strong harmonics —
// the 3rd harmonic is a fifth, the 5th a major third — that light up other
// chroma bins. So we only call it a chord when SEVERAL pitch classes are nearly
// as loud as the strongest (high PICK) and there are at least 3 of them; a lone
// note with two harmonic partials won't clear that bar and stays a single note,
// handled by the continuous tracker instead.
const PICK = 0.8; // a pitch class counts only if it's >= this fraction of the loudest
const MAX_NOTES = 4; // cap voices in one chord
const MIN_FOR_CHORD = 3; // need this many strong classes to be a real chord
const OCT_MIN = 1;
const OCT_MAX = 7;
const SPREAD = 12; // min semitones between voices: an OPEN voicing that spreads
//                    the chord across octave rows, so its tones paint at
//                    different registers (different positions AND colors) and
//                    fill the sheet vertically, instead of one close cluster.

// Returns an array of { pc, octave, energy } for a chord, or null when the
// frame isn't chord-like (silent, or a single dominant pitch class).
const CLARITY_VETO = 0.58; // above this the pitch is one clear note, not a chord
const FLAT_VETO = 0.34; // above this the frame is a noisy transient, not a clean chord

export function extractChord(frame) {
  // A real strum has no single fundamental, so McLeod clarity is low/moderate.
  // A single note (even a harmonically rich piano/guitar tone) reads HIGH
  // clarity. So a confident pitch vetoes the chord path — its overtones won't be
  // mistaken for chord tones; the continuous tracker paints it as one note.
  if ((frame.clarity || 0) >= CLARITY_VETO) return null;
  // The noisy ATTACK of a single plucked note briefly flattens the spectrum, so
  // many pitch classes look active for a frame and a phantom chord fires. A real
  // sustained chord is far more tonal, so reject noise-like frames outright.
  if ((frame.flatness || 0) >= FLAT_VETO) return null;

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
  // chord goes C, E, G... up the staff). The first tone sits at the bass octave;
  // each later tone is pushed at least SPREAD semitones above the previous one,
  // so the chord opens out across octave rows instead of clustering in one.
  const ordered = active
    .slice()
    .sort((a, b) => ((a.pc - bass.pc + 12) % 12) - ((b.pc - bass.pc + 12) % 12))
    .slice(0, MAX_NOTES);

  let prevMidi = -Infinity; // floor the next voice must clear
  const notes = [];
  for (let i = 0; i < ordered.length; i++) {
    const { pc, energy } = ordered[i];
    // First voice anchors at the bass octave; the rest must clear prev + SPREAD.
    const floorMidi = i === 0 ? (bass.octave + 1) * 12 + bass.pc : prevMidi + SPREAD;
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
