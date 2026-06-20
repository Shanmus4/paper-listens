// program.js — small helpers to compile and link GLSL programs and to cache
// uniform/attribute locations. Keeps ink.js free of boilerplate.

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("Shader compile failed: " + log);
  }
  return sh;
}

// Build a program from vertex + fragment source. Returns the program plus a
// `loc(name)` helper that resolves and caches uniform/attribute locations.
export function createProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error("Program link failed: " + log);
  }

  const cache = new Map();
  function loc(name) {
    if (cache.has(name)) return cache.get(name);
    // Uniforms and attributes share one lookup helper; attributes return -1 if
    // they aren't an active uniform, so try the attribute table too.
    let l = gl.getUniformLocation(prog, name);
    if (l === null) l = gl.getAttribLocation(prog, name);
    cache.set(name, l);
    return l;
  }

  return { program: prog, loc };
}
