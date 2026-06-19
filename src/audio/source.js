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

// Decode an uploaded audio file and play it through the same analysis graph,
// so it paints as it plays. Same shape as the mic source.
export async function createFileSource(file, { onEnded } = {}) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx();
  if (audioContext.state === "suspended") await audioContext.resume();

  const arrayBuf = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuf);

  const sourceNode = audioContext.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioContext.destination); // so the user hears it
  sourceNode.onended = () => onEnded?.();

  let started = false;
  function start() {
    if (!started) {
      sourceNode.start();
      started = true;
    }
  }
  function stop() {
    try {
      sourceNode.stop();
    } catch (_) {
      /* not started */
    }
    sourceNode.disconnect();
    if (audioContext.state !== "closed") audioContext.close();
  }

  return { audioContext, sourceNode, start, stop };
}
