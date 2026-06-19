// controls.js — wires the DOM chrome: Controls panel, source switching
// (microphone / upload drop box), sensitivity, New Sheet, and the Save modal.
// Audio/painting logic is injected via callbacks.

// Soft, rounded transport icons in the UI's dark-brown ink tone. Rounded
// joins keep them from looking sharp against the paper aesthetic.
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
  '<rect x="7" y="6" width="3.6" height="12" rx="1.8" fill="currentColor"/>' +
  '<rect x="13.4" y="6" width="3.6" height="12" rx="1.8" fill="currentColor"/></svg>';
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
  '<path d="M9 6.4 L17.6 12 L9 17.6 Z" fill="currentColor" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';

export function wireControls({
  onMic,
  onFile,
  onUploadEnter,
  onClear,
  onSave,
  onSensitivity,
  onRecordToggle,
  onTogglePlay,
  onGrid,
  onSeek,
  onSeekCommit,
}) {
  const controlsToggle = document.getElementById("controlsToggle");
  const controlsPanel = document.getElementById("controlsPanel");
  const sensitivity = document.getElementById("sensitivity");

  const recordBtn = document.getElementById("recordBtn");
  const recordLabel = document.getElementById("recordLabel");
  const transport = document.getElementById("transport");
  const playPause = document.getElementById("playPause");
  const playIcon = playPause.querySelector(".transport-icon");
  const seek = document.getElementById("seek");
  const seekTime = document.getElementById("seekTime");
  let seekScrubbing = false;

  const fmtTime = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  };

  // Paint a slider's filled portion (sepia up to the value) via a CSS variable,
  // so the track reads as a progress line with no separate handle dot.
  const setFill = (el) => {
    const min = Number(el.min || 0);
    const max = Number(el.max || 100);
    const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
    el.style.setProperty("--pct", pct + "%");
  };

  const srcMic = document.getElementById("srcMic");
  const srcFile = document.getElementById("srcFile");
  const dropZone = document.getElementById("dropZone");
  const dropMain = dropZone.querySelector(".dropzone-main");
  const fileInput = document.getElementById("fileInput");

  const gridToggle = document.getElementById("gridToggle");

  const clearBtn = document.getElementById("clearBtn");
  const saveBtn = document.getElementById("saveBtn");

  const saveModal = document.getElementById("saveModal");
  const saveBackdrop = document.getElementById("saveBackdrop");
  const saveName = document.getElementById("saveName");
  const saveConfirm = document.getElementById("saveConfirm");
  const saveCancel = document.getElementById("saveCancel");
  const saveTitle = document.getElementById("saveTitle");
  const saveSub = document.getElementById("saveSub");
  const nameCaret = document.getElementById("nameCaret");

  playIcon.innerHTML = ICON_PAUSE;

  let lastFile = null; // the most recently loaded song, for re-entering Upload
  let currentActive = "mic";

  function setActiveSource(which) {
    currentActive = which;
    srcMic.classList.toggle("seg--on", which === "mic");
    srcFile.classList.toggle("seg--on", which === "file");
    dropZone.hidden = which !== "file";
  }

  // --- Controls panel toggle ---
  controlsToggle.addEventListener("click", () => {
    const open = controlsPanel.hidden;
    controlsPanel.hidden = !open;
    controlsToggle.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (controlsPanel.hidden) return;
    if (!controlsPanel.contains(e.target) && e.target !== controlsToggle) {
      controlsPanel.hidden = true;
      controlsToggle.setAttribute("aria-expanded", "false");
    }
  });

  // --- Source switching ---
  srcMic.addEventListener("click", () => {
    setActiveSource("mic");
    onMic?.();
  });
  srcFile.addEventListener("click", () => {
    const wasFile = currentActive === "file";
    setActiveSource("file");
    // Entering Upload starts fresh: reset the drop box and clear any prior
    // song state. We do not auto-replay the last file — the user picks one.
    if (!wasFile) {
      lastFile = null;
      dropMain.textContent = "Drop a file here, or browse";
      onUploadEnter?.();
    }
  });

  // --- Drop box ---
  function loadFile(file) {
    if (!file) return;
    lastFile = file;
    setActiveSource("file");
    dropMain.textContent = `Reading ${file.name}…`;
    onFile?.(file);
  }
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => loadFile(fileInput.files?.[0]));

  ["dragenter", "dragover"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add("drag");
    })
  );
  ["dragleave", "dragend"].forEach((ev) =>
    dropZone.addEventListener(ev, () => dropZone.classList.remove("drag"))
  );
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag");
    loadFile(e.dataTransfer?.files?.[0]);
  });
  // Stop the browser from navigating away if a file is dropped off-target.
  ["dragover", "drop"].forEach((ev) =>
    window.addEventListener(ev, (e) => e.preventDefault())
  );

  // --- Sensitivity ---
  setFill(sensitivity);
  sensitivity.addEventListener("input", () => {
    setFill(sensitivity);
    onSensitivity?.(Number(sensitivity.value) / 100);
  });

  // --- Grid overlay toggle ---
  gridToggle.addEventListener("change", () => onGrid?.(gridToggle.checked));

  // --- New Sheet ---
  clearBtn.addEventListener("click", () => onClear?.());

  // --- Custom caret for the name field (slow, soft blink) ---
  // We hide the native caret (CSS) and place a thin bar at the end of the typed
  // text, measured with a canvas using the input's own font.
  let caretCtx = null;
  function textWidth(text) {
    if (!caretCtx) caretCtx = document.createElement("canvas").getContext("2d");
    const cs = getComputedStyle(saveName);
    caretCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return caretCtx.measureText(text).width;
  }
  function positionCaret() {
    const cs = getComputedStyle(saveName);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const maxX = saveName.clientWidth - padL - 2;
    const x = Math.min(textWidth(saveName.value || ""), Math.max(0, maxX));
    nameCaret.style.left = saveName.offsetLeft + padL + x + "px";
    nameCaret.style.top =
      saveName.offsetTop + (saveName.offsetHeight - nameCaret.offsetHeight) / 2 + "px";
  }
  function showCaret(on) {
    nameCaret.style.display = on ? "block" : "none";
    if (on) positionCaret();
  }
  function bumpCaret() {
    // Keep the caret solid right after a keystroke, then resume blinking.
    nameCaret.style.animation = "none";
    void nameCaret.offsetWidth; // force reflow so the animation restarts
    nameCaret.style.animation = "";
    positionCaret();
  }
  saveName.addEventListener("input", bumpCaret);
  saveName.addEventListener("focus", () => showCaret(true));
  saveName.addEventListener("blur", () => showCaret(false));
  ["click", "keyup", "select"].forEach((ev) =>
    saveName.addEventListener(ev, positionCaret)
  );

  // --- Name modal (shared by Save image and Save recording) ---
  // Resolves with the trimmed name, or null if the user cancels.
  let resolveModal = null;
  function promptName({ title, sub, confirmLabel }) {
    saveTitle.textContent = title;
    saveSub.textContent = sub;
    saveConfirm.textContent = confirmLabel;
    saveName.value = "";
    saveModal.hidden = false;
    saveName.focus();
    return new Promise((resolve) => {
      resolveModal = resolve;
    });
  }
  function closeModal(result) {
    if (saveModal.hidden) return;
    showCaret(false);
    saveModal.hidden = true;
    const done = resolveModal;
    resolveModal = null;
    done?.(result);
  }
  saveCancel.addEventListener("click", () => closeModal(null));
  saveBackdrop.addEventListener("click", () => closeModal(null));
  saveConfirm.addEventListener("click", () => closeModal(saveName.value.trim()));
  saveName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") closeModal(saveName.value.trim());
    if (e.key === "Escape") closeModal(null);
  });

  saveBtn.addEventListener("click", async () => {
    const name = await promptName({
      title: "Name your piece",
      sub: "It will be signed in the corner of your painting. Leave blank to skip.",
      confirmLabel: "Save image",
    });
    if (name !== null) onSave?.(name);
  });

  // --- Record + transport (independent of each other) ---
  recordBtn.addEventListener("click", () => onRecordToggle?.());
  playPause.addEventListener("click", () => onTogglePlay?.());

  // --- Seek bar ---
  // While dragging we only preview (paint to the target); the audio jumps once,
  // on release. `commitSeek` is fired from several events so the scrub state can
  // never get stuck (touch devices don't always fire `change`).
  function commitSeek() {
    if (!seekScrubbing) return;
    seekScrubbing = false;
    onSeekCommit?.(Number(seek.value));
  }
  seek.addEventListener("input", () => {
    seekScrubbing = true;
    const t = Number(seek.value);
    seekTime.textContent = fmtTime(t);
    setFill(seek);
    onSeek?.(t);
  });
  seek.addEventListener("change", commitSeek); // keyboard + mouse
  seek.addEventListener("pointerup", commitSeek); // reliable touch/mouse release
  seek.addEventListener("pointercancel", commitSeek);
  seek.addEventListener("lostpointercapture", commitSeek);

  return {
    setActiveSource,
    promptName,
    setLoaded() {
      dropMain.textContent = lastFile ? `♪ ${lastFile.name}` : "Drop a file here, or browse";
    },
    setRecording(on) {
      recordBtn.classList.toggle("recording", on);
      recordLabel.textContent = on ? "Stop" : "Record";
    },
    showTransport(on) {
      transport.hidden = !on;
    },
    setSeekDuration(seconds) {
      seek.max = String(seconds || 0);
      seek.value = "0";
      seekTime.textContent = fmtTime(0);
      setFill(seek);
    },
    setSeekValue(seconds) {
      if (seekScrubbing) return; // don't fight the user's drag
      seek.value = String(seconds);
      seekTime.textContent = fmtTime(seconds);
      setFill(seek);
    },
    setPlaying(on) {
      // While playing, the button offers Pause; while paused, it offers Play.
      playIcon.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    },
    hideRecord() {
      recordBtn.hidden = true;
    },
  };
}
