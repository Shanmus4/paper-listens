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
import { createPolyPitch } from "./polypitch.js";
import { createMagFFT } from "./fft.js";
import { timeHue } from "../visual/synesthesia.js";

const BUFFER_SIZE = 1024; // must match the live analyzer for identical behavior
// Pitch window for the offline file pass. NOTE: the live mic path (features.js)
// uses a larger 8192-sample window to lock very low notes through a noisy mic; a
// decoded file is clean, so 2048 is enough here and keeps the up-front analysis
// fast. The two paths are therefore not bit-identical at the low end.
const PITCH_SIZE = 2048;
const POLY_SIZE = 4096; // window for polyphonic pluck detection (finer bins than 1024)

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

// A pluck onset: paint each freshly sounded note (from polypitch.js) at its spot.
function chordEvent(tSec, notes, frame, vibrancy) {
  const cls = { type: "pitched", notes, centroidHz: frame.centroidHz };
  return { t: tSec, type: "pitched", cls, hue: timeHue(tSec), frame, vibrancy, seed: seedFor(tSec) };
}
// A continuous stroke: one small puff at a (fractional) MIDI pitch, emitted
// every voiced frame. Held notes stack puffs and grow; slides lay a trail.
// `hue` (0..360) is the note's held random color (deterministic per note start).
// `restrike` is true only on a note's first frame / a re-pluck, so the renderer
// fades any prior ink at that spot (history) while sustain frames accumulate.
function strokeEvent(tSec, midi, dir, hue, restrike, shimmer, frame, vibrancy) {
  return { t: tSec, type: "stroke", midi, dir, hue, restrike, shimmer, frame, vibrancy, seed: seedFor(tSec) };
}
const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
function percEvent(tSec, cls, frame, vibrancy) {
  return { t: tSec, type: "percussive", cls, frame, vibrancy, seed: seedFor(tSec) };
}

