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
  midiLo = 40, // E2, a guitar's low string
  midiHi = 88, // E6, well above a singing voice
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
      // Keep the freshly plucked FUNDAMENTAL. The delta already isolates the new
      // note from the ringing background — that is the whole point: it catches a
      // melody note plucked over a still-ringing bass (the fingerstyle case the
      // mono detector gets wrong by locking onto the bass). We return just the
      // lead, because a single rich note's overtones span many small-integer
      // ratios and reliably telling "two notes" from "one note's harmonics" needs
      // a real transcription model. A clearly independent, strong, dissonant
      // second note (a true double-stop) is the one exception.
      const raw = detect(delta);
      for (const n of raw) {
        if (out.length === 0) out.push(n);
        else if (out.length < 2 && n.energy >= 0.82 && out.every((k) => !harmonicallyRelated(k.hz, n.hz))) {
          out.push(n);
        }
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
      for (const b of best.bins) {
        for (let d = -1; d <= 1; d++) {
          const bb = b + d;
          if (bb >= 0 && bb < nBins) work[bb] *= 0.12;
        }
      }
    }
    return notes;
  }

  return { detect, pluck, reset, binWidth, nBins };
}
