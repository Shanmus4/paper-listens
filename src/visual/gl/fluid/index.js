// index.js — the fluid renderer facade.
//
// Presents the same surface the rest of the app expects (dims/addBlot/addSplat/
// render/clear/resize/...) but backs it with the stable-fluids solver. A note is
// no longer a stamp: addBlot injects a puff of colored dye plus a velocity
// impulse in the note's direction, and the simulation makes it billow, swirl,
// and mix like ink in water.
//
// Time is driven by stepTo(simT): the caller advances the simulation to a song
// time with a fixed timestep, so the painting is deterministic (same notes +
// same dt = same picture) and live playback and seek rebuild share one path.

import { createGLContext, sizeCanvas } from "../context.js";
import { createSolver } from "./solver.js";

const SIM_DT = 1 / 60; // fixed simulation timestep (s)
const MAX_STEPS = 240; // cap per stepTo call so a big seek can't freeze the tab
const DYE_STRENGTH = 2.1; // spec alpha -> dye absorbance (higher = fuller, denser ink)
const VEL_MAG = 75; // melodic-direction impulse speed (gentler = blooms stay local)
const DYE_R = 0.9; // dye splat radius scale (relative to spec radius)
const VEL_R = 1.6; // velocity splat radius scale (push a wider area than the dye)

// Warm ink tones for drums, as HSL (mirrors the previous palette).
const DRUM_INK = {
  kick: { h: 28, s: 28, l: 20 },
  snare: { h: 30, s: 20, l: 30 },
  hihat: { h: 32, s: 14, l: 42 },
};

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

export function createFluidInk(canvas) {
  const ctx = createGLContext(canvas);
  if (!ctx) return null;
  const gl = ctx.gl;

  let size = sizeCanvas(canvas);
  const solver = createSolver(gl, canvas);
  solver.init(size.cssW, size.cssH);

  const paper = cssToRgb(
    getComputedStyle(document.body).getPropertyValue("background-color").trim() || "#f4ede1",
    [0.957, 0.929, 0.882]
  );

  let simTime = 0;

  // Canvas pixel point -> sim uv (note the y flip: uv origin is bottom-left).
  function toUv(x, y) {
    return [x / size.cssW, 1 - y / size.cssH];
  }

  // Inject a pitched note: a dye puff (its color) plus a velocity impulse in its
  // melodic direction (dir is a unit vector in canvas space, y pointing down).
  function inject(spec) {
    const rgb = spec.color || hslToRgb(spec.h, spec.s, spec.l);
    const density = (spec.alpha || 0.4) * DYE_STRENGTH;
    const absorb = [density * (1 - rgb[0]), density * (1 - rgb[1]), density * (1 - rgb[2])];
    const point = toUv(spec.x, spec.y);
    const uvR = (spec.radius || 30) / size.cssH; // height-normalized (splat scales x by aspect)
    solver.splat("dye", point, absorb, Math.max(1e-4, (uvR * DYE_R) ** 2));

    const dir = spec.dir || [0, 0];
    const speed = spec.speed != null ? spec.speed : 0.5;
    const mag = VEL_MAG * speed;
    // Canvas y is down; sim uv y is up, so flip the y component of the impulse.
    const vel = [dir[0] * mag, -dir[1] * mag, 0];
    if (dir[0] !== 0 || dir[1] !== 0) {
      solver.splat("velocity", point, vel, Math.max(1e-4, (uvR * VEL_R) ** 2));
    }
  }

  // Percussion: a monochrome dye puff with a small outward velocity kick.
  function injectSplat(spec) {
    const ink = DRUM_INK[spec.drum] || DRUM_INK.snare;
    const rgb = hslToRgb(ink.h, ink.s, ink.l);
    const density = (spec.alpha || 0.4) * DYE_STRENGTH;
    const absorb = [density * (1 - rgb[0]), density * (1 - rgb[1]), density * (1 - rgb[2])];
    const point = toUv(spec.x, spec.y);
    const uvR = (spec.radius || 30) / size.cssH;
    solver.splat("dye", point, absorb, Math.max(1e-4, (uvR * DYE_R) ** 2));
    // A short downward-ish kick so drums punch into the field.
    solver.splat("velocity", point, [0, -VEL_MAG * 0.4, 0], Math.max(1e-4, (uvR * VEL_R) ** 2));
  }

  // Advance the simulation to song time `t` with fixed steps. Bounded so a large
  // jump (seek) can't lock the tab; if capped, snap the clock forward.
  function stepTo(t) {
    if (t <= simTime) return;
    let n = 0;
    while (simTime + SIM_DT <= t && n < MAX_STEPS) {
      solver.step(SIM_DT);
      simTime += SIM_DT;
      n++;
    }
    if (n >= MAX_STEPS) simTime = t;
  }

  function render() {
    solver.display(paper, size.w, size.h);
  }

  function clear() {
    solver.clear();
    simTime = 0;
  }

  function resize() {
    const next = sizeCanvas(canvas);
    if (!next.changed) {
      size = next;
      return;
    }
    size = next;
    solver.resize(size.cssW, size.cssH); // note: fluid state resets on resize
    simTime = 0;
  }

  return {
    isGL: true,
    canvas,
    dims: () => ({ width: size.cssW, height: size.cssH, dpr: size.dpr }),
    addBlot: (spec) => inject(spec),
    addSplat: (spec) => injectSplat(spec),
    bake: (spec) => inject(spec),
    bakeSplat: (spec) => injectSplat(spec),
    stepTo,
    render,
    clear,
    purge: () => {}, // no wet list to drop; the field is the painting
    resize,
  };
}
