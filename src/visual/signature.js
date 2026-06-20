// signature.js — sign a finished painting and trigger the PNG download.
//
// Shared by the WebGL save path (renderer.js). The Canvas 2D fallback keeps its
// own copy in canvas.js. Kept tiny and dependency-free.

// Turn a user-entered name into a safe file stem.
export function sanitizeName(name) {
  const clean = (name || "").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-");
  return clean || "paper-listens";
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

// Draw the handwritten signature on a translucent paper pill, top-left, sized
// relative to the output width. Mirrors canvas.js drawSignature so both paths
// look identical. Async because the script font must be loaded first.
export async function renderSignature(octx, name, w) {
  const size = Math.round(w * 0.02);
  try {
    await document.fonts.load(`700 ${size}px "Caveat"`);
  } catch (_) {
    /* fall back to whatever is available */
  }
  octx.font = `700 ${size}px "Caveat", cursive`;

  const m = octx.measureText(name);
  const left = m.actualBoundingBoxLeft || 0;
  const right = m.actualBoundingBoxRight || m.width;
  const ascent = m.actualBoundingBoxAscent || size * 0.7;
  const descent = m.actualBoundingBoxDescent || size * 0.2;
  const textW = left + right;
  const textH = ascent + descent;

  const pad = size * 0.42;
  const margin = Math.round(w * 0.015);
  const bw = textW + pad * 2;
  const bh = textH + pad * 2;

  roundRect(octx, margin, margin, bw, bh, bh * 0.32);
  octx.fillStyle = "rgba(244, 237, 225, 0.86)";
  octx.fill();
  octx.lineWidth = Math.max(1, size * 0.03);
  octx.strokeStyle = "rgba(58, 52, 44, 0.18)";
  octx.stroke();

  octx.textBaseline = "alphabetic";
  octx.fillStyle = "#3a342c";
  octx.fillText(name, margin + pad + left, margin + pad + ascent);
}

// Export a canvas as a downloaded PNG named after `name`.
export function downloadCanvasPNG(canvas, name) {
  const file = sanitizeName(name);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
