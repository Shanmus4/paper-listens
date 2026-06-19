// level.js — the small input-level meter in the bottom-left corner.
// Shows a rolling bar history of loudness so the user can see it is listening.

const BARS = 48;

export function createLevelMeter(canvas) {
  const ctx = canvas.getContext("2d");
  const history = new Array(BARS).fill(0);

  // Read the ink color once so the meter matches the paper palette.
  const ink = getComputedStyle(document.body).getPropertyValue("--sepia").trim() || "#8b7355";

  function push(rms) {
    // RMS is small (~0..0.3 for normal input); scale into a visible 0..1 range.
    const v = Math.min(1, Math.sqrt(rms) * 1.8);
    history.push(v);
    history.shift();
  }

  function render() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const gap = 2;
    const barW = (w - gap * (BARS - 1)) / BARS;
    ctx.fillStyle = ink;

    for (let i = 0; i < BARS; i++) {
      const v = history[i];
      const barH = Math.max(1, v * h);
      const x = i * (barW + gap);
      const y = (h - barH) / 2; // center vertically, like a waveform
      ctx.globalAlpha = 0.35 + v * 0.55;
      ctx.fillRect(x, y, barW, barH);
    }
    ctx.globalAlpha = 1;
  }

  return { push, render };
}
