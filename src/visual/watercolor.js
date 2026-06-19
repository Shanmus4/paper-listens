// watercolor.js — renders pitched notes as ink on paper.
//
// Each note is an ink blot: a dark pooled core, an irregular surrounding mass,
// capillary tendrils that wick outward as it "dries", and a few feathered
// specks at the edge. Drawn with "multiply" so overlaps deepen like real ink.
// Wet blots draw on the visible canvas, then bake into the paper buffer once
// dry. Per-blot shape is seeded so it never shimmers between frames.

import { seededRng } from "./rng.js";

const DRY_MS = 520; // wet -> dry (ink keeps creeping a touch longer)
const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic

// Precompute the core lobes, tendrils, and feather specks for one blot.
function buildInk(spec) {
  const rand = seededRng(spec.seed);

  const core = [];
  const lobes = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < lobes; i++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * spec.radius * 0.5;
    core.push({
      dx: Math.cos(a) * d,
      dy: Math.sin(a) * d,
      r: spec.radius * (0.4 + rand() * 0.6),
      a: 0.6 + rand() * 0.4,
    });
  }

  // Tendrils: chains of shrinking dots radiating out, like ink in paper fibers.
  const tendrils = [];
  const nT = 4 + Math.floor(rand() * 4);
  for (let i = 0; i < nT; i++) {
    const baseAngle = rand() * Math.PI * 2;
    const len = spec.radius * (1.3 + rand() * 1.7);
    const steps = 4 + Math.floor(rand() * 4);
    const wob = (rand() - 0.5) * 0.6;
    const chain = [];
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const ang = baseAngle + wob * f;
      const dist = len * f;
      chain.push({
        dx: Math.cos(ang) * dist,
        dy: Math.sin(ang) * dist,
        r: spec.radius * (0.16 * (1 - f) + 0.04),
        a: (1 - f) * 0.6 + 0.1,
      });
    }
    tendrils.push(chain);
  }

  const feather = [];
  const nF = 6 + Math.floor(rand() * 6);
  for (let i = 0; i < nF; i++) {
    const a = rand() * Math.PI * 2;
    const d = spec.radius * (0.8 + rand() * 0.9);
    feather.push({
      dx: Math.cos(a) * d,
      dy: Math.sin(a) * d,
      r: spec.radius * (0.04 + rand() * 0.1),
      a: 0.2 + rand() * 0.3,
    });
  }

  return { core, tendrils, feather };
}

function radial(ctx, x, y, r, h, s, l, a, mid) {
  if (r <= 0 || a <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `hsla(${h}, ${s}%, ${l}%, ${a})`);
  g.addColorStop(mid, `hsla(${h}, ${s}%, ${l}%, ${a * 0.45})`);
  g.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawInk(ctx, b, t) {
  const fade = ease(Math.min(1, t * 1.4));
  const spread = ease(t); // tendrils + feather creep outward as it dries

  ctx.save();
  ctx.globalCompositeOperation = "multiply";

  // Dark pooled center (ink soaking in).
  radial(ctx, b.x, b.y, b.radius * 0.55, b.h, b.s, Math.max(18, b.l - 16), b.alpha * 0.7 * fade, 0.6);

  // Irregular surrounding mass.
  for (const p of b.parts.core) {
    radial(ctx, b.x + p.dx, b.y + p.dy, p.r * (0.7 + 0.3 * spread), b.h, b.s, b.l, b.alpha * p.a * fade, 0.5);
  }

  // Capillary tendrils.
  for (const chain of b.parts.tendrils) {
    for (const p of chain) {
      radial(ctx, b.x + p.dx * spread, b.y + p.dy * spread, p.r, b.h, b.s, b.l, b.alpha * p.a * fade * 0.85, 0.5);
    }
  }

  // Edge feathering.
  for (const p of b.parts.feather) {
    radial(ctx, b.x + p.dx * spread, b.y + p.dy * spread, p.r, b.h, b.s, b.l, b.alpha * p.a * fade * 0.6, 0.5);
  }

  ctx.restore();
}

export function createWatercolor(paper) {
  const wet = [];

  function addBlot(spec, nowMs) {
    wet.push({ ...spec, parts: buildInk(spec), born: nowMs });
  }

  function render(ctx, nowMs) {
    for (let i = wet.length - 1; i >= 0; i--) {
      const b = wet[i];
      const t = Math.min(1, (nowMs - b.born) / DRY_MS);
      drawInk(ctx, b, t);
      if (t >= 1) {
        drawInk(paper.state.bctx, b, 1); // bake into the paper
        wet.splice(i, 1);
      }
    }
  }

  function clear() {
    wet.length = 0;
  }

  return { addBlot, render, clear, count: () => wet.length };
}
