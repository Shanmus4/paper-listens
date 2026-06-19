// controls.js — wires the DOM chrome: Controls panel, source switching
// (microphone / upload drop box), sensitivity, New Sheet, and the Save modal.
// Audio/painting logic is injected via callbacks.

export function wireControls({
  onMic,
  onFile,
  onClear,
  onSave,
  onSensitivity,
  onRecordToggle,
  onTogglePlay,
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

  const clearBtn = document.getElementById("clearBtn");
  const saveBtn = document.getElementById("saveBtn");

  const saveModal = document.getElementById("saveModal");
  const saveBackdrop = document.getElementById("saveBackdrop");
  const saveName = document.getElementById("saveName");
  const saveConfirm = document.getElementById("saveConfirm");
  const saveCancel = document.getElementById("saveCancel");

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

  // --- New Sheet ---
  clearBtn.addEventListener("click", () => onClear?.());

  // --- Save modal ---
  function openSave() {
    saveName.value = "";
    saveModal.hidden = false;
    saveName.focus();
  }
  function closeSave() {
    saveModal.hidden = true;
  }
  function confirmSave() {
    closeSave();
    onSave?.(saveName.value.trim());
  }
  saveBtn.addEventListener("click", openSave);
  saveCancel.addEventListener("click", closeSave);
  saveBackdrop.addEventListener("click", closeSave);
  saveConfirm.addEventListener("click", confirmSave);
  saveName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmSave();
    if (e.key === "Escape") closeSave();
  });

  // --- Record + transport ---
  recordBtn.addEventListener("click", () => onRecordToggle?.());
  playPause.addEventListener("click", () => onTogglePlay?.());

  return {
    setActiveSource,
    setRecording(on) {
      recordBtn.classList.toggle("recording", on);
      recordLabel.textContent = on ? "Stop" : "Record";
    },
    showTransport(on) {
      transport.hidden = !on;
    },
    setPlaying(on) {
      playIcon.textContent = on ? "❚❚" : "▶";
    },
    hideRecord() {
      recordBtn.hidden = true;
    },
  };
}
