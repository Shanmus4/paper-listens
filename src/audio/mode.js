// mode.js — tracks the musical mode (scale flavor) over time and turns it into
// a single "vibrancy" number the painting uses.
//
// Idea: brighter modes paint more vivid, darker modes paint more muted. We keep
// a slowly-decaying chroma profile (which pitch classes have been emphasized
// lately), guess the tonic as the most-emphasized pitch class, then score the
// seven diatonic modes built on that tonic and pick the best fit.
//
// Honest limitation: tonic-from-emphasis is a heuristic. Two pieces with the
// same notes but different tonal centers can be read as different modes. It is
// responsive and plausible for live play; a temporal/bass-aware tonic finder
// is a future improvement.

// Scale degrees (semitones from tonic) for each mode, brightest to darkest.
const MODE_DEGREES = {
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Ionian: [0, 2, 4, 5, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Aeolian: [0, 2, 3, 5, 7, 8, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Locrian: [0, 1, 3, 5, 6, 8, 10],
};

// How vivid each mode paints. Lydian brightest, Locrian bleakest.
export const MODE_VIBRANCY = {
  Lydian: 1.2,
  Ionian: 1.0,
  Mixolydian: 0.92,
  Dorian: 0.82,
  Aeolian: 0.7,
  Phrygian: 0.55,
  Locrian: 0.4,
};

const DECAY = 0.985; // per-frame profile decay (~1.5s memory at 43fps)
const MIN_RMS = 0.006; // do not learn from silence
const MIN_ENERGY = 0.5; // profile energy before we trust a mode guess
const VIB_LERP = 0.04; // how fast vibrancy eases toward its target

// Precompute each mode as a 12-bin mask rooted at C, ready to rotate.
const MODE_MASKS = Object.fromEntries(
  Object.entries(MODE_DEGREES).map(([mode, degs]) => {
    const mask = new Array(12).fill(0);
    for (const d of degs) mask[d] = 1;
    return [mode, mask];
  })
);

export function createModeTracker() {
  const profile = new Array(12).fill(0);
  let vibrancy = 1.0; // smoothed, starts neutral (Ionian)
  let mode = "Ionian";
  let tonic = 0;

  // Fold a frame of chroma into the decaying profile.
  function update(chroma, rms) {
    for (let i = 0; i < 12; i++) {
      profile[i] = profile[i] * DECAY + (rms > MIN_RMS ? chroma[i] : 0);
    }
  }

  // Re-estimate tonic + mode and ease vibrancy toward the target.
  function evaluate() {
    let total = 0;
    let peak = 0;
    let peakPc = 0;
    for (let i = 0; i < 12; i++) {
      total += profile[i];
      if (profile[i] > peak) {
        peak = profile[i];
        peakPc = i;
      }
    }
    if (total < MIN_ENERGY) return; // not enough to judge; hold the default

    tonic = peakPc;

    let best = mode;
    let bestScore = -1;
    for (const [name, mask] of Object.entries(MODE_MASKS)) {
      let score = 0;
      for (let pc = 0; pc < 12; pc++) {
        // rotate the C-rooted mask up to the tonic
        score += profile[pc] * mask[(pc - tonic + 12) % 12];
      }
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    mode = best;

    const target = MODE_VIBRANCY[mode];
    vibrancy += (target - vibrancy) * VIB_LERP;
  }

  return {
    update,
    evaluate,
    getVibrancy: () => vibrancy,
    getMode: () => mode,
    getTonic: () => tonic,
  };
}
