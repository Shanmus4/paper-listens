// watercolor.js — turns blot specs into watercolor on paper.
//
// A blot is faked from several overlapping, offset radial gradients drawn with
// the "multiply" blend mode, so overlaps darken like real pigment. Each blot
// animates from wet to dry over a short time (growing and bleeding), then is
// committed once to the persistent paper buffer and dropped from the live set.
//
// The per-blot random offsets are computed ONCE at creation (seeded by the
// spec's seed) so the blot keeps its shape every frame instead of shimmering.

import { seededRng } from "./rng.js";

const DRY_MS = 480; // wet -> dry duration
const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic

// Precompute the sub-blobs (and a few outer droplets) that make up one blot.
function buildParts(spec) {
  const rand = seededRng(spec.seed);
  const spread = spec.radius * (0.55 - spec.edge * 0.2);
  const lobes = 7 + Math.floor(rand() * 5); // 7..11 stacked gradients
  const parts = [];

  for (let i = 0; i < lobes; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = rand() * spread;
    parts.push({
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      r: spec.radius * (0.45 + rand() * 0.6),
      a: 0.5 + rand() * 0.5,
      droplet: false,
    });
  }

  // A couple of small outer droplets sell the "bleed" without much cost.
  const droplets = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < droplets; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = spec.radius * (0.9 + rand() * 0.8);
    parts.push({
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      r: spec.radius * (0.12 + rand() * 0.18),
      a: 0.3 + rand() * 0.3,
      droplet: true,
    });
  }
  return parts;
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

// Draw one blot at dry-progress t (0=just born, 1=dry) onto ctx.
function drawBlot(ctx, b, t) {
  const grow = 0.6 + 0.4 * ease(t); // bleeds outward as it dries
  const fade = ease(Math.min(1, t * 1.3)); // alpha eases in
  const mid = 0.4 + b.edge * 0.3; // crisper sound -> tighter falloff

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  for (const p of b.parts) {
    radial(
      ctx,
      b.x + p.dx * grow,
      b.y + p.dy * grow,
      p.r * grow,
      b.h,
      b.s,
      b.l,
      b.alpha * p.a * fade,
      p.droplet ? 0.5 : mid
    );
  }

  // Edge-darkening ring: pigment pools at the drying rim (watercolor's tell).
  if (t > 0.45) {
    const ringA = b.alpha * 0.25 * ease((t - 0.45) / 0.55);
    const rr = b.radius * grow * 1.05;
    const g = ctx.createRadialGradient(b.x, b.y, rr * 0.7, b.x, b.y, rr);
    g.addColorStop(0, `hsla(${b.h}, ${b.s}%, ${Math.max(20, b.l - 12)}%, 0)`);
    g.addColorStop(0.82, `hsla(${b.h}, ${b.s}%, ${Math.max(20, b.l - 12)}%, ${ringA})`);
    g.addColorStop(1, `hsla(${b.h}, ${b.s}%, ${b.l}%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function createWatercolor(paper) {
  const wet = [];

  function addBlot(spec, nowMs) {
    wet.push({ ...spec, parts: buildParts(spec), born: nowMs });
  }

  // Draw all wet blots onto the visible ctx; commit finished ones to the buffer.
  function render(ctx, nowMs) {
    for (let i = wet.length - 1; i >= 0; i--) {
      const b = wet[i];
      const t = Math.min(1, (nowMs - b.born) / DRY_MS);
      drawBlot(ctx, b, t);
      if (t >= 1) {
        drawBlot(paper.state.bctx, b, 1); // bake into the paper once
        wet.splice(i, 1);
      }
    }
  }

  function clear() {
    wet.length = 0;
  }

  return { addBlot, render, clear, count: () => wet.length };
}
