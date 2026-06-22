// polypitch.js — lightweight POLYPHONIC pitch estimation (harmonic salience).
//
// Our McLeod detector (pitchy) names ONE fundamental, so a fingerstyle pattern —
// which is a chord plucked note by note, with strings still ringing — collapses
// onto whichever pitch is loudest (usually the bass). This estimator instead
// finds the few strongest notes sounding AT ONCE, so each plucked/ringing note
// can paint at its own spot.
//
// Method (a small Klapuri-style harmonic-sum loop): score every candidate note
// by the energy sitting on its harmonic series, take the strongest, attenuate
// that note's harmonics in a working copy of the spectrum, and repeat for the
// next note. It is NOT a transcription model — it can slip an octave or miss a
// quiet inner voice — but it reliably tells "several notes" from "one note",
// which is exactly what the fingerstyle case needs. Pure + deterministic: the
// same spectrum always yields the same notes, so file seeks rebuild identically.

const A4 = 440;
const midiToHz = (m) => A4 * Math.pow(2, (m - 69) / 12);

export function createPolyPitch({
  sampleRate,
  fftSize,
  midiLo = 24, // C1 — the bottom of the grid (covers piano/bass, not just guitar)
  midiHi = 107, // B7 — the top of the grid
  harmonics = 8,
  maxNotes = 3,
  relCut = 0.3, // a later note must be >= this fraction of the lead note's salience
} = {}) {
  const binWidth = sampleRate / fftSize;
  const nBins = Math.floor(fftSize / 2);

  // Precompute the harmonic bin indices for every candidate note once.
  const cand = [];
  for (let midi = midiLo; midi <= midiHi; midi++) {
    const f0 = midiToHz(midi);
    const bins = [];
    for (let h = 1; h <= harmonics; h++) {
      const b = Math.round((h * f0) / binWidth);
      if (b >= nBins) break;
      bins.push(b);
    }
    if (bins.length >= 2) cand.push({ midi, f0, bins });
  }

  // A running "background" spectrum: an EMA of recent frames. Energy already in
  // the background is sustained/ringing sound; energy ABOVE it is something just
  // plucked. Comparing against it is what lets us pick out a new note while older
  // notes still ring (the fingerstyle case) and ignore a sustained note's
  // overtones (so one rich note doesn't read as a phantom chord).
  const ref = new Float32Array(nBins);
  const REF_KEEP = 0.6; // how much of the old background survives each frame

  function reset() {
    ref.fill(0);
  }

  // Two notes are "harmonically related" when their frequency ratio is near a
  // strong overtone ratio (octave 2, twelfth 3, fifth 1.5, double-octave 4, ...).
  // A single rich string lights up these intervals on its own, so when the pluck
  // delta shows them we treat them as ONE note's overtones, not separate notes.
  // (Cost: a fifth/octave double-stop reads as one note — acceptable, since the
  // alternative is every single fingerstyle note exploding into a phantom chord.)
  // Small-integer frequency ratios that a single note's overtones produce —
  // including the ratios BETWEEN adjacent upper harmonics (6/5, 5/4, 4/3, 3/2,
  // 5/3, 5/2) which is where two harmonics of one note were sneaking through as
  // a fake second note. A second note survives only if it is in NONE of these
  // (a dissonant/independent interval -> a real second voice).
  const RATIOS = [1.2, 1.25, 1.333, 1.5, 1.667, 2, 2.5, 3, 4, 5, 6];
  function harmonicallyRelated(hzA, hzB) {
    const r = Math.max(hzA, hzB) / Math.min(hzA, hzB);
    return RATIOS.some((k) => Math.abs(r - k) < 0.035 * k);
  }

  // Call EVERY frame to keep the background current. On a pluck (isOnset) it
  // returns the NEWLY appeared notes (detect run on the spectrum delta); between
  // plucks it returns [] and just updates the background. This is the fingerstyle
  // path: each pluck paints its own note even while earlier notes still ring.
  function pluck(mag, isOnset) {
    let out = [];
    if (isOnset) {
      const delta = new Float32Array(nBins);
      for (let i = 0; i < nBins; i++) {
        const m = mag[i] > 0 ? mag[i] : 0;
        const d = m - ref[i];
        delta[i] = d > 0 ? d : 0; // only energy that just appeared
      }
      // The delta isolates the energy that JUST appeared (a note plucked over a
      // still-ringing one), and detect() suppresses each picked note's harmonics
      // and drops anything below relCut — so the few peaks it returns are
      // genuinely distinct. Keep up to maxNotes so overlapping notes each paint,
      // rejecting only a weaker octave of one already kept (a leftover overtone).
      const raw = detect(delta);
      for (const n of raw) {
        if (out.length === 0) {
          out.push(n);
          continue;
        }
        if (out.length >= maxNotes) break;
        // A further note must be a REAL separate voice, not a detection artifact.
        // Three guards, all of which a single rich note's stray peaks fail:
        //   1) it sits FAR from the lead either way (a high partial above, or a
        //      spurious sub/low below) — real overlapping notes and chord tones
        //      cluster within ~1.3 octaves of each other, so reject the wide ones;
        //   2) it lands on an overtone interval of a kept note AND is weaker;
        //   3) it isn't strong (a true simultaneous/overlapping note is loud in
        //      the delta; a leftover partial is not).
        const tooFar = Math.abs(n.midi - out[0].midi) > 16; // > ~1.3 octaves from the lead
        const overtone = out.some((k) => harmonicallyRelated(k.hz, n.hz) && n.energy < k.energy);
        if (!tooFar && !overtone && n.energy >= 0.7) out.push(n);
      }
    }
    for (let i = 0; i < nBins; i++) {
      const m = mag[i] > 0 ? mag[i] : 0;
      ref[i] = ref[i] * REF_KEEP + m * (1 - REF_KEEP);
    }
    return out;
  }

  // mag: linear magnitude spectrum (Float32Array, length >= nBins).
  // Returns up to maxNotes [{ midi, hz, energy }] sorted strongest-first.
  function detect(mag) {
    const work = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) work[i] = mag[i] > 0 ? mag[i] : 0;

    // Peak around a bin (±1) tolerates slight detuning / FFT bin straddling.
    const peak = (b) => {
      const a = b > 0 ? work[b - 1] : 0;
      const c = b + 1 < nBins ? work[b + 1] : 0;
      return Math.max(a, work[b], c);
    };
    // Salience = harmonic-weighted energy, with the fundamental counted double so
    // a note's own pitch (not just shared overtones) drives the score. This curbs
    // the octave-up error where 2*f0's harmonics also light up.
    const salience = (c) => {
      let s = peak(c.bins[0]); // fundamental, extra weight (counted again below)
      for (let i = 0; i < c.bins.length; i++) s += peak(c.bins[i]) / (i + 1);
      return s;
    };

    const notes = [];
    let lead = 0;
    for (let k = 0; k < maxNotes; k++) {
      let best = null;
      let bestS = 0;
      for (const c of cand) {
        const s = salience(c);
        if (s > bestS) {
          bestS = s;
          best = c;
        }
      }
      if (!best || bestS <= 0) break;
      if (k === 0) lead = bestS;
      else if (bestS < lead * relCut) break; // too weak next to the lead note

      notes.push({ midi: best.midi, hz: best.f0, energy: lead > 0 ? bestS / lead : 1 });

      // Attenuate this note's harmonics so the next iteration finds a new note.
      // A wider band (±2 bins) is important for real strings: their upper partials
      // are slightly SHARP of exact integer multiples (inharmonicity), so a narrow
      // notch misses them and they get mistaken for separate notes. We also notch
      // the bin just above each harmonic to catch that sharpness.
      for (const b of best.bins) {
        for (let d = -2; d <= 3; d++) {
          const bb = b + d;
          if (bb >= 0 && bb < nBins) work[bb] *= 0.12;
        }
      }
    }
    return notes;
  }

  return { detect, pluck, reset, binWidth, nBins };
}
