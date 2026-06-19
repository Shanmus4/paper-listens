// offline.js — analyzes a whole decoded song up-front into a timeline.
//
// Live mic input paints as it arrives, but an uploaded file we can read in
// full ahead of time. We run the exact same pipeline (features -> onset ->
// deferred classify -> mode) over the audio offline and record each paint as a
// timed event. That timeline is what makes seeking possible: the painting at
// any moment is just "every event up to that time", so scrubbing to the end
// shows the finished piece instantly.

import Meyda from "https://esm.sh/meyda@5";
import { PitchDetector } from "https://esm.sh/pitchy@4";
import { createOnsetDetector } from "./onset.js";
import { createModeTracker } from "./mode.js";
import { classifyOnset } from "./classify.js";

const BUFFER_SIZE = 1024; // must match the live analyzer for identical behavior
const CLASSIFY_FRAMES = 3; // sustain frames gathered after an attack

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

function finalize(p, vibrancy) {
  const n = p.count || 1;
  const frame = {
    rms: p.rmsMax,
    centroidHz: p.centroidSum / n,
    flatness: p.flatSum / n,
    clarity: p.bestClarity,
    pitchHz: p.bestPitch,
    chroma: p.chroma.map((v) => v / n),
  };
  const cls = classifyOnset(frame);
  // A stable per-event seed keeps a blot's shape identical every time the
  // painting is rebuilt (e.g. when seeking backwards).
  return { t: p.tSec, type: cls.type, cls, frame, vibrancy, seed: (p.tSec * 9301 + 49297) % 1 || 0.5 };
}

// Returns { duration, events } where events are sorted by time (seconds).
export function analyzeBuffer(audioBuffer, { sensitivity = 0.5 } = {}) {
  const sr = audioBuffer.sampleRate;
  const signal = toMono(audioBuffer);

  Meyda.bufferSize = BUFFER_SIZE;
  Meyda.sampleRate = sr;

  const onset = createOnsetDetector({ sensitivity });
  const mode = createModeTracker();
  const detector = PitchDetector.forFloat32Array(BUFFER_SIZE);
  detector.minVolumeDecibels = -45;

  const events = [];
  // A coarse loudness envelope (one value per analysis frame) so the level
  // meter can show the song's dynamics during playback, not just at onsets.
  const env = [];
  const envStep = BUFFER_SIZE / sr; // seconds between envelope samples
  const chunk = new Float32Array(BUFFER_SIZE);
  let prevSpectrum = null;
  let pending = null;

  const nFrames = Math.floor(signal.length / BUFFER_SIZE);
  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * BUFFER_SIZE;
    chunk.set(signal.subarray(start, start + BUFFER_SIZE));

    const feat = Meyda.extract(FEATURES, chunk);
    const spectrum = feat.amplitudeSpectrum;

    let flux = 0;
    if (prevSpectrum && spectrum) {
      const n = Math.min(prevSpectrum.length, spectrum.length);
      for (let i = 0; i < n; i++) {
        const d = spectrum[i] - prevSpectrum[i];
        if (d > 0) flux += d;
      }
    }
    prevSpectrum = spectrum;

    const [p, c] = detector.findPitch(chunk, sr);
    const frame = {
      rms: feat.rms || 0,
      centroidHz: ((feat.spectralCentroid || 0) * sr) / BUFFER_SIZE,
      flatness: feat.spectralFlatness || 0,
      chroma: feat.chroma || new Array(12).fill(0),
      pitchHz: p || 0,
      clarity: c || 0,
      flux,
    };

    env.push(frame.rms);

    const tSec = start / sr;
    mode.update(frame.chroma, frame.rms);
    mode.evaluate();
    const on = onset.process(frame.flux, frame.rms, tSec * 1000);

    if (pending) {
      for (let i = 0; i < 12; i++) pending.chroma[i] += frame.chroma[i];
      pending.centroidSum += frame.centroidHz;
      pending.flatSum += frame.flatness || 0;
      pending.rmsMax = Math.max(pending.rmsMax, frame.rms);
      if ((frame.clarity || 0) > pending.bestClarity) {
        pending.bestClarity = frame.clarity;
        pending.bestPitch = frame.pitchHz;
      }
      if (++pending.count >= CLASSIFY_FRAMES) {
        events.push(finalize(pending, mode.getVibrancy()));
        pending = null;
      }
      continue;
    }

    if (on) {
      pending = {
        count: 0,
        chroma: new Array(12).fill(0),
        centroidSum: 0,
        flatSum: 0,
        rmsMax: frame.rms,
        bestClarity: frame.clarity || 0,
        bestPitch: frame.pitchHz || 0,
        tSec,
      };
    }
  }
  if (pending) events.push(finalize(pending, mode.getVibrancy()));

  return { duration: audioBuffer.duration, events, env, envStep };
}
