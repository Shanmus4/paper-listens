// renderer.js — one painting interface, two backends.
//
// Prefers the WebGL ink renderer (gl/ink.js). If WebGL2 + float targets are
// unavailable it falls back to the original Canvas 2D watercolor renderer, so
// the app still works everywhere. main.js talks only to this facade and never
// cares which backend is live.
//
// Both backends share the same surface:
//   dims()                      -> { width, height, dpr } in CSS pixels
//   addBlot(spec, now) / addSplat(spec, now)   animated (wet) ink
//   bake(spec) / bakeSplat(spec)               instant bake (seek rebuild)
//   render(now)                 draw the painting to the paper canvas
//   renderGrid(visible)         draw the note-grid overlay (separate canvas)
//   clear() / purge() / resize()
//   save(name)                  export a signed PNG

import { createPaper } from "./canvas.js";
import { createWatercolor } from "./watercolor.js";
import { createPercussion } from "./percussion.js";
import { createInk } from "./gl/ink.js";
import { drawGrid } from "./grid.js";
import { renderSignature, downloadCanvasPNG } from "./signature.js";

const PAPER_CSS =
  getComputedStyle(document.body).getPropertyValue("background-color").trim() || "#f4ede1";

// Size the grid overlay canvas to match the paper in device pixels and work in
// CSS-pixel coordinates (so drawGrid lines up with where blots land).
function sizeOverlay(overlayCanvas, octx, width, height, dpr) {
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    overlayCanvas.style.width = width + "px";
    overlayCanvas.style.height = height + "px";
  }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function createRenderer(paperCanvas, overlayCanvas) {
  const octx = overlayCanvas.getContext("2d");
  // Prefer WebGL, but never let a GL failure blank the app: any error (missing
  // context, shader compile, etc.) falls back to the Canvas 2D renderer.
  let ink = null;
  try {
    ink = createInk(paperCanvas);
  } catch (err) {
    console.error("[paper-listens] WebGL init failed, using Canvas 2D:", err);
    ink = null;
  }
  return ink
    ? glRenderer(ink, overlayCanvas, octx)
    : canvasRenderer(paperCanvas, overlayCanvas, octx);
}

// ---- WebGL backend ----
function glRenderer(ink, overlayCanvas, octx) {
  function syncOverlay() {
    const { width, height, dpr } = ink.dims();
    sizeOverlay(overlayCanvas, octx, width, height, dpr);
  }
  syncOverlay();

  function renderGrid(visible) {
    const { width, height } = ink.dims();
    octx.clearRect(0, 0, width, height);
    if (visible) drawGrid(octx, width, height);
  }

  async function save(name) {
    const { width, height, dpr } = ink.dims();
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    ink.render(performance.now()); // make sure the latest frame is on the canvas
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const o = out.getContext("2d");
    o.fillStyle = PAPER_CSS;
    o.fillRect(0, 0, w, h);
    o.drawImage(ink.canvas, 0, 0, w, h);
    const clean = (name || "").trim();
    if (clean) await renderSignature(o, clean, w);
    downloadCanvasPNG(out, clean);
  }

  return {
    isGL: true,
    canvas: ink.canvas,
    dims: ink.dims,
    addBlot: ink.addBlot,
    addSplat: ink.addSplat,
    bake: ink.bake,
    bakeSplat: ink.bakeSplat,
    render: ink.render,
    renderGrid,
    clear: ink.clear,
    purge: ink.purge,
    resize() {
      ink.resize();
      syncOverlay();
    },
    save,
  };
}

// ---- Canvas 2D fallback ----
function canvasRenderer(paperCanvas, overlayCanvas, octx) {
  const paper = createPaper(paperCanvas);
  const watercolor = createWatercolor(paper);
  const percussion = createPercussion(paper);

  function syncOverlay() {
    sizeOverlay(overlayCanvas, octx, paper.state.width, paper.state.height, paper.state.dpr);
  }
  syncOverlay();

  function renderGrid(visible) {
    const { width, height } = paper.state;
    octx.clearRect(0, 0, width, height);
    if (visible) drawGrid(octx, width, height);
  }

  return {
    isGL: false,
    canvas: paperCanvas,
    dims: () => ({ width: paper.state.width, height: paper.state.height, dpr: paper.state.dpr }),
    addBlot: (spec, now) => watercolor.addBlot(spec, now),
    addSplat: (spec, now) => percussion.addSplat(spec, now),
    bake: (spec) => watercolor.bake(spec),
    bakeSplat: (spec) => percussion.bake(spec),
    render(now) {
      const { ctx, buffer, width, height } = paper.state;
      ctx.fillStyle = PAPER_CSS;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(buffer, 0, 0, buffer.width, buffer.height, 0, 0, width, height);
      watercolor.render(ctx, now);
      percussion.render(ctx, now);
    },
    renderGrid,
    clear() {
      paper.clear();
      watercolor.clear();
      percussion.clear();
    },
    purge() {
      // Keep the dried painting; only drop in-flight blots and the shape cache.
      watercolor.purge();
      percussion.clear();
    },
    resize() {
      paper.resize();
      syncOverlay();
    },
    save: (name) => paper.save(name),
  };
}
