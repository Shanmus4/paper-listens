// canvas.js — sets up the painting surface and its offscreen "paper" buffer.
//
// We keep two canvases:
//   - the visible <canvas id="paper"> shown on screen
//   - an offscreen buffer that holds the dried painting (committed blots)
// Each frame the visible canvas draws the buffer plus any still-wet blots.
// This lets us clear / save the painting independently of live animation.

const DPR_CAP = 2.5; // avoid huge buffers on very high-density screens

export function createPaper(visibleCanvas) {
  const ctx = visibleCanvas.getContext("2d", { alpha: false });

  // Offscreen buffer for the persistent painting.
  const buffer = document.createElement("canvas");
  const bctx = buffer.getContext("2d");

  const state = {
    visibleCanvas,
    ctx,
    buffer,
    bctx,
    width: 0, // CSS pixels
    height: 0,
    dpr: 1,
  };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const w = window.innerWidth;
    const h = window.innerHeight;

    state.width = w;
    state.height = h;
    state.dpr = dpr;

    // Preserve the existing painting across a resize by copying the old buffer.
    const old = document.createElement("canvas");
    old.width = buffer.width;
    old.height = buffer.height;
    if (buffer.width > 0) old.getContext("2d").drawImage(buffer, 0, 0);

    for (const c of [visibleCanvas, buffer]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    visibleCanvas.style.width = w + "px";
    visibleCanvas.style.height = h + "px";

    // Work in CSS-pixel coordinates; the DPR scale is applied once here.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Repaint the preserved painting, rescaled to the new size.
    if (old.width > 0) {
      bctx.save();
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.drawImage(old, 0, 0, old.width, old.height, 0, 0, buffer.width, buffer.height);
      bctx.restore();
    }
  }

  function clear() {
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, buffer.width, buffer.height);
    bctx.restore();
  }

  // Save the dried painting (the buffer) as a PNG, flattened onto paper color.
  function save(filename = "paper-listens.png") {
    const out = document.createElement("canvas");
    out.width = buffer.width;
    out.height = buffer.height;
    const octx = out.getContext("2d");
    octx.fillStyle =
      getComputedStyle(document.body).getPropertyValue("background-color") || "#f4ede1";
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(buffer, 0, 0);

    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  resize();
  window.addEventListener("resize", resize);

  return { state, resize, clear, save };
}
