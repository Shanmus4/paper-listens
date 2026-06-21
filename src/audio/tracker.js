// tracker.js — continuous, monophonic note tracking (the tuner approach).
//
// Both the live mic and the offline file analysis feed frames through this. It
// reads pitch every frame and reports a note the instant a clear, in-range pitch
// holds for a couple of frames — it never averages over the noisy attack, and it
// never invents a chord when the pitch is unusable (a garbage sub-bass reading
// just produces nothing, instead of the old wrong multi-note fallback).
//
// process(frame, onset) returns one of:
//   { type: "note", pc, octave }  a new note was confirmed
//   { type: "perc" }              a noisy attack with no pitch (caller may splat)
//   null                          nothing to paint this frame

import { freqToNote } from "./notes.js";

// Musical range we accept, C1..B7. Below C1 (~33Hz) is the sub-bass garbage the
// detector sometimes locks onto; above B7 (~3951Hz) is beyond our instruments.
// Covering B7 also stops a too-low ceiling from passing the detector's
// octave-down half-reading of a real 7th-octave note as a 6th-octave note.
const PITCH_LO = 31; // just below C1 (32.70Hz)
const PITCH_HI = 4050; // just above B7 (3951Hz)

export function createNoteTracker(opts = {}) {
  const voiceClarity = opts.voiceClarity != null ? opts.voiceClarity : 0.8;
  const confirmFrames = opts.confirmFrames != null ? opts.confirmFrames : 3;
  const silenceRms = opts.silenceRms != null ? opts.silenceRms : 0.004;
  const repluckMin = opts.repluckMin != null ? opts.repluckMin : 10; // frames before the same note can re-fire (~230ms)

  let heldMidi = -1; // pitch currently being held
  let heldFrames = 0; // how many consecutive frames it has held
  let emittedMidi = -1; // last note reported, so a sustain doesn't repeat it
  let sinceEmit = 1e9; // frames since the last note fired (re-pluck debounce)

  function reset() {
    heldMidi = -1;
    heldFrames = 0;
    emittedMidi = -1;
    sinceEmit = 1e9;
  }

  function process(f, onset) {
    sinceEmit++;
    // Silence resets, so the next note — even the same one — reports fresh.
    if ((f.rms || 0) < silenceRms) {
      reset();
      return null;
    }

    const voiced =
      (f.clarity || 0) >= voiceClarity && f.pitchHz >= PITCH_LO && f.pitchHz <= PITCH_HI;

    if (voiced) {
      const { pc, octave, midi } = freqToNote(f.pitchHz);
      if (midi === heldMidi) heldFrames++;
      else {
        heldMidi = midi;
        heldFrames = 1;
      }
      // A genuine re-pluck of the sustained note re-fires it, but only after a
      // short gap, so onset noise during one sustain can't machine-gun repeats.
      if (onset && midi === emittedMidi && sinceEmit >= repluckMin) emittedMidi = -1;
      if (heldFrames >= confirmFrames && midi !== emittedMidi) {
        emittedMidi = midi;
        sinceEmit = 0;
        return { type: "note", pc, octave };
      }
      return null;
    }

    // No clear, in-range pitch. Keep nothing held; a noisy attack may be drums.
    heldMidi = -1;
    heldFrames = 0;
    return onset ? { type: "perc" } : null;
  }

  return { process, reset };
}
