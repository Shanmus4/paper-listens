// ink.js — the WebGL ink renderer.
//
// Pigment is accumulated as per-channel "absorbance" into a floating-point
// framebuffer with additive blending, then a tonemap pass turns absorbance into
// a paper color (Beer-Lambert). This is what fixes the old multiply renderer's
// black buildup: a repeated note deepens toward a rich dark version of its own
// hue and then saturates, never flat black.
//
// Two surfaces:
//   baked  — the persistent, dried painting (survives until clear/seek-rebuild)
//   work   — per frame: a copy of baked plus the currently animating wet blots
//
// Every blot is drawn procedurally from a seed (see shaders.js), so the painting
// is identical every time it is rebuilt. Bloom is driven by elapsed lifetime
// (a pure function of time), so seeking to any moment reconstructs the same art.

import { createGLContext, sizeCanvas } from "./context.js";
import { createProgram } from "./program.js";
import { createFBO, clearFBO, deleteFBO, blitFBO } from "./fbo.js";
import { BLOT_VS, BLOT_FS, FADE_FS, QUAD_VS, TONEMAP_FS } from "./shaders.js";
import { seededRng } from "../rng.js";

const BLOT_EXTENT = 2.2; // quad half-size as a multiple of radius (room for tendrils)
const PITCH_LIFETIME = 900; // ms wet->dry for pitched blots (slow watercolor bloom)
const PERC_LIFETIME = 300; // ms for percussion splatter (settles fast)
const STRENGTH_K = 1.8; // scales spec alpha into absorbance density
const PITCH_FLOW = 0.7; // plume reach for pitched blots (seeded direction)
const PERC_FLOW = 0.5; // outward plume reach for splatter droplets
// Decay-on-restrike: when a new pitched blot lands on a cell, the pigment
// already there is multiplied by this before the new ink is added. Repeated
// hits settle at A* = s/(1-PITCH_DECAY) — a finite deep tone, never black,
// never zero. Lower = older strokes fade faster and the cell stays lighter.
const PITCH_DECAY = 0.72;

// Deterministic plume direction for a pitched blot, from its seed. Each note
// streaks its own way so the field reads as ink in water, not a row of discs.
function pitchFlow(seed) {
  const ang = (seed != null ? seed : 0.5) * Math.PI * 2 * 6.0 + 1.3;
  return [Math.cos(ang) * PITCH_FLOW, Math.sin(ang) * PITCH_FLOW];
}

// Warm ink tones for drums (mirrors the old percussion palette), as HSL.
const DRUM_INK = {
  kick: { h: 28, s: 28, l: 20 },
  snare: { h: 30, s: 20, l: 30 },
  hihat: { h: 32, s: 14, l: 42 },
};

// HSL (deg, %, %) -> linear-ish RGB 0..1 for the shader.
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

// CSS color string -> RGB 0..1 (used for the paper tone). Uses a tiny canvas.
function cssToRgb(css, fallback) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const x = c.getContext("2d");
    x.fillStyle = css;
    x.fillRect(0, 0, 1, 1);
    const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
    return [r / 255, g / 255, b / 255];
  } catch (_) {
    return fallback;
  }
}

// Build the blot objects for a percussion splatter: a central blot plus a
// seeded scatter of droplets. Returns plain blot specs the renderer can draw.
function splatBlots(spec) {
  const rand = seededRng(spec.seed);
  const ink = DRUM_INK[spec.drum] || DRUM_INK.snare;
  const color = hslToRgb(ink.h, ink.s, ink.l);
  const strength = (spec.alpha || 0.4) * STRENGTH_K;
  const ca = rand() * Math.PI * 2; // gentle drift for the central blob
  const blots = [
    { x: spec.x, y: spec.y, radius: spec.radius, color, seed: rand(),
      strength, edge: 0.2, grain: 0.7,
      flow: [Math.cos(ca) * PERC_FLOW * 0.4, Math.sin(ca) * PERC_FLOW * 0.4] },
  ];
  const n = spec.count || 6;
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const dist = spec.radius * (0.6 + rand() * 1.8);
    blots.push({
      x: spec.x + Math.cos(a) * dist,
      y: spec.y + Math.sin(a) * dist,
      radius: spec.radius * (0.12 + rand() * 0.3),
      color,
      seed: rand(),
      strength: strength * (0.4 + rand() * 0.5),
      edge: 0.15,
      grain: 0.8,
      // Droplets stream away from the impact point, like a real splatter.
      flow: [Math.cos(a) * PERC_FLOW, Math.sin(a) * PERC_FLOW],
    });
  }
  return blots;
}

