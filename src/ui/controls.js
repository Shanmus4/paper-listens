// controls.js — wires up the DOM chrome: gate transition, controls panel,
// and the action bar. Audio/painting logic is injected via callbacks so this
// module stays purely about the interface.

export function wireControls({ onStart, onBack, onClear, onSave, onSensitivity }) {
  const gate = document.getElementById("gate");
  const stage = document.getElementById("stage");
  const startBtn = document.getElementById("startBtn");
  const gateHint = document.getElementById("gateHint");

  const controlsToggle = document.getElementById("controlsToggle");
  const controlsPanel = document.getElementById("controlsPanel");
  const sensitivity = document.getElementById("sensitivity");

  const backBtn = document.getElementById("backBtn");
  const clearBtn = document.getElementById("clearBtn");
  const saveBtn = document.getElementById("saveBtn");

  function showStage() {
    gate.classList.add("fade-out");
    stage.hidden = false;
    // Remove the gate from the layout after the fade so it can't catch clicks.
    setTimeout(() => {
      gate.style.display = "none";
    }, 600);
  }

  function showGate() {
    gate.style.display = "flex";
    // Force reflow so the fade-in transition runs.
    void gate.offsetWidth;
    gate.classList.remove("fade-out");
    stage.hidden = true;
  }

  // --- Start / permission gate ---
  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startBtn.textContent = "listening …";
    try {
      await onStart();
      showStage();
    } catch (err) {
      // Most likely the user denied mic permission.
      console.error("[paper-listens] start failed:", err);
      startBtn.disabled = false;
      startBtn.textContent = "tap to listen";
      gateHint.textContent =
        "Could not access the microphone. Check your browser permissions and try again.";
      gateHint.style.color = "#a14a3a";
    }
  });

  // --- Controls panel toggle ---
  controlsToggle.addEventListener("click", () => {
    const open = controlsPanel.hidden;
    controlsPanel.hidden = !open;
    controlsToggle.setAttribute("aria-expanded", String(open));
  });

  // Close the panel when clicking outside it.
  document.addEventListener("click", (e) => {
    if (controlsPanel.hidden) return;
    if (!controlsPanel.contains(e.target) && e.target !== controlsToggle) {
      controlsPanel.hidden = true;
      controlsToggle.setAttribute("aria-expanded", "false");
    }
  });

  // --- Sensitivity ---
  sensitivity.addEventListener("input", () => {
    onSensitivity?.(Number(sensitivity.value) / 100);
  });

  // --- Action bar ---
  backBtn.addEventListener("click", () => {
    onBack?.();
    showGate();
    startBtn.disabled = false;
    startBtn.textContent = "tap to listen";
  });
  clearBtn.addEventListener("click", () => onClear?.());
  saveBtn.addEventListener("click", () => onSave?.());

  return { showStage, showGate };
}
