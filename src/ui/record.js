// record.js — records the painting (the canvas) to a video file.
//
// We capture the canvas stream rather than the whole screen, so the video is
// just the clean artwork forming, with no browser chrome and no screen-share
// prompt. Container is mp4 where the browser can mux it (Safari, newer Chrome),
// otherwise webm.

function pickMime() {
  const types = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const t of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export function createRecorder(canvas) {
  let recorder = null;
  let chunks = [];
  let mime = "";

  const supported = () =>
    typeof MediaRecorder !== "undefined" && typeof canvas.captureStream === "function";

  function start() {
    if (!supported() || recorder) return false;
    const stream = canvas.captureStream(30);
    mime = pickMime();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.start();
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
