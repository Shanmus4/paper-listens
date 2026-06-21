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
// Pitch reads a big tuner-grade window. A noisy mic signal of a LOW note needs
// many cycles to lock: at 2048 samples a 65Hz (C2) note has only ~3 cycles, so
// clarity drops below our gate and octaves 1-2 vanish. 8192 samples (~186ms)
// gives C2 ~12 cycles and even C1 ~6 — rock-solid, like a hardware tuner. The
// AnalyserNode still updates every Meyda frame (~23ms), so response stays live;
// only the analysis history is longer. (Onsets/chroma still use 1024.)
const PITCH_SIZE = 8192;

const FEATURE_EXTRACTORS = [
  "rms",
  "spectralCentroid",
  "spectralFlatness",
  "chroma",
  "amplitudeSpectrum",
];

export function createAnalyzer({ audioContext, sourceNode }, onFrame) {
  let prevSpectrum = null;
  // McLeod pitch detector: gives a fundamental frequency + a 0..1 clarity that
  // is high for clear single pitches and low for noise/percussion.
  const pitchDetector = PitchDetector.forFloat32Array(PITCH_SIZE);
  // Low notes arrive at a mic much quieter than mids; a -45dB floor silently
  // dropped octaves 1-2. Lower floor lets them through; the tracker's clarity
  // gate still rejects genuine noise, so this doesn't invent notes in silence.
  pitchDetector.minVolumeDecibels = -65;

  // Pitch reads RAW time-domain samples from an AnalyserNode tap — exactly how a
  // hardware/software tuner does it. We must NOT reuse Meyda's buffer: Meyda
  // windows (tapers) that signal for its spectral math, and stitching windowed
  // chunks together corrupts the waveform and wrecks pitch detection.
  const pitchNode = audioContext.createAnalyser();
  pitchNode.fftSize = PITCH_SIZE;
  sourceNode.connect(pitchNode);
  const pitchBuf = new Float32Array(pitchNode.fftSize);

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

      // Fundamental pitch + clarity from the raw time-domain waveform.
      pitchNode.getFloatTimeDomainData(pitchBuf);
      const [p, c] = pitchDetector.findPitch(pitchBuf, audioContext.sampleRate);
      const pitchHz = p || 0;
      const clarity = c || 0;

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
