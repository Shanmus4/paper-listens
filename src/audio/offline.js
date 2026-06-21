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
import { createNoteTracker, makeVoicedGate } from "./tracker.js";
import { extractChord } from "./chord.js";

const BUFFER_SIZE = 1024; // must match the live analyzer for identical behavior
const PITCH_SIZE = 2048; // pitch window (matches features.js): locks low guitar notes

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

// A stable per-event seed keeps a blot's shape identical every rebuild.
const seedFor = (tSec) => (tSec * 9301 + 49297) % 1 || 0.5;

// A chord onset: paint every detected tone (chroma-based, see chord.js).
function chordEvent(tSec, notes, frame, vibrancy) {
  const cls = { type: "pitched", notes, centroidHz: frame.centroidHz };
  return { t: tSec, type: "pitched", cls, frame, vibrancy, seed: seedFor(tSec) };
}
// A continuous stroke: one small puff at a (fractional) MIDI pitch, emitted
// every voiced frame. Held notes stack puffs and grow; slides lay a trail.
// `hue` (0..360) is the note's held random color (deterministic per note start).
// `restrike` is true only on a note's first frame / a re-pluck, so the renderer
// fades any prior ink at that spot (history) while sustain frames accumulate.
function strokeEvent(tSec, midi, dir, hue, restrike, frame, vibrancy) {
  return { t: tSec, type: "stroke", midi, dir, hue, restrike, frame, vibrancy, seed: seedFor(tSec) };
}
const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
// Deterministic random-ish hue from a note's start time, spaced by the golden
// angle so consecutive notes get well-separated colors. Same time -> same hue,
// so seeking rebuilds the identical painting.
const hueAt = (tSec) => (tSec * 1000 * 0.137508 * 360) % 360;
function percEvent(tSec, cls, frame, vibrancy) {
  return { t: tSec, type: "percussive", cls, frame, vibrancy, seed: seedFor(tSec) };
}

// Returns { duration, events } where events are sorted by time (seconds).
export function analyzeBuffer(audioBuffer, { sensitivity = 0.5 } = {}) {
  const sr = audioBuffer.sampleRate;
  const signal = toMono(audioBuffer);

  Meyda.bufferSize = BUFFER_SIZE;
  Meyda.sampleRate = sr;

  const onset = createOnsetDetector({ sensitivity });
  const mode = createModeTracker();
  const tracker = createNoteTracker(); // tuner-style tracking (kept for percussion gating)
  const voiced = makeVoicedGate(); // per-frame "clear pitch?" for continuous strokes
  let strokeMidi = null; // smoothed pitch across frames (same glide logic as the mic)
  let strokeHue = 0; // held random color of the current note (set at note start)
  const detector = PitchDetector.forFloat32Array(PITCH_SIZE);
  detector.minVolumeDecibels = -45;
  const pitchChunk = new Float32Array(PITCH_SIZE); // trailing window for pitch

  const events = [];
  // A coarse loudness envelope (one value per analysis frame) so the level
  // meter can show the song's dynamics during playback, not just at onsets.
  const env = [];
  const envStep = BUFFER_SIZE / sr; // seconds between envelope samples
  const chunk = new Float32Array(BUFFER_SIZE);
  let prevSpectrum = null;

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

    // Pitch over a longer trailing window ending at this frame (zero-padded at
    // the very start of the song). Matches the live analyzer's rolling window.
    const pend = start + BUFFER_SIZE;
    const pstart = pend - PITCH_SIZE;
    pitchChunk.fill(0);
    const from = Math.max(0, pstart);
    pitchChunk.set(signal.subarray(from, pend), from - pstart);
    const [p, c] = detector.findPitch(pitchChunk, sr);
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

    // Same continuous tracking as the live mic: a clear stable pitch becomes one
    // note; a noisy pitchless attack may be percussion; garbage pitch paints
    // nothing (no invented chords).
    // Same layering as the live mic: a true simultaneous strum paints all its
    // tones; otherwise a clear pitch paints a continuous stroke (sustain grows,
    // slides trail); a noisy pitchless attack may be a drum (songs really do
    // have drums, so we keep percussion for files).
    const chord = on ? extractChord(frame) : null;
    const r = tracker.process(frame, on);
    if (chord) {
      strokeMidi = null;
      events.push(chordEvent(tSec, chord, frame, mode.getVibrancy()));
    } else if (voiced(frame)) {
      const m = midiOf(frame.pitchHz);
      let dir = null;
      let fresh = false; // first frame of a new note / a re-pluck
      if (strokeMidi == null || Math.abs(m - strokeMidi) > 7) {
        strokeMidi = m; // new note / leap
        strokeHue = hueAt(tSec); // a fresh random color for the new note
        fresh = true;
      } else {
        const dm = m - strokeMidi;
        strokeMidi += dm * 0.5; // glide
        if (Math.abs(dm) > 0.04) dir = [0, -Math.sign(dm)]; // rising up, falling down
      }
      if (on) {
        strokeHue = hueAt(tSec); // a fresh pluck recolors
        fresh = true;
      }
      events.push(strokeEvent(tSec, strokeMidi, dir, strokeHue, fresh, frame, mode.getVibrancy()));
    } else {
      strokeMidi = null;
      if (r && r.type === "perc") {
        const cls = classifyOnset(frame);
        if (cls.type === "percussive") events.push(percEvent(tSec, cls, frame, mode.getVibrancy()));
      }
    }
  }

  return { duration: audioBuffer.duration, events, env, envStep };
}
