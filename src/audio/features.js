// features.js — runs Meyda over the audio source and emits a feature frame
// many times a second.
//
// We extract the raw building blocks and leave interpretation (onsets,
// pitched-vs-percussive, mode) to later modules. Spectral flux is computed
// here from the amplitude spectrum so we do not depend on it being a built-in
// Meyda feature across versions.

import Meyda from "https://esm.sh/meyda@5";

// 1024 samples ≈ 23ms per frame at 44.1kHz (~43 frames/sec). Good balance:
// fine enough for responsive onsets, coarse enough for stable chroma.
const BUFFER_SIZE = 1024;

const FEATURE_EXTRACTORS = ["rms", "spectralCentroid", "chroma", "amplitudeSpectrum"];

export function createAnalyzer({ audioContext, sourceNode }, onFrame) {
  let prevSpectrum = null;

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

      onFrame({
        rms: features.rms || 0,
        // Meyda returns the centroid as an FFT bin index; convert to Hz so
        // downstream code can reason in musical terms.
        centroidHz: ((features.spectralCentroid || 0) * audioContext.sampleRate) / BUFFER_SIZE,
        chroma: features.chroma || new Array(12).fill(0),
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
