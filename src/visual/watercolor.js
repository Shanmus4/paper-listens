// watercolor.js — renders pitched notes as watercolor ink on paper.
//
// Real watercolor has soft, irregular, feathered edges with darker pooling in
// the middle and lighter pigment bleeding outward. We get that look by taking
// one organic polygon and stacking many slightly-redrawn, low-opacity copies
// of it (the classic layered-polygon watercolor technique): where many layers
// overlap the color deepens; at the ragged edges only a few reach, so it fades
// like pigment soaking into the page.
//
// Each blot is rendered ONCE to its own small offscreen canvas when it lands,
// then the render loop just stamps that canvas to screen (growing + fading in
// as it "blooms"), and bakes it into the paper buffer once dry. This keeps the
// per-frame cost to a single drawImage no matter how detailed the blot is.

import { seededRng } from "./rng.js";

const TAU = Math.PI * 2;
const DRY_MS = 900; // wet -> dry; watercolor blooms slowly
const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
const clampPct = (v) => Math.min(100, Math.max(0, v));

// Roughen a closed polygon: insert a displaced midpoint on every edge, a few
// times over. Displacement shrinks each pass, so big lobes get fine ragged
// detail layered on top — the organic outline a wet edge makes on paper.
function deform(points, iterations, variance, rand) {
  let pts = points;
  let v = variance;
  for (let it = 0; it < iterations; it++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push(a);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len; // edge normal
      const ny = dx / len;
      const disp = (rand() - 0.5) * len * v;
      out.push({ x: (a.x + b.x) / 2 + nx * disp, y: (a.y + b.y) / 2 + ny * disp });
    }
    pts = out;
    v *= 0.62;
  }
  return pts;
}

// A rough starting ring of `n` points at a jittered radius.
function ring(n, radius, jitter, rand) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (rand() - 0.5) * 0.3;
    const r = radius * (1 - jitter + rand() * jitter * 2);
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

// Precompute everything needed to paint one blot: the layered body polygons
// (each with its own slight color shift for granulation), a darker pooled core,
// and a few pigment specks near the edge.
function buildShape(spec) {
  const rand = seededRng(spec.seed);
  const R = spec.radius;

  // The "master" outline every layer is a variation of.
  const base = deform(ring(6 + Math.floor(rand() * 4), R, 0.35, rand), 3, 0.6, rand);

  const layers = [];
  const N = 22 + Math.floor(rand() * 8);
  for (let i = 0; i < N; i++) {
    layers.push({
      poly: deform(base, 2, 0.4, rand),
      // Small per-layer hue/lightness drift reads as pigment granulation.
      h: spec.h + (rand() - 0.5) * 8,
      s: clampPct(spec.s + (rand() - 0.5) * 12),
      l: clampPct(spec.l + (rand() - 0.5) * 14),
    });
  }

  // Darker pooled centre, offset a touch so it never looks like a target.
  const cx = (rand() - 0.5) * R * 0.3;
  const cy = (rand() - 0.5) * R * 0.3;
  const core = deform(ring(6, R * 0.45, 0.4, rand), 3, 0.5, rand).map((p) => ({
    x: p.x + cx,
    y: p.y + cy,
  }));

  const specks = [];
  const ns = 4 + Math.floor(rand() * 5);
  for (let i = 0; i < ns; i++) {
    const a = rand() * TAU;
    const d = R * (0.4 + rand() * 0.8);
    specks.push({
      x: Math.cos(a) * d,
      y: Math.sin(a) * d,
      r: R * (0.03 + rand() * 0.07),
      a: 0.1 + rand() * 0.18,
    });
  }

  return { layers, core, specks };
}

function fillPoly(c, poly) {
  c.beginPath();
  c.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) c.lineTo(poly[i].x, poly[i].y);
  c.closePath();
  c.fill();
}

// Paint the blot once onto a transparent offscreen canvas. Layers multiply
// against each other so the overlap darkens organically.
function renderToCanvas(spec, shape) {
  const R = spec.radius;
  const half = Math.ceil(R * 2.4); // room for the ragged outer edges
  const size = half * 2;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const c = cv.getContext("2d");
  c.translate(half, half);
  c.globalCompositeOperation = "multiply";

  // Body: many faint layers build up depth and feathered edges.
  const layerAlpha = (spec.alpha * 0.9) / Math.sqrt(shape.layers.length);
  for (const ly of shape.layers) {
    c.fillStyle = `hsla(${ly.h}, ${ly.s}%, ${ly.l}%, ${layerAlpha})`;
    fillPoly(c, ly.poly);
  }

  // Pooled core where the pigment settles darkest.
  c.fillStyle = `hsla(${spec.h}, ${clampPct(spec.s)}%, ${clampPct(spec.l - 16)}%, ${spec.alpha * 0.5})`;
  fillPoly(c, shape.core);

  // Granulation specks at the edge.
  for (const sp of shape.specks) {
    c.fillStyle = `hsla(${spec.h}, ${clampPct(spec.s)}%, ${clampPct(spec.l - 8)}%, ${sp.a})`;
    c.beginPath();
    c.arc(sp.x, sp.y, sp.r, 0, TAU);
    c.fill();
  }

  return { cv, half };
}

export function createWatercolor(paper) {
  const wet = [];

  function addBlot(spec, nowMs) {
    const shape = buildShape(spec);
    const { cv, half } = renderToCanvas(spec, shape);
    wet.push({ cv, half, x: spec.x, y: spec.y, born: nowMs });
  }

  // Stamp the prerendered blot, blooming outward and fading in while wet.
  function stamp(ctx, b, t) {
    const appear = Math.min(1, t * 3); // pigment soaks in over the first third
    const grow = 0.88 + 0.14 * ease(t); // edges creep outward as it dries
    const r = b.half * grow;
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = appear;
    ctx.drawImage(b.cv, b.x - r, b.y - r, r * 2, r * 2);
    ctx.restore();
  }

  function render(ctx, nowMs) {
    for (let i = wet.length - 1; i >= 0; i--) {
      const b = wet[i];
      const t = Math.min(1, (nowMs - b.born) / DRY_MS);
      stamp(ctx, b, t);
      if (t >= 1) {
        stamp(paper.state.bctx, b, 1); // bake into the paper
        wet.splice(i, 1);
      }
    }
  }

  function clear() {
    wet.length = 0;
  }

  return { addBlot, render, clear, count: () => wet.length };
}
