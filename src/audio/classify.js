// classify.js — decides *what* an onset is.
//
// Given the feature frame at an onset, we split into two visual languages:
//   - pitched (note / chord / vocal): the chroma vector has clear peaks.
//     We return the dominant pitch classes so harmony paints in color.
//   - percussive (kick / snare / hi-hat): the chroma is roughly flat (energy
//     spread across all 12 bins). We classify the drum by spectral centroid
//     so rhythm paints as monochrome ink.

// How peaked the chroma must be to count as pitched. A pure note sits ~3+;
// a flat drum spectrum sits near 1. Dense chords lower this, so we keep the
// bar modest. Tunable against real audio.
const PEAKY_THRESHOLD = 1.7;

// A pitch class is "present" if it reaches this fraction of the strongest bin.
// 0.6 keeps single notes clean (rejects spectral-leakage neighbours) while
// still capturing the 3-4 real tones of a chord.
const RELATIVE_PICK = 0.6;

const MAX_PITCHES = 4;

function drumFromCentroid(hz) {
  if (hz < 1200) return "kick";
  if (hz < 3500) return "snare";
  return "hihat";
}

export function classifyOnset(frame) {
  const { chroma, centroidHz } = frame;

  let sum = 0;
  let max = 0;
  for (const v of chroma) {
    sum += v;
    if (v > max) max = v;
  }

  if (sum <= 0 || max <= 0) {
    return { type: "percussive", drum: drumFromCentroid(centroidHz), centroidHz };
  }

  const mean = sum / 12;
  const peakiness = max / mean; // 1 = flat, higher = more tonal

  if (peakiness < PEAKY_THRESHOLD) {
    return { type: "percussive", drum: drumFromCentroid(centroidHz), centroidHz };
  }

  // Pitched: collect the dominant pitch classes relative to the strongest.
  const pickThreshold = max * RELATIVE_PICK;
  const pitches = [];
  for (let pc = 0; pc < 12; pc++) {
    if (chroma[pc] >= pickThreshold) pitches.push({ pc, energy: chroma[pc] });
  }
  pitches.sort((a, b) => b.energy - a.energy);

  return {
    type: "pitched",
    pitches: pitches.slice(0, MAX_PITCHES),
    centroidHz,
  };
}
