// context.js — acquire a WebGL2 context with a floating-point render target.
//
// The ink renderer accumulates pigment "absorbance" additively into a float
// framebuffer (so density can grow past 1.0 before we tonemap it). That needs
// WebGL2 + EXT_color_buffer_float. If either is missing we return null and the
// caller falls back to the Canvas 2D renderer — no hard failure on old devices.

const DPR_CAP = 2.5; // matches canvas.js: avoid huge buffers on retina

// Probe WebGL2 + float-target support on a throwaway canvas first. A <canvas>
// permanently locks to the first context type requested, so if we asked the
// real paper canvas for "webgl2" and then bailed, the Canvas 2D fallback could
// never get a "2d" context on it. Probing on a disposable canvas keeps the real
// one untouched unless GL is actually viable.
function glSupported() {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    if (!gl) return false;
    return !!gl.getExtension("EXT_color_buffer_float");
  } catch (_) {
    return false;
  }
}

// Try to get a usable GL context. Returns { gl } or null.
export function createGLContext(canvas) {
  if (!glSupported()) return null;

  let gl = null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // so toBlob/readPixels see the last frame
    });
  } catch (_) {
    gl = null;
  }
  if (!gl) return null;

  // Float color attachments are required for the absorbance accumulation buffer.
  if (!gl.getExtension("EXT_color_buffer_float")) return null;

  return { gl };
}

// Size the drawing buffer to the viewport in device pixels. Returns the device
// pixel size and whether anything actually changed (so the caller can rebuild
// framebuffers only when needed, like canvas.js does).
export function sizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  const changed = canvas.width !== w || canvas.height !== h;
  if (changed) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
  }
  return { w, h, cssW, cssH, dpr, changed };
}
