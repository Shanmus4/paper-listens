// classify.js — decides what an onset is, biased toward "pitched".
//
// Real instruments (a strummed chord, a plucked string) have a noisy attack and
// spread energy across many notes, which used to fool a chroma-only test into
// calling them drums. So we lead with pitch clarity (McLeod) and only declare
// an onset percussive when it is noise-like on every count: no clear pitch,
// spectrally flat-ish-noisy, and an unpeaked chroma. Everything else paints in
// color. Drums (kick/snare/hat/clap) still fall through to the noisy branch.

import { freqToNote, centroidToOctave } from "./notes.js";

const PEAKY_THRESHOLD = 1.6; // chroma max/mean below this is "unpeaked"
const FLAT_NOISE = 0.3; // spectral flatness above this is noisy
const CLARITY_MIN = 0.5; // pitch clarity below this means "no clear pitch"
const CLARITY_HIGH = 0.7; // at/above this we trust the exact detected note as a single note
const MONO_PEAKY = 2.4; // chroma this peaked + a decent pitch => one note, not a chord
const RELATIVE_PICK = 0.72; // chord-tone pick threshold, relative to strongest
const MAX_NOTES = 3;
// Plausible fundamental range. Below this is sub-bass garbage the pitch detector
// sometimes reports on complex audio (it was placing notes at octave -1); above
// it is rare. Out-of-range pitch is not trusted as a single note.
const PITCH_LO = 40; // ~E1, below the lowest guitar/voice fundamental
const PITCH_HI = 2500; // ~D#7, above the highest fundamental we expect

function drumFromCentroid(hz) {
  if (hz < 1200) return "kick";
  if (hz < 3500) return "snare";
  return "hihat";
}

export function classifyOnset(frame) {
  const { chroma, centroidHz, flatness = 0, clarity = 0, pitchHz = 0 } = frame;

  let sum = 0;
  let max = 0;
  for (const v of chroma) {
    sum += v;
    if (v > max) max = v;
  }
  const mean = sum / 12;
  const peakiness = max > 0 ? max / mean : 0;
  const diag = {
    peakiness: +peakiness.toFixed(2),
    flatness: +flatness.toFixed(3),
    clarity: +clarity.toFixed(2),
    pitchHz: Math.round(pitchHz),
    centroidHz: Math.round(centroidHz),
  };

  // Percussive only when clearly noise-like on all counts.
  const noisy = clarity < CLARITY_MIN && flatness > FLAT_NOISE && peakiness < PEAKY_THRESHOLD;
  if (sum <= 0 || max <= 0 || noisy) {
    return { type: "percussive", drum: drumFromCentroid(centroidHz), centroidHz, diag };
  }

  // Pitched. A clear fundamental gives the exact note+octave; otherwise treat
  // it as polyphonic and place the dominant pitch classes in one register.
  // Monophonic input (a sung note, a single string) is either high-clarity, or
  // moderate-clarity with a strongly peaked chroma — both mean ONE note, so we
  // trust the detected pitch instead of scattering its harmonics into a chord.
  const pitchOk = pitchHz >= PITCH_LO && pitchHz <= PITCH_HI;
  const monophonic =
    pitchOk && (clarity >= CLARITY_HIGH || (clarity >= CLARITY_MIN && peakiness >= MONO_PEAKY));
  let notes;
  if (monophonic) {
    const { pc, octave } = freqToNote(pitchHz);
    notes = [{ pc, octave, energy: 1 }];
  } else {
    const octave = centroidToOctave(centroidHz);
    const pickThreshold = max * RELATIVE_PICK;
    notes = [];
    for (let pc = 0; pc < 12; pc++) {
      if (chroma[pc] >= pickThreshold) notes.push({ pc, octave, energy: chroma[pc] / max });
    }
    notes.sort((a, b) => b.energy - a.energy);
    notes = notes.slice(0, MAX_NOTES);
    if (notes.length === 0 && pitchOk) {
      const n = freqToNote(pitchHz);
      notes = [{ pc: n.pc, octave: n.octave, energy: 1 }];
    }
  }

  return { type: "pitched", notes, centroidHz, diag };
}
