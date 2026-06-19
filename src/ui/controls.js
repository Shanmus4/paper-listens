// controls.js — wires the DOM chrome: Controls panel, source switching
// (microphone / file), file picker, sensitivity, New Sheet, Save.
// Audio/painting logic is injected via callbacks.

export function wireControls({ onMic, onFile, onClear, onSave, onSensitivity }) {
  const controlsToggle = document.getElementById("controlsToggle");
  const controlsPanel = document.getElementById("controlsPanel");
  const sensitivity = document.getElementById("sensitivity");

  const srcMic = document.getElementById("srcMic");
  const srcFile = document.getElementById("srcFile");
  const fileInput = document.getElementById("fileInput");
  const fileRow = document.getElementById("fileRow");
  const fileName = document.getElementById("fileName");

  const clearBtn = document.getElementById("clearBtn");
  const saveBtn = document.getElementById("saveBtn");

  function setActiveSource(which) {
    srcMic.classList.toggle("seg--on", which === "mic");
    srcFile.classList.toggle("seg--on", which === "file");
    fileRow.hidden = which !== "file";
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
  srcFile.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    setActiveSource("file");
    fileName.textContent = file.name;
    onFile?.(file);
  });

  // --- Sensitivity ---
  sensitivity.addEventListener("input", () => {
    onSensitivity?.(Number(sensitivity.value) / 100);
  });

  // --- Actions ---
  clearBtn.addEventListener("click", () => onClear?.());
  saveBtn.addEventListener("click", () => onSave?.());

  return { setActiveSource };
}
