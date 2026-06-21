// features.js — runs Meyda over the audio source and emits a feature frame
// many times a second.
//
// We extract the raw building blocks and leave interpretation (onsets,
// pitched-vs-percussive, mode) to later modules. Spectral flux is computed
// here from the amplitude spectrum so we do not depend on it being a built-in
// Meyda feature across versions.

import Meyda from "https://esm.sh/meyda@5";
import { PitchDetector } from "https://esm.sh/pitchy@4";

// 1024 samples ≈ 23ms per frame at 44.1kHz (~43 frames/sec). Good balance:
// fine enough for responsive onsets, coarse enough for stable chroma.
const BUFFER_SIZE = 1024;
// Pitch needs a much longer window than onsets: ~93ms gives a low note enough
// cycles to lock its true fundamental (a short window octave-errors and reads
// low clarity, which is what scattered one sung note into several). We keep a
// rolling window of the recent samples and run the detector over all of it.
const PITCH_SIZE = 4096;

const FEATURE_EXTRACTORS = [
  "rms",
  "spectralCentroid",
  "spectralFlatness",
  "chroma",
  "amplitudeSpectrum",
  "buffer", // time-domain signal, for pitch detection
];

export function createAnalyzer({ audioContext, sourceNode }, onFrame) {
  let prevSpectrum = null;
  // McLeod pitch detector: gives a fundamental frequency + a 0..1 clarity that
  // is high for clear single pitches and low for noise/percussion.
  const pitchDetector = PitchDetector.forFloat32Array(PITCH_SIZE);
  pitchDetector.minVolumeDecibels = -45; // ignore near-silence
  const pitchRing = new Float32Array(PITCH_SIZE); // rolling window of recent audio

  const analyzer = Meyda.createMeydaAnalyzer({
    audioContext,
    source: sourceNode,
    bufferSize: BUFFER_SIZE,
    featureExtractors: FEATURE_EXTRACTORS,
    callback: (features) => {
      const spectrum = features.amplitudeSpectrum;

      // Spectral flux: sum of positive changes bin-to-bin. A sharp rise means
      // new energy appeared — the basis for onset detection in the next module.
      let flux = 0;
      if (prevSpectrum && spectrum) {
        const n = Math.min(prevSpectrum.length, spectrum.length);
        for (let i = 0; i < n; i++) {
          const diff = spectrum[i] - prevSpectrum[i];
          if (diff > 0) flux += diff;
        }
      }
      prevSpectrum = spectrum;

      // Fundamental pitch + clarity from the time-domain buffer.
      let pitchHz = 0;
      let clarity = 0;
      if (features.buffer) {
        // Slide the newest frame into the rolling window and detect over it all.
        pitchRing.copyWithin(0, BUFFER_SIZE);
        pitchRing.set(features.buffer, PITCH_SIZE - BUFFER_SIZE);
        const [p, c] = pitchDetector.findPitch(pitchRing, audioContext.sampleRate);
        pitchHz = p || 0;
        clarity = c || 0;
      }

      onFrame({
        rms: features.rms || 0,
        // Meyda returns the centroid as an FFT bin index; convert to Hz so
        // downstream code can reason in musical terms.
        centroidHz: ((features.spectralCentroid || 0) * audioContext.sampleRate) / BUFFER_SIZE,
        // 0 = tonal/pitched, ~1 = noisy/percussive.
        flatness: features.spectralFlatness || 0,
        chroma: features.chroma || new Array(12).fill(0),
        pitchHz,
        clarity,
        flux,
        sampleRate: audioContext.sampleRate,
      });
    },
  });

  return {
    start: () => analyzer.start(),
    stop: () => analyzer.stop(),
  };
}
