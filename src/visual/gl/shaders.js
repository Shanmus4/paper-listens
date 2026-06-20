// shaders.js — GLSL (WebGL2 / GLSL ES 3.00) for the ink renderer.
//
// Two draw kinds share this file:
//   1. Blot pass: draws one ink drop into the float absorbance buffer. The drop
//      is built procedurally from a seed so it is identical every rebuild
//      (determinism). Domain-warped fractal noise gives the billowing fingering
//      of ink spreading in water; a denser core pools the pigment; the rim
//      feathers out. `u_progress` (0..1) blooms the drop over its lifetime.
//   2. Tonemap pass: converts accumulated absorbance A to a paper color via
//      Beer-Lambert (color = paper * exp(-A)). Because absorption is per-channel
//      and tinted by each note's hue, repeated hits deepen toward a rich dark
//      version of the note's own color and then saturate — they never stack to
//      flat black the way multiply blending did.

// ---- shared noise (value-noise fbm) ----
const NOISE = /* glsl */ `
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.02; a *= 0.5; }
  return s;
}
`;

// A quad placed at u_center with half-extent u_radius (device px). v_uv spans
// [-1,1] across the quad so the fragment shader works in unit blot space.
export const BLOT_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform vec2 u_center;
uniform float u_radius;
uniform vec2 u_res;
out vec2 v_uv;
void main(){
  v_uv = a_pos;
  vec2 px = u_center + a_pos * u_radius;
  vec2 clip = (px / u_res) * 2.0 - 1.0;
  clip.y = -clip.y;          // device pixels are top-left origin
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

export const BLOT_FS = /* glsl */ `#version 300 es
precision highp float;
${NOISE}
in vec2 v_uv;
uniform vec3 u_color;     // pigment color, linear-ish 0..1
uniform float u_seed;     // 0..1, fixes the shape
uniform float u_strength; // overall density (loudness)
uniform float u_progress; // 0..1 bloom over lifetime
uniform float u_edge;     // 0=soft round bloom, 1=sharp fingering (timbre)
uniform float u_grain;    // 0..1 granulation speckle (noisiness)
uniform vec2 u_flow;      // plume direction * magnitude (~0..0.8) in unit space
out vec4 frag;

void main(){
  vec2 uv = v_uv;
  vec2 so = vec2(u_seed * 37.0, u_seed * 91.0 + 4.0); // seed offset

  // The quad is padded to BLOT_EXTENT (2.2) times the spec radius so tendrils
  // have room to reach past the body. unit is that fraction (1/2.2), so a fully
  // bloomed drop's body radius equals the spec radius in pixels.
  float unit = 1.0 / 2.2;

  // Flow basis: real ink in water billows in a direction, not as a symmetric
  // disc. fdir is the plume axis, perp is across it, fl is how hard it streaks.
  float fl = length(u_flow);
  vec2 fdir = fl > 1e-4 ? u_flow / fl : vec2(0.0, 1.0);
  vec2 perp = vec2(-fdir.y, fdir.x);

  // Advect the fingering noise downstream so tendrils trail behind the head
  // instead of radiating evenly. Advection grows as the drop blooms.
  vec2 adv = fdir * (fl * (0.25 + 0.75 * u_progress));

  // Domain warp: push sample coords around with fbm so the outline billows and
  // fingers like ink in water. More warp + higher frequency for bright timbres.
  float warp = mix(0.18, 0.5, u_edge) * (0.55 + 0.45 * u_progress) * unit;
  float freq = mix(1.6, 3.4, u_edge);
  vec2 w = vec2(fbm(uv * freq + so - adv * 2.0), fbm(uv * freq + so + 7.3 - adv * 1.5)) - 0.5;
  // Bias the warp downstream so the fingering streaks along the flow axis.
  vec2 q = uv + warp * w + fdir * (warp * 1.4 * fl) * (fbm(uv * freq * 1.3 + so) - 0.35);

  // Drift the body downstream as it blooms: a comet head leads, the tail trails.
  q -= fdir * (fl * 0.35 * u_progress) * unit;

  // Anisotropic metric: stretch the body along the flow axis so it reads as an
  // elongated plume rather than a round splat.
  float along = dot(q, fdir);
  float across = dot(q, perp);
  float d = length(vec2(across, along / (1.0 + fl * 0.7)));

  // Bloom: the effective radius and edge feather both grow as the drop ages.
  float rEff = mix(0.55, 1.0, u_progress) * unit;
  float feather = mix(0.16, 0.45, u_progress) * unit;
  float field = 1.0 - smoothstep(rEff - feather, rEff, d);

  // Ragged tendril edge: modulate the body by finer noise near the rim.
  float edgeN = fbm(uv * mix(3.5, 7.5, u_edge) + so * 1.7);
  field *= mix(1.0, edgeN + 0.25, 0.6 * u_edge);

  // Pooled darker core where pigment settles.
  float poolD = 1.0 - smoothstep(0.0, rEff * 0.55, d);

  float density = field * 0.85 + poolD * 0.5;

  // Granulation: subtract speckle so noisy sounds look grainy, not smooth.
  float g = fbm(uv * 22.0 + so);
  density *= 1.0 - u_grain * 0.45 * step(0.55, g);

  density = max(density, 0.0) * u_strength;
  if (density <= 0.0) discard;

  // Absorbance is tinted by the pigment: a note removes the channels its color
  // lacks, so accumulation deepens the hue instead of crushing to black.
  vec3 absorb = density * (1.0 - u_color);
  frag = vec4(absorb, density);
}
`;

// Decay-on-restrike pass: multiplies the pigment already in a blot's footprint
// by u_decay (< 1) just before the new blot is added on top. This is what keeps
// a repeatedly-struck cell from marching to flat black. Old pigment fades
// geometrically (A_n = decay * A_{n-1} + s), settling at a finite tone
// A* = s / (1 - decay), so it never reaches zero and never reaches black. The
// soft footprint matches a fully-bloomed blot body so the knock-back is local.
export const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_decay;    // 0..1 multiply factor at the footprint center
out vec4 frag;
void main(){
  float unit = 1.0 / 2.2;
  float d = length(v_uv);
  float r = 1.05 * unit;
  float mask = 1.0 - smoothstep(r * 0.25, r, d);
  vec3 factor = vec3(mix(1.0, u_decay, mask));
  frag = vec4(factor, 1.0);
}
`;

// Fullscreen triangle/quad for the tonemap pass.
export const QUAD_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const TONEMAP_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_paper;
out vec4 frag;
void main(){
  vec3 A = texture(u_tex, v_uv).rgb;
  // Soft ceiling on absorbance: as a cell is hit over and over, its color
  // plateaus at a deep, still-tinted tone instead of marching to flat black.
  // Light blots are unaffected (A' ~= A for small A).
  const float A_MAX = 3.2;
  A = A_MAX * (1.0 - exp(-A / A_MAX));
  vec3 c = u_paper * exp(-A);
  frag = vec4(c, 1.0);
}
`;
