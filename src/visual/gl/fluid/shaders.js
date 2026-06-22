// shaders.js — GLSL for the ink-in-water fluid solver (WebGL2 / GLSL ES 3.00).
//
// This is a textbook "stable fluids" solver (Stam): a velocity field carries a
// dye field around, the velocity is kept incompressible with a pressure solve,
// and vorticity confinement adds back the small curls that make ink billow and
// finger. A note injects a splat of dye (its color) plus a velocity impulse (its
// direction), and the simulation does the rest — the pigment flows, swirls, and
// mixes like real ink dropped in water instead of sitting where it landed.
//
// Fields are RGBA16F textures. The dye field stores per-channel "absorbance"
// (like the old renderer) so overlapping colors mix subtractively over paper and
// never stack to flat black. Only .x is used for the scalar fields (pressure,
// divergence, curl); velocity uses .xy.

// Vertex shader shared by every pass. It precomputes the four neighbour texel
// coordinates so the fragment shaders can read them without per-pixel math.
export const BASE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform vec2 u_texel;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
void main(){
  vUv = a_pos * 0.5 + 0.5;
  vL = vUv - vec2(u_texel.x, 0.0);
  vR = vUv + vec2(u_texel.x, 0.0);
  vT = vUv + vec2(0.0, u_texel.y);
  vB = vUv - vec2(0.0, u_texel.y);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Semi-Lagrangian advection: trace each cell backward along the velocity field
// and sample what was there. Used for both velocity (self-advection) and dye.
// The result is gently dissipated so motion and pigment settle over time.
export const ADVECT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_velocity;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_dt;
uniform float u_dissipation;
out vec4 frag;
void main(){
  vec2 coord = vUv - u_dt * texture(u_velocity, vUv).xy * u_texel;
  vec4 src = texture(u_source, coord);
  frag = src / (1.0 + u_dissipation * u_dt);
}
`;

// Divergence of the velocity field — how much each cell is a source or sink.
export const DIVERGENCE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL, vR, vT, vB;
uniform sampler2D u_velocity;
out vec4 frag;
void main(){
  float L = texture(u_velocity, vL).x;
  float R = texture(u_velocity, vR).x;
  float T = texture(u_velocity, vT).y;
  float B = texture(u_velocity, vB).y;
  float div = 0.5 * (R - L + T - B);
  frag = vec4(div, 0.0, 0.0, 1.0);
}
`;

// Curl (vorticity) of the velocity field — the local spin at each cell.
export const CURL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL, vR, vT, vB;
uniform sampler2D u_velocity;
out vec4 frag;
void main(){
  float L = texture(u_velocity, vL).y;
  float R = texture(u_velocity, vR).y;
  float T = texture(u_velocity, vT).x;
  float B = texture(u_velocity, vB).x;
  float curl = 0.5 * ((R - L) - (T - B));
  frag = vec4(curl, 0.0, 0.0, 1.0);
}
`;

// Vorticity confinement: push velocity back toward its own curls so the small
// swirls the pressure solve would otherwise smooth away survive. This is what
// gives ink its lacy, fingered tendrils. u_curlStrength controls how wispy.
export const VORTICITY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL, vR, vT, vB;
uniform sampler2D u_velocity;
uniform sampler2D u_curl;
uniform float u_curlStrength;
uniform float u_dt;
out vec4 frag;
void main(){
  float L = texture(u_curl, vL).x;
  float R = texture(u_curl, vR).x;
  float T = texture(u_curl, vT).x;
  float B = texture(u_curl, vB).x;
  float C = texture(u_curl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= u_curlStrength * C;
  force.y *= -1.0;
  vec2 vel = texture(u_velocity, vUv).xy + force * u_dt;
  vel = clamp(vel, -1000.0, 1000.0);
  frag = vec4(vel, 0.0, 1.0);
}
`;

// One Jacobi iteration of the pressure solve. Run several times per step to
// approach an incompressible (divergence-free) velocity field.
export const PRESSURE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL, vR, vT, vB;
uniform sampler2D u_pressure;
uniform sampler2D u_divergence;
out vec4 frag;
void main(){
  float L = texture(u_pressure, vL).x;
  float R = texture(u_pressure, vR).x;
  float T = texture(u_pressure, vT).x;
  float B = texture(u_pressure, vB).x;
  float div = texture(u_divergence, vUv).x;
  float p = (L + R + T + B - div) * 0.25;
  frag = vec4(p, 0.0, 0.0, 1.0);
}
`;

// Subtract the pressure gradient from velocity to make it divergence-free.
export const GRADIENT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL, vR, vT, vB;
uniform sampler2D u_pressure;
uniform sampler2D u_velocity;
out vec4 frag;
void main(){
  float L = texture(u_pressure, vL).x;
  float R = texture(u_pressure, vR).x;
  float T = texture(u_pressure, vT).x;
  float B = texture(u_pressure, vB).x;
  vec2 vel = texture(u_velocity, vUv).xy - 0.5 * vec2(R - L, T - B);
  frag = vec4(vel, 0.0, 1.0);
}
`;

// Inject a soft gaussian splat into a field (additive). For dye, u_value is the
// pigment absorbance; for velocity, u_value.xy is the impulse direction*speed.
export const SPLAT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_target;
uniform vec2 u_point;     // splat center, 0..1
uniform vec3 u_value;     // amount to add at the center
uniform float u_radius;   // gaussian falloff (uv^2 units)
uniform float u_aspect;   // width/height, to keep the splat round
out vec4 frag;
void main(){
  vec2 p = vUv - u_point;
  p.x *= u_aspect;
  float g = exp(-dot(p, p) / u_radius);
  vec3 base = texture(u_target, vUv).xyz;
  frag = vec4(base + g * u_value, 1.0);
}
`;

// Restrike fade: multiply the dye DOWN inside a soft gaussian footprint (1.0 at
// the edges, u_decay at the center). Run just before a struck note deposits, so
// replaying the same note fades its previous deposit and a single spot can never
// build up to flat black — yet notes at fresh positions keep their full residue.
export const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_target;
uniform vec2 u_point;     // fade center, 0..1
uniform float u_radius;   // gaussian falloff (uv^2 units)
uniform float u_aspect;   // width/height, to keep the footprint round
uniform float u_decay;    // center multiplier (e.g. 0.5 keeps half)
out vec4 frag;
void main(){
  vec2 p = vUv - u_point;
  p.x *= u_aspect;
  float g = exp(-dot(p, p) / u_radius);
  float m = mix(1.0, u_decay, g);
  frag = vec4(texture(u_target, vUv).xyz * m, 1.0);
}
`;

// Multiply a field by a constant (used to bleed off pressure between steps).
export const CLEAR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_target;
uniform float u_value;
out vec4 frag;
void main(){
  frag = texture(u_target, vUv) * u_value;
}
`;

// Display: turn accumulated dye absorbance into a paper color via Beer-Lambert,
// with a soft ceiling so dense overlaps stay deep and colored, never flat black.
export const DISPLAY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_dye;
uniform vec3 u_paper;
uniform vec2 u_dyeTexel; // 1/dye width,height — for the smoothing tap offsets
out vec4 frag;
vec3 dyeAt(vec2 uv){ return max(texture(u_dye, uv).rgb, 0.0); }
void main(){
  // A small 9-tap gaussian over the dye softens the cell-scale faceting left by
  // the coarser velocity grid, so blooms read as smooth ink rather than pixelated.
  vec2 o = u_dyeTexel * 1.4;
  vec3 A =
    4.0 * dyeAt(vUv) +
    2.0 * (dyeAt(vUv + vec2(o.x, 0.0)) + dyeAt(vUv - vec2(o.x, 0.0)) +
           dyeAt(vUv + vec2(0.0, o.y)) + dyeAt(vUv - vec2(0.0, o.y))) +
    1.0 * (dyeAt(vUv + o) + dyeAt(vUv - o) +
           dyeAt(vUv + vec2(o.x, -o.y)) + dyeAt(vUv + vec2(-o.x, o.y)));
  A /= 16.0;
  const float A_MAX = 3.2;
  A = A_MAX * (1.0 - exp(-A / A_MAX));
  vec3 c = u_paper * exp(-A);
  frag = vec4(c, 1.0);
}
`;
