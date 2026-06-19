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
  onClear,
  onSave,
  onSensitivity,
  onRecordToggle,
  onTogglePlay,
  onGrid,
}) {
  const controlsToggle = document.getElementById("controlsToggle");
  const controlsPanel = document.getElementById("controlsPanel");
  const sensitivity = document.getElementById("sensitivity");

  const recordBtn = document.getElementById("recordBtn");
  const recordLabel = document.getElementById("recordLabel");
  const transport = document.getElementById("transport");
  const playPause = document.getElementById("playPause");
  const playIcon = playPause.querySelector(".transport-icon");

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

  playIcon.innerHTML = ICON_PAUSE;

  function setActiveSource(which) {
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
  srcFile.addEventListener("click", () => setActiveSource("file"));

  // --- Drop box ---
  function loadFile(file) {
    if (!file) return;
    setActiveSource("file");
    dropMain.textContent = `♪ ${file.name}`;
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
  sensitivity.addEventListener("input", () => {
    onSensitivity?.(Number(sensitivity.value) / 100);
  });

  // --- Grid overlay toggle ---
  gridToggle.addEventListener("change", () => onGrid?.(gridToggle.checked));

  // --- New Sheet ---
  clearBtn.addEventListener("click", () => onClear?.());

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

  return {
    setActiveSource,
    promptName,
    setRecording(on) {
      recordBtn.classList.toggle("recording", on);
      recordLabel.textContent = on ? "Stop" : "Record";
    },
    showTransport(on) {
      transport.hidden = !on;
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
