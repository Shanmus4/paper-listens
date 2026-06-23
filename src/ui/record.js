// record.js — records the painting (the canvas) to a video file.
//
// We capture the canvas stream rather than the whole screen, so the video is
// just the clean artwork forming, with no browser chrome and no screen-share
// prompt. Container is mp4 where the browser can mux it (Safari, newer Chrome),
// otherwise webm.

function pickMime() {
  // Ordered best-quality-first. The previous list led with avc1.42E01E, which is
  // H.264 *baseline* profile — the lowest-quality H.264 variant — so that was the
  // single biggest cause of the soft, blocky output. We now prefer High/Main
  // profile H.264 (mp4, most shareable) and VP9 (webm) where the browser muxes
  // them, and only fall back to baseline mp4 / VP8 if nothing better is offered
  // (e.g. older Safari). isTypeSupported() filters out whatever the browser can't
  // actually record, so unsupported entries are skipped safely.
  const types = [
    "video/mp4;codecs=avc1.640028", // H.264 High profile
    "video/mp4;codecs=avc1.4d0028", // H.264 Main profile
    "video/webm;codecs=vp9",
    "video/mp4;codecs=avc1.42E01E", // H.264 Baseline (Safari often only does this)
    "video/mp4",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const t of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

// A high, resolution-scaled video bitrate. MediaRecorder's default is ~2.5 Mbps,
// which is far too low for a full-screen, gradient-heavy painting (it shows as
// smearing and blockiness). We reference 16 Mbps at 1080p and scale linearly with
// pixel count, clamped to a sane range so a tiny window isn't wasteful and a
// retina canvas can't ask for an absurd value the encoder would choke on (a
// starved encoder drops frames, which reads as the "hanging"/stutter).
function videoBitrate(canvas) {
  const px = Math.max(1, (canvas.width || 1) * (canvas.height || 1));
  const ref = 2_073_600; // 1920 x 1080
  const bps = (16_000_000 * px) / ref;
  return Math.round(Math.min(40_000_000, Math.max(8_000_000, bps)));
}

export function createRecorder(canvas) {
  let recorder = null;
  let chunks = [];
  let mime = "";

  const supported = () =>
    typeof MediaRecorder !== "undefined" && typeof canvas.captureStream === "function";

  // Records the canvas, plus the given audio stream (the song or the mic) so
  // the video has sound. Audio is optional; without it the video is silent.
  function start(audioStream) {
    if (!supported() || recorder) return false;
    const stream = canvas.captureStream(30);
    if (audioStream) {
      for (const track of audioStream.getAudioTracks()) stream.addTrack(track);
    }
    mime = pickMime();
    const opts = { videoBitsPerSecond: videoBitrate(canvas), audioBitsPerSecond: 192_000 };
    if (mime) opts.mimeType = mime;
    recorder = new MediaRecorder(stream, opts);
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    // Flush a chunk every second rather than buffering one huge blob until stop:
    // lighter on memory and avoids a stall (which reads as a freeze) at the end of
    // a long take. The chunks are still concatenated into one file in stop().
    recorder.start(1000);
    return true;
  }

  // Stops recording and resolves with the finished video. We hand back the
  // blob (instead of downloading immediately) so the caller can ask the user
  // for a name first, then call download().
  function stop() {
    return new Promise((resolve) => {
      if (!recorder) return resolve(null);
      recorder.onstop = () => {
        const type = mime || "video/webm";
        const ext = type.includes("mp4") ? "mp4" : "webm";
        const blob = new Blob(chunks, { type });
        recorder = null;
        resolve({ blob, ext });
      };
      recorder.stop();
    });
  }

  // Trigger a file download for a finished recording.
  function download(blob, ext, name = "paper-listens") {
    if (!blob) return;
    const safe = (name || "").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-") || "paper-listens";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const isActive = () => !!recorder && recorder.state === "recording";

  return { supported, start, stop, download, isActive };
}