// One-pole high-pass, applied fresh to a window. Removes the loud low end (bass,
// kick) so a second pitch detector locks onto the sung/lead MELODY instead of the
// bass — which is what a single full-range detector always grabs in a dense mix.
// Hz — below this is treated as bass/kick and rolled off. Set high (300) on
// purpose: in a dense chorus the bass guitar + kick sit at 60-250Hz and drown
// the voice detector, so the sung line stopped painting and only the low bass
// showed (which reads as "drums"). Stripping more low end lets the voice's
// periodicity dominate the high-passed window, recovering the vocal there.
const MEL_CUTOFF = 300;
function highpass(src, dst, sr) {
  const rc = 1 / (2 * Math.PI * MEL_CUTOFF);
  const a = rc / (rc + 1 / sr);
  let py = 0;
  let px = src[0] || 0;
  dst[0] = 0;
  for (let i = 1; i < src.length; i++) {
    py = a * (py + src[i] - px);
    px = src[i];
    dst[i] = py;
  }
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
  const poly = createPolyPitch({ sampleRate: sr, fftSize: POLY_SIZE }); // polyphonic pluck detection
  const polyFFT = createMagFFT(POLY_SIZE); // own FFT (no Meyda window-size toggling)
  let strokeMidi = null; // smoothed pitch across frames (same glide logic as the mic)
  let strokeHue = 0; // held random color of the current note (set at note start)
  let vibRev = 0; // decaying pitch-reversal count -> vibrato detection (matches the mic)
  let vibSign = 0;
  const detector = PitchDetector.forFloat32Array(PITCH_SIZE);
  detector.minVolumeDecibels = -45;
  // Second detector on a high-passed copy: tracks the sung/lead MELODY line that
  // the main (bass-locking) detector misses in a full mix.
  const melodyDetector = PitchDetector.forFloat32Array(PITCH_SIZE);
  melodyDetector.minVolumeDecibels = -55;
  let melodyMidi = null; // smoothed melody pitch across frames
  const pitchChunk = new Float32Array(PITCH_SIZE); // trailing window for pitch
  const melodyChunk = new Float32Array(PITCH_SIZE); // high-passed copy for the melody line
  const polyChunk = new Float32Array(POLY_SIZE); // trailing window for poly detection
  const midiToNote = (m) => {
    const r = Math.round(m);
    return { pc: ((r % 12) + 12) % 12, octave: Math.floor(r / 12) - 1 };
  };

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

    // High-resolution spectrum for polyphonic pluck detection (finer bins than
    // the 1024 feature window), via our own FFT.
    const polyEnd = start + BUFFER_SIZE;
    const polyStart = polyEnd - POLY_SIZE;
    polyChunk.fill(0);
    const pfrom = Math.max(0, polyStart);
    polyChunk.set(signal.subarray(pfrom, polyEnd), pfrom - polyStart);
    const polySpec = polyFFT.mag(polyChunk);

    const tSec = start / sr;
    mode.update(frame.chroma, frame.rms);
    mode.evaluate();
    const on = onset.process(frame.flux, frame.rms, tSec * 1000);
    const r = tracker.process(frame, on);

    // Update the polyphonic background every frame; on a pluck it returns the
    // freshly sounded note(s) — used for chords and notes plucked over a ring.
    const plucked = poly.pluck(polySpec, on);

    // A clear single pitch (high mono clarity, in grid range): trust the MONO
    // detector. It is octave-robust and full-range, where the harmonic-sum poly
    // detector octave-slips on clean high/low notes (the piano run mapped wrong).
    const monoMidi = frame.pitchHz > 0 ? Math.round(midiOf(frame.pitchHz)) : null;
    const cleanSingle = monoMidi != null && frame.clarity >= 0.9 && monoMidi >= 24 && monoMidi <= 107;

    // MELODY/VOICE line, detected up front so drums can be deprioritized below it.
    // A second detector on a high-passed copy finds the strongest pitch ABOVE the
    // bass (the voice when singing, the lead/guitar in the gaps). Computing it here
    // lets the percussion branch stay silent whenever a vocal/lead is present.
    highpass(pitchChunk, melodyChunk, sr);
    const [mp, mc] = melodyDetector.findPitch(melodyChunk, sr);
    const melMidi = mp > 0 ? midiOf(mp) : null;
    const melodyOk = mc >= 0.78 && mp >= 160 && mp <= 2500 && melMidi != null && melMidi <= 107;

    if (on && (cleanSingle || plucked.length)) {
      // Clean single note -> the accurate mono pitch. Otherwise (a chord, an
      // overlap, a noisy moment) -> let the polyphonic detector name the few notes.
      let notes;
      if (cleanSingle) {
        notes = [{ ...midiToNote(monoMidi), energy: 1 }];
        strokeMidi = monoMidi;
      } else {
        notes = plucked.map((p) => ({ ...midiToNote(p.midi), energy: p.energy }));
        strokeMidi = midiOf(plucked[0].hz);
      }
      strokeHue = timeHue(tSec);
      events.push(chordEvent(tSec, notes, frame, mode.getVibrancy()));
    } else if (voiced(frame) && strokeMidi != null) {
      // Between plucks: sustain the last plucked note in place so its bloom grows.
      // Follow the mono pitch only when it stays CLOSE (a real slide/vibrato);
      // ignore far jumps, which are usually the loud bass stealing the detector.
      const m = midiOf(frame.pitchHz);
      let dir = false;
      let shimmer = false;
      if (Math.abs(m - strokeMidi) <= 2) {
        const dm = m - strokeMidi;
        const sign = dm > 0.02 ? 1 : dm < -0.02 ? -1 : 0;
        if (sign !== 0 && sign !== vibSign) {
          vibRev = Math.min(4, vibRev + 1);
          vibSign = sign;
        }
        shimmer = vibRev >= 2 && Math.abs(dm) < 0.7; // wobble in place = vibrato
        strokeMidi += dm * (shimmer ? 0.12 : 0.5); // vibrato holds center; else glide
        if (!shimmer && Math.abs(dm) > 0.04) dir = true;
      }
      vibRev *= 0.9;
      events.push(strokeEvent(tSec, strokeMidi, dir, strokeHue, false, shimmer, frame, mode.getVibrancy()));
    } else if (!voiced(frame)) {
      strokeMidi = null;
      // Drums are the LOWEST-priority layer. Only paint percussion when no
      // vocal/lead melody is sounding (melodyOk) AND the pitched branches above
      // didn't fire. This stops the kit from painting over the singing/instrument.
      if (!melodyOk && r && r.type === "perc") {
        const cls = classifyOnset(frame);
        if (cls.type === "percussive") events.push(percEvent(tSec, cls, frame, mode.getVibrancy()));
      }
    }

    // SECOND LINE — paint the melody/voice detected above, alongside the bass,
    // but only when it's a confident melodic pitch and a DIFFERENT note than the
    // bass line (no duplicate). This is the HIGHEST-priority layer: a vocal/lead
    // always paints, and (via melodyOk above) it suppresses the drums underneath.
    if (melodyOk) {
      if (melodyMidi == null || Math.abs(melMidi - melodyMidi) > 3) melodyMidi = melMidi; // new note / leap
      else melodyMidi += (melMidi - melodyMidi) * 0.5; // glide
      if (strokeMidi == null || Math.abs(melodyMidi - strokeMidi) > 1.5) {
        const ev = strokeEvent(tSec, melodyMidi, false, timeHue(tSec), false, false, frame, mode.getVibrancy());
        ev.melody = true; // tag for verification / possible future styling
        events.push(ev);
      }
    } else {
      melodyMidi = null;
    }
  }

  return { duration: audioBuffer.duration, events, env, envStep };
}
