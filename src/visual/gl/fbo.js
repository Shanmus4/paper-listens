// fbo.js — floating-point framebuffers for the pigment accumulation surface.
//
// Each FBO holds an RGBA16F texture. We accumulate absorbance additively into
// it (values can exceed 1.0), then a tonemap pass converts absorbance to a
// paper color. Float storage is what lets ink deepen smoothly instead of
// clipping. Two FBOs are used: a persistent "baked" painting and a per-frame
// "work" buffer (baked + the currently animating wet blots).

export function createFBO(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { fb, tex, w, h };
}

export function clearFBO(gl, fbo) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
  gl.viewport(0, 0, fbo.w, fbo.h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

export function deleteFBO(gl, fbo) {
  if (!fbo) return;
  gl.deleteTexture(fbo.tex);
  gl.deleteFramebuffer(fbo.fb);
}

// Copy one FBO's pixels into another of the same size (WebGL2 blit). Used to
// seed the per-frame work buffer from the baked painting.
export function blitFBO(gl, src, dst) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
  gl.blitFramebuffer(
    0, 0, src.w, src.h,
    0, 0, dst.w, dst.h,
    gl.COLOR_BUFFER_BIT, gl.NEAREST
  );
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}
