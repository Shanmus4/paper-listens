// solver.js — the stable-fluids simulation itself.
//
// Owns the GPU fields (velocity, dye, pressure, divergence, curl) and runs one
// fixed-timestep update over them. The fields live at a reduced "sim" resolution
// (cheaper, and the softness reads as watery diffusion); the display pass
// upscales the dye to the canvas with linear filtering. Everything here is
// resolution- and content-deterministic: same splats + same dt = same result.

import { createProgram } from "../program.js";
import { createFBO, deleteFBO } from "../fbo.js";
import {
  BASE_VS,
  ADVECT_FS,
  DIVERGENCE_FS,
  CURL_FS,
  BLUR_FS,
  VORTICITY_FS,
  PRESSURE_FS,
  GRADIENT_FS,
  SPLAT_FS,
  FADE_FS,
  CLEAR_FS,
  DISPLAY_FS,
} from "./shaders.js";

const SIM_RES = 512; // longest side of the velocity/pressure grid. Raised 320->512: the
// velocity field's swirls/vortices live at this scale, so a coarse grid made the ink fold
// into chunky "puzzle-piece" curls that read as pixelation once it evolved. 512 gives much
// finer swirls + finer fingered tendrils, closer to real ink. (Lower if a weak GPU stutters.)
const DYE_RES = 1536; // longest side of the dye grid (higher = smoother, less pixelated)
const PRESSURE_ITERS = 28; // Jacobi iterations per step. Bumped with the finer grid: pressure
// propagates one cell per iteration, so a bigger grid needs more iters to stay incompressible.
const PRESSURE_DECAY = 0.8; // reuse some of last step's pressure for faster solve
const VEL_DISSIPATION = 0.7; // sustained enough for ink to flow into swirled marbling ribbons,
// settling over ~1s. Low CURL (below) keeps the flow LAMINAR so colours stay distinct ribbons
// instead of turbulently mixing into pastel mush — that laminar quality is the marbling look.
const DYE_DISSIPATION = 0.04; // pigment persists (marbling ribbons stay) but fades slowly so a very
// long dense piece doesn't fully saturate. Low CURL is what prevents the mush now, not a fast fade,
// so this can stay low for lasting ribbons.
const CURL_STRENGTH = 8.0; // LOW on purpose: marbling is laminar. High curl was turbulent and mixed
// every colour into pastel mush; low curl keeps broad smooth ribbons that swirl but stay distinct.
// (Curl is still blurred before confinement — see step() — so no grid stipple.) Was the "pixelation":
// vorticity confinement amplifies whatever curl it sees, and at high strength it amplified its
// OWN grid-scale noise, which the long-lived dye folded into a stipple that built up over time.
// The curl is now box-blurred before confinement (see step()), so only the LARGE vortices are
// re-energised (the fingered tendrils) and the grid noise dies. That lets curl run this high for
// pronounced wavy/lacy tendrils while staying smooth — raising SIM_RES alone never fixed it.

// A read/write pair of same-size FBOs, swapped after each pass that writes it.
function makeDouble(gl, w, h) {
  return { read: createFBO(gl, w, h), write: createFBO(gl, w, h), w, h };
}
function swap(d) {
  const t = d.read;
  d.read = d.write;
  d.write = t;
}

