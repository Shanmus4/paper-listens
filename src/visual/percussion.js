// percussion.js — paints drums as monochrome ink splatters.
//
// Harmony reads as color (watercolor); rhythm reads as ink. Each percussive
// onset throws a central blot plus a scatter of droplets in warm sepia/charcoal
// so a busy song stays legible. A kick also pulses the whole sheet for groove.

import { seededRng } from "./rng.js";

const DRY_MS = 280; // splatters settle fast
const ease = (t) => 1 - Math.pow(1 - t, 3);

// Warm ink tones. Kicks are darkest/heaviest, hats lightest/finest.
const INK = {
  kick: { h: 28, s: 28, l: 20 },
  snare: { h: 30, s: 20, l: 30 },
  hihat: { h: 32, s: 14, l: 42 },
};

function buildSpray(spec) {
  const rand = seededRng(spec.seed);
  const parts = [{ dx: 0, dy: 0, r: spec.radius, a: 1, fly: 0 }]; // central blot
  for (let i = 0; i < spec.count; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = spec.radius * (0.6 + rand() * 1.8);
    parts.push({
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      r: spec.radius * (0.08 + rand() * 0.28),
      a: 0.4 + rand() * 0.5,
      fly: 0.4 + rand() * 0.6, // how far it travels as it lands
    });
  }
  return parts;
}

function dot(ctx, x, y, r, h, s, l, a) {
  if (r <= 0 || a <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `hsla(${h}, ${s}%, ${l}%, ${a})`);
  g.addColorStop(0.7, `hsla(${h}, ${s}%, ${l}%, ${a * 0.5})`);
  g.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawSplat(ctx, s, t) {
  const ink = INK[s.drum] || INK.snare;
  const fade = ease(Math.min(1, t * 1.6)); // ink hits fast
  const land = ease(t); // droplets fly outward then settle

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  for (const p of s.parts) {
    const travel = 1 - (1 - land) * p.fly; // start nearer center, fly out
    dot(
      ctx,
      s.x + p.dx * travel,
      s.y + p.dy * travel,
      p.r,
      ink.h,
      ink.s,
      ink.l,
      s.alpha * p.a * fade
    );
  }
  ctx.restore();
}

export function createPercussion(paper) {
  const splats = [];
  let pulse = 0; // kick pulse 0..1, decays each frame

  function addSplat(spec, nowMs) {
    splats.push({ ...spec, parts: buildSpray(spec), born: nowMs });
    if (spec.drum === "kick") pulse = Math.min(1, pulse + 0.45);
  }

  function drawPulse(ctx) {
    const { width, height } = paper.state;
    const g = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.2,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.75
    );
    g.addColorStop(0, "hsla(28, 25%, 20%, 0)");
    g.addColorStop(1, `hsla(28, 25%, 20%, ${pulse * 0.12})`);
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  function render(ctx, nowMs) {
    for (let i = splats.length - 1; i >= 0; i--) {
      const s = splats[i];
      const t = Math.min(1, (nowMs - s.born) / DRY_MS);
      drawSplat(ctx, s, t);
      if (t >= 1) {
        drawSplat(paper.state.bctx, s, 1); // bake into the paper
        splats.splice(i, 1);
      }
    }
    if (pulse > 0.01) {
      drawPulse(ctx); // transient, never baked
      pulse *= 0.9;
    } else {
      pulse = 0;
    }
  }

  function clear() {
    splats.length = 0;
    pulse = 0;
  }

  return { addSplat, render, clear, count: () => splats.length };
}
