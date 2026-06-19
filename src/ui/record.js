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

  // Stops and triggers a download. Returns the file extension used.
  function stop(name = "paper-listens") {
    return new Promise((resolve) => {
      if (!recorder) return resolve(null);
      recorder.onstop = () => {
        const type = mime || "video/webm";
        const ext = type.includes("mp4") ? "mp4" : "webm";
        const blob = new Blob(chunks, { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
        recorder = null;
        resolve(ext);
      };
      recorder.stop();
    });
  }

  const isActive = () => !!recorder && recorder.state === "recording";

  return { supported, start, stop, isActive };
}