export function createSolver(gl, canvas) {
  // Programs (all share BASE_VS).
  const P = {
    advect: createProgram(gl, BASE_VS, ADVECT_FS),
    divergence: createProgram(gl, BASE_VS, DIVERGENCE_FS),
    curl: createProgram(gl, BASE_VS, CURL_FS),
    blur: createProgram(gl, BASE_VS, BLUR_FS),
    vorticity: createProgram(gl, BASE_VS, VORTICITY_FS),
    pressure: createProgram(gl, BASE_VS, PRESSURE_FS),
    gradient: createProgram(gl, BASE_VS, GRADIENT_FS),
    splat: createProgram(gl, BASE_VS, SPLAT_FS),
    fade: createProgram(gl, BASE_VS, FADE_FS),
    clear: createProgram(gl, BASE_VS, CLEAR_FS),
    display: createProgram(gl, BASE_VS, DISPLAY_FS),
  };

  // Fullscreen quad shared by every pass (a_pos pinned to location 0).
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let simW = 0;
  let simH = 0;
  let dyeW = 0;
  let dyeH = 0;
  let texel = [0, 0]; // sim-grid texel; also the unit for advection displacement
  let velocity, dye, pressure, divergence, curl, curlSmooth;

  // The velocity/pressure physics run at the cheap sim grid; the dye (what you
  // see) runs at a higher grid so blooms upscale smoothly instead of blocky.
  function allocFields() {
    velocity = makeDouble(gl, simW, simH);
    pressure = makeDouble(gl, simW, simH);
    divergence = createFBO(gl, simW, simH);
    curl = createFBO(gl, simW, simH);
    curlSmooth = createFBO(gl, simW, simH);
    dye = makeDouble(gl, dyeW, dyeH);
  }
  function freeFields() {
    if (!velocity) return;
    for (const d of [velocity, dye, pressure]) {
      deleteFBO(gl, d.read);
      deleteFBO(gl, d.write);
    }
    deleteFBO(gl, divergence);
    deleteFBO(gl, curl);
    deleteFBO(gl, curlSmooth);
  }

  // Size both grids from the canvas aspect (longest side = the given res).
  function sizeFrom(cssW, cssH) {
    const aspect = cssW / Math.max(1, cssH);
    const dim = (res) =>
      aspect >= 1
        ? [res, Math.max(4, Math.round(res / aspect))]
        : [Math.max(4, Math.round(res * aspect)), res];
    [simW, simH] = dim(SIM_RES);
    [dyeW, dyeH] = dim(DYE_RES);
    texel = [1 / simW, 1 / simH];
  }

  function init(cssW, cssH) {
    sizeFrom(cssW, cssH);
    allocFields();
    clearAll();
  }

  // Bind a texture to a unit and point a sampler uniform at it.
  function tex(unit, t, prog, name) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(prog.loc(name), unit);
  }

  // Run one program into a target FBO at sim resolution. `setup` binds the
  // program-specific uniforms/textures.
  function pass(prog, target, setup) {
    gl.useProgram(prog.program);
    gl.uniform2f(prog.loc("u_texel"), texel[0], texel[1]);
    if (setup) setup();
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  function clearAll() {
    for (const d of [velocity, dye, pressure]) {
      for (const f of [d.read, d.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
        gl.viewport(0, 0, f.w, f.h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // One fixed-timestep update of the whole fluid.
  function step(dt) {
    gl.disable(gl.BLEND);

    // Advect velocity through itself.
    pass(P.advect, velocity.write, () => {
      tex(0, velocity.read.tex, P.advect, "u_velocity");
      tex(1, velocity.read.tex, P.advect, "u_source");
      gl.uniform1f(P.advect.loc("u_dt"), dt);
      gl.uniform1f(P.advect.loc("u_dissipation"), VEL_DISSIPATION);
    });
    swap(velocity);

    // Vorticity confinement (curl -> force). The curl is box-blurred first so
    // confinement re-energises only the large vortices (fingered tendrils) and
    // not the grid-scale noise that would otherwise stipple the dye.
    pass(P.curl, curl, () => tex(0, velocity.read.tex, P.curl, "u_velocity"));
    pass(P.blur, curlSmooth, () => tex(0, curl.tex, P.blur, "u_src"));
    pass(P.vorticity, velocity.write, () => {
      tex(0, velocity.read.tex, P.vorticity, "u_velocity");
      tex(1, curlSmooth.tex, P.vorticity, "u_curl");
      gl.uniform1f(P.vorticity.loc("u_curlStrength"), CURL_STRENGTH);
      gl.uniform1f(P.vorticity.loc("u_dt"), dt);
    });
    swap(velocity);

    // Project to divergence-free: divergence, pressure solve, subtract gradient.
    pass(P.divergence, divergence, () => tex(0, velocity.read.tex, P.divergence, "u_velocity"));
    pass(P.clear, pressure.write, () => {
      tex(0, pressure.read.tex, P.clear, "u_target");
      gl.uniform1f(P.clear.loc("u_value"), PRESSURE_DECAY);
    });
    swap(pressure);
    for (let i = 0; i < PRESSURE_ITERS; i++) {
      pass(P.pressure, pressure.write, () => {
        tex(0, pressure.read.tex, P.pressure, "u_pressure");
        tex(1, divergence.tex, P.pressure, "u_divergence");
      });
      swap(pressure);
    }
    pass(P.gradient, velocity.write, () => {
      tex(0, pressure.read.tex, P.gradient, "u_pressure");
      tex(1, velocity.read.tex, P.gradient, "u_velocity");
    });
    swap(velocity);

    // Advect dye through the (now incompressible) velocity field.
    pass(P.advect, dye.write, () => {
      tex(0, velocity.read.tex, P.advect, "u_velocity");
      tex(1, dye.read.tex, P.advect, "u_source");
      gl.uniform1f(P.advect.loc("u_dt"), dt);
      gl.uniform1f(P.advect.loc("u_dissipation"), DYE_DISSIPATION);
    });
    swap(dye);
  }

  // Inject a gaussian splat into a field. point = [u,v] in 0..1, value = vec3.
  function splat(field, point, value, radius) {
    const d = field === "dye" ? dye : velocity;
    pass(P.splat, d.write, () => {
      tex(0, d.read.tex, P.splat, "u_target");
      gl.uniform2f(P.splat.loc("u_point"), point[0], point[1]);
      gl.uniform3f(P.splat.loc("u_value"), value[0], value[1], value[2]);
      gl.uniform1f(P.splat.loc("u_radius"), radius);
      gl.uniform1f(P.splat.loc("u_aspect"), d.w / d.h);
    });
    swap(d);
  }

  // Fade the dye field down inside a gaussian footprint (restrike decay). Used
  // before a struck note deposits, so replaying the same note dims its previous
  // mark and one spot can't build to black. point = [u,v], decay = center factor.
  function fade(point, radius, decay) {
    pass(P.fade, dye.write, () => {
      tex(0, dye.read.tex, P.fade, "u_target");
      gl.uniform2f(P.fade.loc("u_point"), point[0], point[1]);
      gl.uniform1f(P.fade.loc("u_radius"), radius);
      gl.uniform1f(P.fade.loc("u_aspect"), dye.w / dye.h);
      gl.uniform1f(P.fade.loc("u_decay"), decay);
    });
    swap(dye);
  }

  // Fade the WHOLE dye field by a constant (0..1). Used by the New Sheet wash to
  // dissolve the painting to nothing while it streams away.
  function drainDye(factor) {
    pass(P.clear, dye.write, () => {
      tex(0, dye.read.tex, P.clear, "u_target");
      gl.uniform1f(P.clear.loc("u_value"), factor);
    });
    swap(dye);
  }

  // Tonemap the dye to the screen over the paper color.
  function display(paper, devW, devH) {
    gl.useProgram(P.display.program);
    gl.uniform2f(P.display.loc("u_texel"), texel[0], texel[1]);
    tex(0, dye.read.tex, P.display, "u_dye");
    gl.uniform3f(P.display.loc("u_paper"), paper[0], paper[1], paper[2]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, devW, devH);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  function resize(cssW, cssH) {
    freeFields();
    init(cssW, cssH);
  }

  return {
    init,
    step,
    splat,
    fade,
    drainDye,
    display,
    resize,
    clear: clearAll,
    dims: () => ({ simW, simH }),
  };
}
