// main.js — entry point. Boots the canvas, auto-starts listening, owns the
// audio pipeline, and runs the render loop that turns onsets into ink.

import { createRenderer } from "./visual/renderer.js";
import { wireControls } from "./ui/controls.js";
import { createLevelMeter } from "./ui/level.js";
import { createMicSource, createFilePlayer } from "./audio/source.js";
import { createAnalyzer } from "./audio/features.js";
import { analyzeBuffer } from "./audio/offline.js";
import { createOnsetDetector } from "./audio/onset.js";
import { createModeTracker } from "./audio/mode.js";
import { mapPitched, mapPercussive, strokeSpec, timeHue, PITCH_NAMES } from "./visual/synesthesia.js";
import { freqToNote } from "./audio/notes.js";
import { makeVoicedGate } from "./audio/tracker.js";
import { createPolyPitch } from "./audio/polypitch.js";
import { seededRng } from "./visual/rng.js";
import { createRecorder } from "./ui/record.js";

const paperEl = document.getElementById("paper");
const overlayEl = document.getElementById("overlay");
// One facade over either the WebGL ink renderer or the Canvas 2D fallback.
const renderer = createRenderer(paperEl, overlayEl);
const levelMeter = createLevelMeter(document.getElementById("level"));
const headline = document.getElementById("headline");
const micHint = document.getElementById("micHint");

const recorder = createRecorder(paperEl);

const DEBUG = location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Live readout: a small panel showing what the analyzer hears each frame — the
// raw pitch, clarity, loudness, brightness and noisiness, plus what was last
// painted and whether the engine read a chord or a single note. It makes the
// gates and the chord/note decision visible so you can see exactly why the app
// painted what it did. Toggled from Controls ("Show live readout"); off by
// default (the toggle is the source of truth and sets this on load).
let hudEl = null;
let hudVisible = false;
let lastPaintedLabel = "-";
let lastDecision = "-"; // "chord A C E" or "single E2" — set wherever we paint

// Top pitch classes in the chroma (the notes the chord test actually sees).
function topChroma(chroma, n = 4) {
  if (!chroma || !chroma.length) return "--";
  let max = 0;
  for (const v of chroma) if (v > max) max = v;
  if (max <= 0) return "--";
  return chroma
    .map((v, pc) => ({ pc, v: v / max }))
    .filter((c) => c.v >= 0.5)
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((c) => PITCH_NAMES[c.pc])
    .join(" ");
}

function setHudVisible(on) {
  hudVisible = on;
  if (hudEl) hudEl.style.display = on ? "block" : "none";
}

function updateHud(f) {
  if (!hudVisible) return;
  if (!hudEl) {
    hudEl = document.createElement("div");
    hudEl.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:9;font:12px ui-monospace,monospace;" +
      "background:rgba(0,0,0,.72);color:#fff;padding:9px 12px;border-radius:8px;" +
      "white-space:pre;pointer-events:none;line-height:1.5";
    document.body.appendChild(hudEl);
  }
  const hz = f.pitchHz || 0;
  const inRange = hz >= 40 && hz <= 2500;
  let note = "--";
  if (inRange) {
    const n = freqToNote(hz);
    note = `${PITCH_NAMES[n.pc]}${n.octave}`;
  }
  hudEl.textContent =
    `loudness ${(f.rms || 0).toFixed(4)}   clarity ${(f.clarity || 0).toFixed(2)}\n` +
    `pitch    ${String(Math.round(hz)).padStart(4)}Hz (${note})\n` +
    `bright   ${Math.round(f.centroidHz || 0)}Hz   noisy ${(f.flatness || 0).toFixed(2)}\n` +
    `chroma   ${topChroma(f.chroma)}\n` +
    `read as  ${lastDecision}\n` +
    `painted  ${lastPaintedLabel}`;
}

// Keep the paint surface and the grid overlay sized to the window.
window.addEventListener("resize", () => renderer.resize());

// Onset sensitivity is fixed at the value that tested best. There's no user
// slider: note detection is gated by the tracker's clarity/range logic, not by
// this — the onset detector only triggers re-pluck timing and drum splats, so a
// single well-chosen value serves every input.
const ONSET_SENSITIVITY = 0.5;

// Audio state. onsetDetector/modeTracker are recreated when the source changes.
let onsetDetector = createOnsetDetector({ sensitivity: ONSET_SENSITIVITY });
let modeTracker = createModeTracker();
let source = null;
let analyzer = null;
let firstPaint = false;
let currentSource = null; // "mic" | "file"
let ui = null; // controls API, set after wiring
let userPaused = false; // true only when the user hit pause on purpose
let gridVisible = true; // overlay that reveals the note map (on by default)

