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
  VORTICITY_FS,
  PRESSURE_FS,
  GRADIENT_FS,
  SPLAT_FS,
  CLEAR_FS,
  DISPLAY_FS,
} from "./shaders.js";

const SIM_RES = 320; // longest side of the velocity/pressure grid (cheap physics)
const DYE_RES = 1024; // longest side of the dye grid (high, so blooms aren't blocky)
const PRESSURE_ITERS = 22; // Jacobi iterations per step (incompressibility)
const PRESSURE_DECAY = 0.8; // reuse some of last step's pressure for faster solve
const VEL_DISSIPATION = 0.32; // how fast motion calms (higher = blooms settle, stay distinct)
const DYE_DISSIPATION = 0.11; // pigment fades slowly so the canvas never saturates to mud
const CURL_STRENGTH = 14.0; // vorticity confinement (wispy tendrils)

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
    vorticity: createProgram(gl, BASE_VS, VORTICITY_FS),
    pressure: createProgram(gl, BASE_VS, PRESSURE_FS),
    gradient: createProgram(gl, BASE_VS, GRADIENT_FS),
    splat: createProgram(gl, BASE_VS, SPLAT_FS),
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
  let velocity, dye, pressure, divergence, curl;

  // The velocity/pressure physics run at the cheap sim grid; the dye (what you
  // see) runs at a higher grid so blooms upscale smoothly instead of blocky.
  function allocFields() {
    velocity = makeDouble(gl, simW, simH);
    pressure = makeDouble(gl, simW, simH);
    divergence = createFBO(gl, simW, simH);
    curl = createFBO(gl, simW, simH);
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

    // Vorticity confinement (curl -> force).
    pass(P.curl, curl, () => tex(0, velocity.read.tex, P.curl, "u_velocity"));
    pass(P.vorticity, velocity.write, () => {
      tex(0, velocity.read.tex, P.vorticity, "u_velocity");
      tex(1, curl.tex, P.vorticity, "u_curl");
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
    display,
    resize,
    clear: clearAll,
    dims: () => ({ simW, simH }),
  };
}
