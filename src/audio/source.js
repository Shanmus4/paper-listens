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

  let node = null;
  let offset = 0; // playback position (sec) at the moment `node` started
  let startCtxTime = 0; // audioContext.currentTime when `node` started
  let ended = false;

  const clamp = (t) => Math.max(0, Math.min(duration, t));

  function position() {
    if (!node) return offset;
    return clamp(offset + (audioContext.currentTime - startCtxTime));
  }

  function stopNode() {
    if (!node) return;
    node._intentional = true; // so its onended doesn't fire the song-ended cb
    try {
      node.stop();
    } catch (_) {
      /* not started */
    }
    node.disconnect();
    node = null;
  }

  function startAt(t) {
    stopNode();
    ended = false;
    offset = clamp(t);
    node = audioContext.createBufferSource();
    node.buffer = audioBuffer;
    node.connect(audioContext.destination);
    node.onended = () => {
      if (node && node._intentional) return; // we stopped it on purpose
      offset = duration;
      ended = true;
      node = null;
      onEnded?.();
    };
    startCtxTime = audioContext.currentTime;
    node.start(0, offset);
  }

  return {
    audioContext,
    audioBuffer,
    duration,
    position,
    isEnded: () => ended,
    start() {
      startAt(0);
    },
    async play() {
      if (ended || !node) startAt(position() >= duration ? 0 : position());
      if (audioContext.state === "suspended") await audioContext.resume();
    },
    pause() {
      if (audioContext.state === "running") audioContext.suspend();
    },
    seek(t) {
      const wasPaused = audioContext.state === "suspended";
      startAt(t);
      if (wasPaused) audioContext.suspend(); // stay paused at the new spot
    },
    stop() {
      stopNode();
      if (audioContext.state !== "closed") audioContext.close();
    },
  };
}
