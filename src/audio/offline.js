// offline.js — analyzes a whole decoded song up-front into a timeline.
//
// Live mic input paints as it arrives, but an uploaded file we can read in full
// ahead of time. We run the SAME spectral painter (audio/spectral.js) over the
// audio offline and record each analyzed frame as a timed event. That timeline is
// what makes seeking possible: the painting at any moment is just "every event up
// to that time", so scrubbing to the end shows the finished piece instantly.
//
// Each event is one frame's worth of paint: the spectral peaks (notes/overtones
// sounding then) plus a "wash" scalar for noisy/drum frames. Colour is NOT stored
// — it is derived from the event's own time at paint time (timeHue), so a seek
// rebuilds the identical palette. Deterministic: same audio -> same events.

import Meyda from "https://esm.sh/meyda@5";
import { createModeTracker } from "./mode.js";
import { createMagFFT } from "./fft.js";
import { createSpectralPainter } from "./spectral.js";

const BUFFER_SIZE = 1024; // must match the live analyzer for identical behavior
const POLY_SIZE = 4096; // high-res window for the spectral painter (finer bins than 1024)

const FEATURES = ["rms", "spectralCentroid", "spectralFlatness", "chroma", "amplitudeSpectrum"];

// Mix all channels down to one Float32Array so analysis matches the mono mic.
function toMono(audioBuffer) {
  const len = audioBuffer.length;
  const chs = audioBuffer.numberOfChannels;
  if (chs === 1) return audioBuffer.getChannelData(0);
  const out = new Float32Array(len);
  for (let c = 0; c < chs; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i] / chs;
  }
  return out;
}

// One analyzed frame: the spectral peaks + wash, timed. `frame` carries the raw
// features the renderer needs (rms for size, flatness/centroid for the wash).
function spectralEvent(tSec, points, wash, frame, vibrancy) {
  return { t: tSec, type: "spectral", points, wash, frame, vibrancy };
}

// Returns { duration, events, env, envStep }. events are sorted by time (seconds).
export function analyzeBuffer(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  const signal = toMono(audioBuffer);

  Meyda.bufferSize = BUFFER_SIZE;
  Meyda.sampleRate = sr;

  const mode = createModeTracker();
  const polyFFT = createMagFFT(POLY_SIZE); // own FFT (no Meyda window-size toggling)
  const spectral = createSpectralPainter({ sampleRate: sr, fftSize: POLY_SIZE });

  const events = [];
  // A coarse loudness envelope (one value per analysis frame) so the level meter
  // can show the song's dynamics during playback, not just at paint moments.
  const env = [];
  const envStep = BUFFER_SIZE / sr; // seconds between envelope samples
  const chunk = new Float32Array(BUFFER_SIZE);
  const polyChunk = new Float32Array(POLY_SIZE); // trailing window for the spectrum

  const nFrames = Math.floor(signal.length / BUFFER_SIZE);
  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * BUFFER_SIZE;
    chunk.set(signal.subarray(start, start + BUFFER_SIZE));

    const feat = Meyda.extract(FEATURES, chunk);
    const frame = {
      rms: feat.rms || 0,
      centroidHz: ((feat.spectralCentroid || 0) * sr) / BUFFER_SIZE,
      flatness: feat.spectralFlatness || 0,
      chroma: feat.chroma || new Array(12).fill(0),
    };
    env.push(frame.rms);

    // High-resolution magnitude spectrum (last POLY_SIZE samples ending at this
    // frame, zero-padded at the very start). Matches the live analyzer's window.
    const polyEnd = start + BUFFER_SIZE;
    const polyStart = polyEnd - POLY_SIZE;
    polyChunk.fill(0);
    const pfrom = Math.max(0, polyStart);
    polyChunk.set(signal.subarray(pfrom, polyEnd), pfrom - polyStart);
    const polySpec = polyFFT.mag(polyChunk);

    const tSec = start / sr;
    mode.update(frame.chroma, frame.rms);
    mode.evaluate();

    const { points, wash } = spectral.analyze(polySpec, frame);
    if (points.length || wash > 0.02) {
      events.push(spectralEvent(tSec, points, wash, frame, mode.getVibrancy()));
    }
  }

  return { duration: audioBuffer.duration, events, env, envStep };
}
