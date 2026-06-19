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

    // Nothing meaningful changed (e.g. a mobile address bar nudging the height
    // by a few px). Skip the rebuild so the painting doesn't flicker.
    const newBW = Math.round(w * dpr);
    const newBH = Math.round(h * dpr);
    if (newBW === buffer.width && newBH === buffer.height) {
      state.width = w;
      state.height = h;
      return;
    }

    const prevBW = buffer.width;

    // Preserve the existing painting across a resize by copying the old buffer.
    const old = document.createElement("canvas");
    old.width = buffer.width;
    old.height = buffer.height;
    if (buffer.width > 0) old.getContext("2d").drawImage(buffer, 0, 0);

    state.width = w;
    state.height = h;
    state.dpr = dpr;

    for (const c of [visibleCanvas, buffer]) {
      c.width = newBW;
      c.height = newBH;
    }
    visibleCanvas.style.width = w + "px";
    visibleCanvas.style.height = h + "px";

    // Work in CSS-pixel coordinates; the DPR scale is applied once here.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Repaint the preserved painting scaled UNIFORMLY by the width ratio, so
    // blots keep their round shape (no stretching) and never get clipped at
    // the sides. Anchored top-left; the page just extends or trims at the
    // bottom as the aspect ratio changes.
    if (old.width > 0 && prevBW > 0) {
      const k = newBW / prevBW;
      bctx.save();
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.drawImage(old, 0, 0, old.width, old.height, 0, 0, old.width * k, old.height * k);
      bctx.restore();
    }
  }

  function clear() {
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, buffer.width, buffer.height);
    bctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // Sign the piece top-left, on a translucent paper pill so the name stays
  // readable whatever colors (or none) sit behind it.
  function drawSignature(octx, name, w) {
    const size = Math.round(w * 0.02);
    octx.font = `700 ${size}px "Caveat", cursive`;

    // Measure the real glyph box so the padding around the text is even on all
    // sides (script fonts carry uneven side/baseline bearings, so the advance
    // width and font size alone would leave lopsided gaps).
    const m = octx.measureText(name);
    const left = m.actualBoundingBoxLeft || 0;
    const right = m.actualBoundingBoxRight || m.width;
    const ascent = m.actualBoundingBoxAscent || size * 0.7;
    const descent = m.actualBoundingBoxDescent || size * 0.2;
    const textW = left + right;
    const textH = ascent + descent;

    const pad = size * 0.42; // equal padding on every side
    const margin = Math.round(w * 0.015);
    const bw = textW + pad * 2;
    const bh = textH + pad * 2;

    roundRect(octx, margin, margin, bw, bh, bh * 0.32);
    octx.fillStyle = "rgba(244, 237, 225, 0.86)";
    octx.fill();
    octx.lineWidth = Math.max(1, size * 0.03);
    octx.strokeStyle = "rgba(58, 52, 44, 0.18)";
    octx.stroke();

    // Anchor the glyph box inside the pill using its measured bearings.
    octx.textBaseline = "alphabetic";
    octx.fillStyle = "#3a342c";
    octx.fillText(name, margin + pad + left, margin + pad + ascent);
  }

  // Save the dried painting (the buffer) as a PNG, flattened onto paper color,
  // optionally signed with a name in the corner.
  async function save(name = "") {
    const out = document.createElement("canvas");
    out.width = buffer.width;
    out.height = buffer.height;
    const octx = out.getContext("2d");
    octx.fillStyle =
      getComputedStyle(document.body).getPropertyValue("background-color") || "#f4ede1";
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(buffer, 0, 0);

    const clean = (name || "").trim();
    if (clean) {
      // Make sure the handwritten font is ready before drawing to canvas.
      try {
        await document.fonts.load(`700 ${Math.round(out.width * 0.02)}px "Caveat"`);
      } catch (_) {
        /* fall back to whatever is available */
      }
      drawSignature(octx, clean, out.width);
    }

    const file = clean
      ? clean.replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-") || "paper-listens"
      : "paper-listens";

    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${file}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  resize();
  window.addEventListener("resize", resize);

  return { state, resize, clear, save };
}
