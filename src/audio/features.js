// features.js — runs Meyda over the audio source and emits a feature frame
// many times a second.
//
// We extract the raw building blocks and leave interpretation (onsets,
// pitched-vs-percussive, mode) to later modules. Spectral flux is computed
// here from the amplitude spectrum so we do not depend on it being a built-in
// Meyda feature across versions.

import Meyda from "https://esm.sh/meyda@5";
import { PitchDetector } from "https://esm.sh/pitchy@4";
import { createMagFFT } from "./fft.js";

const POLY_SIZE = 4096; // high-res window for polyphonic pluck detection

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
  // dropped octaves 1-2. But -72dB was too low: in a quiet room the detector
  // locked onto sub-audio rumble (~6-20Hz) with high clarity and painted phantom
  // notes. The real guards now live in main.js (a low master RMS gate + a musical
  // pitch floor that rejects the <62Hz rumble), so the detector can stay sensitive
  // like a tuner: -60dB keeps a quiet laptop/phone mic detecting soft playing.
  pitchDetector.minVolumeDecibels = -60;

  // Pitch reads RAW time-domain samples from an AnalyserNode tap — exactly how a
  // hardware/software tuner does it. We must NOT reuse Meyda's buffer: Meyda
  // windows (tapers) that signal for its spectral math, and stitching windowed
  // chunks together corrupts the waveform and wrecks pitch detection.
  const pitchNode = audioContext.createAnalyser();
  pitchNode.fftSize = PITCH_SIZE;
  sourceNode.connect(pitchNode);
  const pitchBuf = new Float32Array(pitchNode.fftSize);
  // Own FFT for the high-res magnitude spectrum the polyphonic detector needs.
  // Computed from the last POLY_SIZE samples of the same time-domain tap.
  const polyFFT = createMagFFT(POLY_SIZE);

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

      // High-res magnitude spectrum (last POLY_SIZE samples) for poly detection.
      const spectrumHi = polyFFT.mag(pitchBuf.subarray(pitchBuf.length - POLY_SIZE));

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
        spectrumHi,
        sampleRate: audioContext.sampleRate,
      });
    },
  });

  return {
    start: () => analyzer.start(),
    stop: () => analyzer.stop(),
  };
}
