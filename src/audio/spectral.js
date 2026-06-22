// spectral.js — the SPECTRAL PAINTER.
//
// The old engine was a transcriber: every onset it picked the one or two loudest
// notes and painted only those, throwing the rest of the sound away (so a whole
// song collapsed onto whatever instrument was loudest, and a pure whistle
// mislocked onto wrong low notes). This instead paints the SOUND ITSELF: every
// analysis frame it reads the magnitude spectrum and lays a mark wherever there
// is energy, at that energy's real pitch on the grid. A single note paints its
// fundamental plus fainter overtones; a chord paints several marks; a broadband
// drum hit paints a soft neutral wash; a slide moves the energy across the grid
// frame to frame. Nothing gets ignored, because nothing is thrown away.
//
// Method: fold the FFT bins into a pitch histogram (a few cells per semitone),
// pick the few strongest peaks (this is the per-frame work bound), and report
// them as paint points. A separate "wash" scalar rises when the frame is noisy
// (drums/breath) so the caller can paint a grey smear instead of coloured dots.
//
// Pure + deterministic: the same spectrum always yields the same points, so file
// seeks rebuild identically. Buffers are preallocated and reused (like fft.js) so
// the hot path allocates nothing.

import { loudnessOf } from "../visual/synesthesia.js";

const MIDI_LO = 24; // C1, the bottom of the grid
const MIDI_HI = 107; // B7, the top of the grid
const BINS_PER_SEMITONE = 3; // pitch resolution of the histogram

const PEAK_REL = 0.15; // a peak must clear this fraction of the frame's loudest cell
const MAX_NOTES = 10; // most paint points per frame (the draw-call bound)
const SILENCE_RMS = 0.004; // below this it's room noise / silence -> paint nothing

// How noisy a frame must be before it reads as a "wash" (drums, breath, cymbals)
// rather than clear notes. Between these two flatness values the wash fades in and
// the coloured points fade out, so a snare smears instead of spraying 16 dots.
// Calibrated to Meyda's spectral flatness for real music: tonal frames sit around
// 0.02-0.06, while the noisy percussive frames reach 0.15-0.32 — so the band lives
// down there, not near 1.0.
const FLAT_LO = 0.07;
const FLAT_HI = 0.18;

const A4 = 440;
const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / A4);

function smoothstep(lo, hi, x) {
  if (hi <= lo) return x >= hi ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

export function createSpectralPainter({ sampleRate, fftSize }) {
  const binWidth = sampleRate / fftSize;
  const nBins = Math.floor(fftSize / 2);
  const nCells = (MIDI_HI - MIDI_LO) * BINS_PER_SEMITONE + 1;

  // Precompute which histogram cell each FFT bin lands in (bin width is fixed, so
  // this never changes). -1 = outside the grid's pitch range; bin 0 is DC.
  const binCell = new Int16Array(nBins);
  for (let i = 0; i < nBins; i++) {
    const hz = i * binWidth;
    if (i === 0 || hz < 28) {
      binCell[i] = -1;
      continue;
    }
    const midi = hzToMidi(hz);
    const j = Math.round((midi - MIDI_LO) * BINS_PER_SEMITONE);
    binCell[i] = j >= 0 && j < nCells ? j : -1;
  }

  const midiForCell = new Float32Array(nCells);
  for (let j = 0; j < nCells; j++) midiForCell[j] = MIDI_LO + j / BINS_PER_SEMITONE;

  const hist = new Float32Array(nCells); // reused every frame

  // magSpectrum: linear magnitude (Float32Array, length >= nBins). frame carries
  // rms + flatness. Returns { points: [{midi, energy}], wash: 0..1 }.
  function analyze(magSpectrum, frame) {
    const rms = frame.rms || 0;
    if (rms < SILENCE_RMS) return { points: [], wash: 0 };

    // Fold the spectrum into the pitch histogram.
    hist.fill(0);
    let histMax = 0;
    for (let i = 0; i < nBins; i++) {
      const j = binCell[i];
      if (j < 0) continue;
      const m = magSpectrum[i] > 0 ? magSpectrum[i] : 0;
      hist[j] += m;
      if (hist[j] > histMax) histMax = hist[j];
    }
    if (histMax <= 0) return { points: [], wash: 0 };

    // Noisy frames -> a wash; tonal frames -> full points. The two crossfade so a
    // drum hit doesn't both spray dots AND smear at once.
    const wash = smoothstep(FLAT_LO, FLAT_HI, frame.flatness || 0) * loudnessOf(rms);
    const pointScale = 1 - wash;

    // Pick the strongest peaks (local maxima above a relative floor).
    const floor = PEAK_REL * histMax;
    const peaks = [];
    for (let j = 0; j < nCells; j++) {
      const v = hist[j];
      if (v < floor) continue;
      const l = j > 0 ? hist[j - 1] : 0;
      const r = j < nCells - 1 ? hist[j + 1] : 0;
      if (v >= l && v >= r) peaks.push({ j, v });
    }
    peaks.sort((a, b) => b.v - a.v);

    const points = [];
    const k = Math.min(MAX_NOTES, peaks.length);
    for (let n = 0; n < k; n++) {
      const p = peaks[n];
      const energy = (p.v / histMax) * pointScale;
      if (energy <= 0.01) continue; // fully suppressed by the wash
      points.push({ midi: midiForCell[p.j], energy });
    }
    return { points, wash };
  }

  return { analyze, nCells, nBins };
}