// A pitched spec from synesthesia.mapPitched -> a renderer blot.
function pitchedBlot(spec) {
  const seed = spec.seed != null ? spec.seed : 0.5;
  return {
    x: spec.x,
    y: spec.y,
    radius: spec.radius,
    color: hslToRgb(spec.h, spec.s, spec.l),
    seed,
    strength: (spec.alpha || 0.4) * STRENGTH_K,
    edge: spec.edge != null ? spec.edge : 0.5,
    grain: spec.grain != null ? spec.grain : 0.2,
    flow: pitchFlow(seed),
    kind: "pitch", // marks blots that decay prior pigment on restrike
  };
}

// Create the renderer. Returns null if WebGL2 + float targets are unavailable,
// so the caller can fall back to the Canvas 2D renderer.
export function createInk(canvas) {
  const ctx = createGLContext(canvas);
  if (!ctx) return null;
  const gl = ctx.gl;

  const blot = createProgram(gl, BLOT_VS, BLOT_FS);
  const fade = createProgram(gl, BLOT_VS, FADE_FS);
  const tonemap = createProgram(gl, QUAD_VS, TONEMAP_FS);

  // One quad ([-1,1] strip) shared by both programs (a_pos pinned to loc 0).
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const paper = cssToRgb(
    getComputedStyle(document.body).getPropertyValue("background-color").trim() || "#f4ede1",
    [0.957, 0.929, 0.882]
  );

  let size = sizeCanvas(canvas);
  let baked = createFBO(gl, size.w, size.h);
  let work = createFBO(gl, size.w, size.h);
  clearFBO(gl, baked);

  // Wet (animating) blots: { x, y, radius, color, seed, strength, edge, grain,
  // born, lifetime }. They draw into `work` each frame, then bake into `baked`.
  const wet = [];

  function setBlotUniforms(b, progress) {
    gl.uniform2f(blot.loc("u_center"), b.x * size.dpr, b.y * size.dpr);
    gl.uniform1f(blot.loc("u_radius"), b.radius * BLOT_EXTENT * size.dpr);
    gl.uniform2f(blot.loc("u_res"), size.w, size.h);
    gl.uniform3f(blot.loc("u_color"), b.color[0], b.color[1], b.color[2]);
    gl.uniform1f(blot.loc("u_seed"), b.seed);
    gl.uniform1f(blot.loc("u_strength"), b.strength);
    gl.uniform1f(blot.loc("u_progress"), progress);
    gl.uniform1f(blot.loc("u_edge"), b.edge);
    gl.uniform1f(blot.loc("u_grain"), b.grain);
    const f = b.flow || [0, 1];
    gl.uniform2f(blot.loc("u_flow"), f[0], f[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Draw a list of blots into a target FBO with additive blending.
  function drawInto(fbo, blots, progressOf) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
    gl.viewport(0, 0, fbo.w, fbo.h);
    gl.useProgram(blot.program);
    gl.bindVertexArray(vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive: accumulate absorbance
    for (const b of blots) setBlotUniforms(b, progressOf(b));
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  // Decay-on-restrike: multiply the pigment already inside this blot's footprint
  // by PITCH_DECAY before the new ink is added on top. Keeps a repeatedly-hit
  // cell from stacking to black (see FADE_FS). Must run in event order so live
  // play and seek-rebuild produce the identical painting.
  function decayInto(fbo, b) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
    gl.viewport(0, 0, fbo.w, fbo.h);
    gl.useProgram(fade.program);
    gl.bindVertexArray(vao);
    gl.uniform2f(fade.loc("u_center"), b.x * size.dpr, b.y * size.dpr);
    gl.uniform1f(fade.loc("u_radius"), b.radius * BLOT_EXTENT * size.dpr);
    gl.uniform2f(fade.loc("u_res"), size.w, size.h);
    gl.uniform1f(fade.loc("u_decay"), PITCH_DECAY);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR); // dst *= src (the decay factor)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  // Commit one pitched blot into baked: decay what's there, then add on top.
  function commitPitched(b) {
    decayInto(baked, b);
    drawInto(baked, [b], () => 1);
  }

  // ---- public: add wet (animated) ink ----
  function addBlot(spec, nowMs) {
    const b = pitchedBlot(spec);
    b.born = nowMs;
    b.lifetime = PITCH_LIFETIME;
    wet.push(b);
  }
  function addSplat(spec, nowMs) {
    for (const b of splatBlots(spec)) {
      b.born = nowMs;
      b.lifetime = PERC_LIFETIME;
      wet.push(b);
    }
  }

  // ---- public: bake instantly (seek rebuild), fully bloomed, no animation ----
  function bake(spec) {
    commitPitched(pitchedBlot(spec));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function bakeSplat(spec) {
    drawInto(baked, splatBlots(spec), () => 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---- public: draw one frame to the screen ----
  function render(nowMs) {
    // Start the frame from the dried painting.
    blitFBO(gl, baked, work);

    // Bake any blots that finished blooming, then draw the rest (still wet) on
    // top of the work buffer at their current bloom progress.
    if (wet.length) {
      const stillWet = [];
      const justDried = [];
      for (const b of wet) {
        const t = (nowMs - b.born) / b.lifetime;
        if (t >= 1) justDried.push(b);
        else stillWet.push(b);
      }
      // Commit dried blots in order: pitched ones decay prior pigment first;
      // percussion just adds (its scatter does not pile on one cell).
      for (const b of justDried) {
        if (b.kind === "pitch") commitPitched(b);
        else drawInto(baked, [b], () => 1);
      }
      blitFBO(gl, baked, work); // refresh work with the newly dried ones
      if (stillWet.length) {
        drawInto(work, stillWet, (b) => Math.max(0, (nowMs - b.born) / b.lifetime));
      }
      wet.length = 0;
      for (const b of stillWet) wet.push(b);
    }

    // Tonemap work -> screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, size.w, size.h);
    gl.useProgram(tonemap.program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, work.tex);
    gl.uniform1i(tonemap.loc("u_tex"), 0);
    gl.uniform3f(tonemap.loc("u_paper"), paper[0], paper[1], paper[2]);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // New sheet: wipe the dried painting and any in-flight blots.
  function clear() {
    wet.length = 0;
    clearFBO(gl, baked);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Source teardown: drop only in-flight blots. The dried painting is kept
  // (switching source must not erase the canvas art).
  function purge() {
    wet.length = 0;
  }

  function resize() {
    const next = sizeCanvas(canvas);
    if (!next.changed) {
      size = next;
      return;
    }
    // Preserve the painting: blit the old baked surface into a new-sized one.
    const newBaked = createFBO(gl, next.w, next.h);
    clearFBO(gl, newBaked);
    blitFBO(gl, baked, newBaked);
    deleteFBO(gl, baked);
    deleteFBO(gl, work);
    baked = newBaked;
    work = createFBO(gl, next.w, next.h);
    size = next;
  }

  return {
    isGL: true,
    canvas,
    dims: () => ({ width: size.cssW, height: size.cssH, dpr: size.dpr }),
    addBlot,
    addSplat,
    bake,
    bakeSplat,
    render,
    clear,
    purge,
    resize,
  };
}
