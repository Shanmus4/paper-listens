// source.js — acquires an audio input and an AudioContext.
//
// For now this is the microphone. File upload and Spotify will add their own
// factory functions here later, each returning the same shape:
//   { audioContext, sourceNode, stop() }
// so the rest of the app never cares where the sound came from.

// Music needs the *raw* signal. The browser's voice-call processing
// (echo cancellation, noise suppression, auto gain) mangles instruments and
// pumps the level, so we explicitly turn it all off.
const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
  video: false,
};

export async function createMicSource() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support microphone access.");
  }

  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx();

  // iOS/Safari start contexts in a "suspended" state until a user gesture.
  // We are called from the start-button click, so resume is allowed here.
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const sourceNode = audioContext.createMediaStreamSource(stream);

  function stop() {
    stream.getTracks().forEach((t) => t.stop());
    if (audioContext.state !== "closed") audioContext.close();
  }

  // Mic is live as soon as the stream opens; start() exists for a uniform API.
  return { audioContext, sourceNode, stream, start() {}, stop };
}

// Decode an uploaded audio file into a seekable player. Audio output only —
// the painting is driven separately from a pre-analyzed timeline (see
// offline.js + main.js), which is what lets us jump to any point instantly.
//
// AudioBufferSourceNodes can't be paused or seeked, so we recreate the node
// whenever we seek. Playback position is tracked from the AudioContext clock
// (which freezes on suspend), so pause/resume keep an accurate position.
export async function createFilePlayer(file, { onEnded } = {}) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx();
  if (audioContext.state === "suspended") await audioContext.resume();

  const arrayBuf = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuf);
  const duration = audioBuffer.duration;

  // A tap so recordings can include the song's audio. Each playback node is
  // connected to both the speakers and this destination.
  const streamDest = audioContext.createMediaStreamDestination();

  let node = null;
  let offset = 0; // buffer position (sec) at the moment `node` started
  let startCtxTime = 0; // audioContext.currentTime when `node` started

  const clamp = (t) => Math.max(0, Math.min(duration, t));

  // Position is derived entirely from the AudioContext clock (which freezes
  // while suspended), NOT from any event. `rawPos` may run past `duration`
  // once a node plays to its natural end (the clock keeps ticking after the
  // sound stops); position() clamps, and isEnded() uses that overshoot.
  function rawPos() {
    if (!node) return offset;
    return offset + (audioContext.currentTime - startCtxTime);
  }
  function position() {
    return clamp(rawPos());
  }
  function isEnded() {
    return rawPos() >= duration - 0.05;
  }

  function stopNode() {
    if (!node) return;
    const n = node;
    node = null; // mark "no current node" BEFORE stop()
    n.onended = null; // detach so a stopped node never calls back
    try {
      n.stop();
    } catch (_) {
      /* not started */
    }
    n.disconnect();
  }

  function startAt(t) {
    stopNode();
    offset = clamp(t);
    const n = audioContext.createBufferSource();
    node = n;
    n.buffer = audioBuffer;
    n.connect(audioContext.destination); // speakers
    n.connect(streamDest); // recording tap
    // The 'ended' event is used ONLY to notify the UI of a genuine end-of-song,
    // and even then it is double-checked against the clock. It deliberately does
    // NOT touch `node`, `offset`, or any position state: rapid seek/stop on the
    // Web Audio thread can fire a stray 'ended' for the wrong reason, and we must
    // never let that desync the position or strand a still-playing node.
    n.onended = () => {
      if (n !== node) return; // superseded by a seek/stop
      if (rawPos() >= duration - 0.05) onEnded?.();
    };
    startCtxTime = audioContext.currentTime;
    n.start(0, offset);
  }

  return {
    audioContext,
    audioBuffer,
    duration,
    audioStream: streamDest.stream,
    position,
    isEnded,
    isPlaying: () => !!node && audioContext.state === "running" && !isEnded(),
    start() {
      startAt(0);
    },
    async play() {
      // From the end, replay from the top; otherwise resume where we are.
      if (isEnded()) startAt(0);
      else if (!node) startAt(position());
      if (audioContext.state === "suspended") await audioContext.resume();
    },
    pause() {
      if (audioContext.state === "running") audioContext.suspend();
    },
    seek(t) {
      const wasPaused = audioContext.state !== "running";
      startAt(t);
      if (wasPaused) audioContext.suspend(); // stay paused at the new spot
    },
    stop() {
      stopNode();
      if (audioContext.state !== "closed") audioContext.close();
    },
  };
}