// File playback timeline (set when a song is loaded).
let player = null;
let events = []; // [{ t, type, cls, frame, vibrancy, seed }] sorted by time
let evtPtr = 0; // next event to paint
let renderedT = 0; // the song time the painting currently reflects (sec)
let scrubbing = false; // true while the user drags the seek bar
let scrubTargetT = 0; // latest scrub position, repainted at most once per frame
let micSimT = 0; // mic mode has no timeline, so we drive the fluid by wall time
let lastFrameMs = performance.now();
let fileEnv = null; // loudness envelope of the loaded song (drives the meter)
let fileEnvStep = 1; // seconds between envelope samples
// Bumped on every teardown. A file load (which is async) captures the token at
// its start and bails if it changes, so a load that's superseded by a new
// upload or a source switch can never start a second, orphaned audio node.
let loadToken = 0;

// Loudness of the song at time `t`, sampled from the precomputed envelope.
function levelAt(t) {
  if (!fileEnv || !fileEnv.length) return 0;
  const i = Math.min(fileEnv.length - 1, Math.max(0, Math.floor(t / fileEnvStep)));
  return fileEnv[i];
}

// ---- Render loop ----
function frame() {
  const now = performance.now();
  // Drive file playback. The fluid sim is path-dependent, so we don't rebuild it
  // every frame while scrubbing (that would re-simulate from the start on each
  // drag event); we just move the meter and rebuild once on release.
  if (player && currentSource === "file") {
    if (scrubbing) {
      levelMeter.push(levelAt(scrubTargetT));
    } else {
      const pos = player.position();
      paintToTime(pos, false, now); // advances the fluid sim and injects notes
      ui?.setSeekValue(pos);
      // Feed the meter from the song so it moves during playback, not just mic.
      levelMeter.push(player.isPlaying() ? levelAt(pos) : 0);
    }
  } else if (currentSource === "mic") {
    // No timeline in mic mode: advance the fluid by real elapsed time.
    micSimT += Math.min(0.05, (now - lastFrameMs) / 1000);
    renderer.stepTo(micSimT);
  }
  lastFrameMs = now;

  renderer.render(now);
  renderer.renderGrid(gridVisible);
  levelMeter.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Timeline painting (file playback + seeking) ----
// Paint one analyzed event, either animated (live playback) or baked instantly
// (rebuilding the painting at a seek position).
function paintEvent(ev, nowMs, instant) {
  const dims = renderer.dims();
  const rng = seededRng(ev.seed);
  if (ev.type === "stroke") {
    // One continuous-stroke puff at a fractional pitch (sustain/slide path).
    if (!instant) {
      const midi = Math.round(ev.midi);
      lastPaintedLabel = `${PITCH_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
      lastDecision = `single ${lastPaintedLabel}`;
      updateHud(ev.frame);
    }
    const spec = strokeSpec(ev.midi, ev.frame, dims, ev.vibrancy, ev.hue, !!ev.dir, !!ev.shimmer);
    spec.restrike = !!ev.restrike;
    if (instant) renderer.bake(spec);
    else renderer.addBlot(spec, nowMs);
  } else if (ev.type === "pitched") {
    // Drive the live readout during playback too (skip seek rebuilds so it
    // doesn't flicker through every event at once).
    if (!instant) {
      const ns = ev.cls.notes || [];
      lastPaintedLabel = ns.map((n) => `${PITCH_NAMES[n.pc]}${n.octave}`).join(" ");
      lastDecision = `chord ${lastPaintedLabel}`;
      updateHud(ev.frame);
    }
    for (const blot of mapPitched(ev.cls, ev.frame, ev.vibrancy, dims, ev.hue, rng)) {
      if (instant) renderer.bake(blot);
      else renderer.addBlot(blot, nowMs);
    }
  } else {
    const splat = mapPercussive(ev.cls, ev.frame, dims, rng);
    if (instant) renderer.bakeSplat(splat);
    else renderer.addSplat(splat, nowMs);
  }
}

// Make the painting reflect song time `t`. Moving forward paints only the new
// events; moving backward clears and replays from the start (ink can't be
// un-painted). `instant` bakes without the wet animation (used while seeking).
function paintToTime(t, instant, nowMs = performance.now()) {
  if (t < renderedT) {
    clearCanvas();
    evtPtr = 0;
  }
  let painted = false;
  while (evtPtr < events.length && events[evtPtr].t <= t) {
    renderer.stepTo(events[evtPtr].t); // evolve the fluid up to this note's time
    paintEvent(events[evtPtr], nowMs, instant);
    evtPtr++;
    painted = true;
  }
  renderer.stepTo(t); // finish evolving to the requested moment
  renderedT = t;
  if (painted) fadeHeadline();
}

// ---- Live mic: continuous, tuner-style note tracking ----
// Frames flow through the shared note tracker (audio/tracker.js), the same one
// the offline file analysis uses, so mic and upload behave identically. The
// tracker reads pitch every frame and reports a note the instant a clear pitch
// stabilizes — it never averages the noisy attack and never invents a chord.
// Mic is noisier and quieter than a decoded file, so it gets more forgiving
// floors. The clarity gate scales with pitch: low notes through a mic read
// ~0.5 (measured F#1 = 0.53), so the low end is lenient (0.45); high notes must
// be crisp (0.88) so high-frequency noise and harmonic mis-locks (e.g. F#6 at
// clarity 0.46) are rejected. Confirm-frames still require a stable pitch.
const micVoiced = makeVoicedGate({ silenceRms: 0.0012, clarityLo: 0.35, clarityHi: 0.8 });
let liveMidi = null; // smoothed live pitch (fractional MIDI), null when silent
let liveHue = 0; // time-derived color (0..360) held for the current note
let micPoly = null; // polyphonic pluck detector (built lazily once we know the rate)
let vibReversals = 0; // decaying count of pitch-direction flips -> detects vibrato
let vibLastSign = 0;

const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
const midiToNote = (m) => {
  const r = Math.round(m);
  return { pc: ((r % 12) + 12) % 12, octave: Math.floor(r / 12) - 1 };
};

function onAudioFrame(f) {
  levelMeter.push(f.rms);
  modeTracker.update(f.chroma, f.rms);
  modeTracker.evaluate();
  updateHud(f); // raw readout every frame, even when nothing paints

  const now = performance.now();
  const onset = onsetDetector.process(f.flux, f.rms, now);

  // Build the polyphonic detector once we know the sample rate / spectrum size.
  if (!micPoly && f.spectrumHi) {
    micPoly = createPolyPitch({ sampleRate: f.sampleRate, fftSize: f.spectrumHi.length * 2 });
  }
  // Polyphonic detector: the few notes newly sounded on a pluck (chords, and a
  // note plucked over a ringing one). Used unless the pitch is a clear single one.
  const plucked = micPoly && f.spectrumHi ? micPoly.pluck(f.spectrumHi, onset) : [];
  if (onset) {
    // A clear single pitch -> trust the accurate, octave-robust mono detector
    // (same routing as the file path). Otherwise -> the polyphonic detector.
    const monoMidi = f.pitchHz > 0 ? Math.round(midiOf(f.pitchHz)) : null;
    const cleanSingle = monoMidi != null && f.clarity >= 0.9 && monoMidi >= 24 && monoMidi <= 107;
    if (cleanSingle || plucked.length) {
      const notes = cleanSingle
        ? [{ ...midiToNote(monoMidi), energy: 1 }]
        : plucked.map((p) => ({ ...midiToNote(p.midi), energy: p.energy }));
      liveMidi = cleanSingle ? monoMidi : midiOf(plucked[0].hz);
      liveHue = timeHue(micSimT);
      paintNotes(notes, f, now);
      return;
    }
  }

  paintLive(f, now);
}

// Continuous painting between plucks: every voiced frame lays a small puff at the
// note we're sustaining so its bloom GROWS in place. The pluck detector above
// chooses notes; here we just hold the latest one (and follow gentle slides),
// rather than chasing the mono pitch, which on guitar keeps snapping to the bass.
function paintLive(f, now) {
  if (!micVoiced(f)) {
    liveMidi = null;
    return;
  }
  const m = midiOf(f.pitchHz);
  let dir = false; // becomes true when the pitch is moving (a slide -> thicker trail)
  let fresh = false; // true only on the first frame of a new note
  let shimmer = false; // true when the pitch is wobbling in place (vibrato)
  if (liveMidi == null) {
    // A voiced tone with no detected pluck (e.g. a bowed/sustained note): start
    // it from the mono pitch.
    liveMidi = m;
    liveHue = timeHue(micSimT);
    fresh = true;
  } else if (Math.abs(m - liveMidi) <= 2) {
    // Stay on the plucked note; follow the mono pitch only when it's CLOSE (a
    // real slide/vibrato). A far jump is usually the loud bass stealing the
    // detector — ignore it and hold the note we're sustaining.
    const dm = m - liveMidi;
    const sign = dm > 0.02 ? 1 : dm < -0.02 ? -1 : 0;
    if (sign !== 0 && sign !== vibLastSign) {
      vibReversals = Math.min(4, vibReversals + 1); // the pitch turned around
      vibLastSign = sign;
    }
    // Several small back-and-forth turns = vibrato: hold the center and shimmer
    // in place instead of smearing sideways. A steady move is a slide (glide).
    shimmer = vibReversals >= 2 && Math.abs(dm) < 0.7;
    liveMidi += dm * (shimmer ? 0.12 : 0.5);
    if (!shimmer && Math.abs(dm) > 0.04) dir = true;
  }
  vibReversals *= 0.9; // forget old turns so a brief wobble doesn't latch vibrato on
  const spec = strokeSpec(liveMidi, f, renderer.dims(), modeTracker.getVibrancy(), liveHue, dir, shimmer);
  spec.restrike = fresh; // sustain frames accumulate; the pluck path did the struck mark
  const n = freqToNote(f.pitchHz);
  lastPaintedLabel = `${PITCH_NAMES[n.pc]}${n.octave}`;
  lastDecision = `single ${lastPaintedLabel}`;
  renderer.addBlot(spec, now);
  fadeHeadline();
}

// Paint one or more notes (a single tracked note, or every tone of a chord).
function paintNotes(notes, frame, now) {
  const cls = { type: "pitched", notes, centroidHz: frame.centroidHz };
  lastPaintedLabel = notes.map((n) => `${PITCH_NAMES[n.pc]}${n.octave}`).join(" ");
  lastDecision = `${notes.length > 1 ? "chord" : "pluck"} ${lastPaintedLabel}`;
  if (DEBUG) console.log(`[paint] ${lastPaintedLabel}`, Math.round(frame.pitchHz) + "Hz");
  const dims = renderer.dims();
  for (const blot of mapPitched(cls, frame, modeTracker.getVibrancy(), dims, timeHue(micSimT))) {
    renderer.addBlot(blot, now);
  }
  fadeHeadline();
}

function fadeHeadline() {
  if (firstPaint) return;
  firstPaint = true;
  headline.classList.add("faded");
}

// ---- Source management ----
function clearCanvas() {
  renderer.clear();
  micSimT = 0; // reset the mic sim clock to match the reset fluid field
  resetTracker();
  firstPaint = false;
  headline.classList.remove("faded");
}

function teardownSource() {
  loadToken++; // invalidate any file load still in flight
  analyzer?.stop();
  source?.stop();
  // Stop a file player even if it hasn't been promoted to `source` yet (i.e. a
  // load that was interrupted mid-decode), so its audio node never lingers.
  if (player && player !== source) player.stop();
  analyzer = null;
  source = null;
  player = null;
  micPoly = null; // rebuilt for the next source (sample rate may differ)
  events = [];
  fileEnv = null;
  evtPtr = 0;
  renderedT = 0;
  scrubbing = false;
  renderer.purge();
  resetTracker();
  onsetDetector = createOnsetDetector({ sensitivity: ONSET_SENSITIVITY });
  modeTracker = createModeTracker();
}

// Reset the live painter state (new source / fresh sheet).
function resetTracker() {
  liveMidi = null;
  micPoly?.reset(); // forget the ringing-background spectrum
}

async function startMic() {
  const changed = currentSource !== "mic";
  teardownSource();
  userPaused = false;
  try {
    source = await createMicSource();
    analyzer = createAnalyzer(source, onAudioFrame);
    analyzer.start();
    source.start();
    micHint.hidden = true;
    currentSource = "mic";
    ui?.showTransport(false);
    ui?.showProcessing(false);
    if (changed) clearCanvas(); // switching mode starts a fresh sheet
  } catch (err) {
    console.error("[paper-listens] mic failed:", err);
    micHint.hidden = false;
  }
}

async function startFile(file) {
  teardownSource(); // bumps loadToken
  const token = loadToken; // this load's generation
  userPaused = false;
  ui?.showTransport(false);
  ui?.showProcessing(true); // tell the user we're reading the song
  try {
    const p = await createFilePlayer(file, {
      onEnded: () => {
        if (player === p) ui?.setPlaying(false);
      },
    });
    // Superseded while decoding (new upload, or switched to mic): drop it.
    if (token !== loadToken) {
      p.stop();
      return;
    }
    // Promote now so a later teardown can stop this node if it interrupts us.
    player = p;
    source = p;
    // Let the processing pill paint before the (blocking) analysis pass.
    await new Promise((r) => setTimeout(r, 16));
    if (token !== loadToken) {
      p.stop();
      return;
    }
    const result = analyzeBuffer(p.audioBuffer, { sensitivity: ONSET_SENSITIVITY });
    if (token !== loadToken) {
      p.stop();
      return;
    }
    events = result.events;
    fileEnv = result.env;
    fileEnvStep = result.envStep;
    evtPtr = 0;
    renderedT = 0;

    currentSource = "file";
    micHint.hidden = true;
    clearCanvas(); // a new file always starts a fresh sheet
    ui?.showProcessing(false);
    ui?.setLoaded();
    ui?.showTransport(true);
    ui?.setSeekDuration(result.duration);
    ui?.setSeekValue(0);
    p.start();
    ui?.setPlaying(true);
  } catch (err) {
    if (token !== loadToken) return; // a newer action already moved on
    console.error("[paper-listens] file failed:", err);
    ui?.showProcessing(false);
    micHint.hidden = false;
    micHint.textContent = "Could not read that audio file. Try another one.";
  }
}

// Jump playback + painting to song time `t` (seconds).
function seekTo(t) {
  if (currentSource !== "file" || !player) return;
  player.seek(t);
  paintToTime(t, true);
  ui?.setSeekValue(t);
  ui?.setPlaying(player.isPlaying()); // seeking off the end resumes play
}

// The audio currently being heard, so a recording can include sound (the
// uploaded song, or the live mic). Null if there's nothing to capture.
function currentAudioStream() {
  if (currentSource === "file") return player?.audioStream || null;
  if (currentSource === "mic") return source?.stream || null;
  return null;
}

// ---- Wire UI ----
ui = wireControls({
  onMic: startMic,
  onFile: startFile,
  // Entering Upload fresh (e.g. coming back from the mic): tear down any prior
  // playback and hide the transport. We do NOT auto-replay the last song — the
  // user chooses a file again. The canvas art is left untouched.
  onUploadEnter: () => {
    teardownSource();
    currentSource = null;
    ui?.showTransport(false);
    ui?.showProcessing(false);
    ui?.setPlaying(false);
  },
  onClear: clearCanvas,
  onSave: (name) => renderer.save(name),
  onGrid: (on) => {
    gridVisible = on;
  },
  onLiveView: (on) => setHudVisible(on),
  // Dragging the seek bar: just record the target. The render loop repaints to
  // it once per frame, so rapid drag events don't pile up expensive rebuilds.
  // Audio waits for release so scrubbing doesn't machine-gun it with restarts.
  onSeek: (t) => {
    scrubbing = true;
    scrubTargetT = t;
  },
  // Released the seek bar: jump the audio to match and resume normal playback.
  onSeekCommit: (t) => {
    scrubbing = false;
    if (player) {
      player.seek(t);
      ui?.setPlaying(player.isPlaying()); // seeking off the end resumes play
    }
    paintToTime(t, true);
  },
  onRecordToggle: async () => {
    // Recording is fully independent of playback: it only starts/stops the
    // canvas capture and never touches the audio transport.
    if (recorder.isActive()) {
      ui.setRecording(false);
      const result = await recorder.stop();
      if (!result) return;
      const name = await ui.promptName({
        title: "Name your recording",
        sub: "It will be saved as a video to your device. Leave blank to skip.",
        confirmLabel: "Save video",
      });
      if (name === null) return; // cancelled: discard, don't save
      recorder.download(result.blob, result.ext, name || "paper-listens");
    } else if (recorder.start(currentAudioStream())) {
      ui.setRecording(true);
    }
  },
  onTogglePlay: async () => {
    if (currentSource !== "file" || !player) return;
    if (player.isEnded()) {
      // Finished: a tap replays from the start.
      seekTo(0);
      userPaused = false;
      await player.play();
      ui.setPlaying(true);
    } else if (player.audioContext.state === "running") {
      player.pause();
      userPaused = true;
      ui.setPlaying(false);
    } else {
      userPaused = false;
      await player.play();
      ui.setPlaying(true);
    }
  },
});
if (!recorder.supported()) ui.hideRecord();

// iOS/Safari start audio contexts suspended until a user gesture. Resume on
// the first gesture, but never override an intentional pause (otherwise tapping
// Save or Record would secretly restart paused playback).
function resumeOnGesture() {
  if (userPaused) return;
  if (source?.audioContext?.state === "suspended") source.audioContext.resume();
}
document.addEventListener("pointerdown", resumeOnGesture, { once: false });

// Jump straight in: start listening on load (browser shows its mic prompt).
startMic();

// Dev hook for local testing without a mic.
if (DEBUG) {
  window.__pl = {
    feed: onAudioFrame,
    renderer,
    startFile,
    seekTo,
    getEvents: () => events,
    getPlayer: () => player,
    getDecision: () => lastDecision,
  };
}
