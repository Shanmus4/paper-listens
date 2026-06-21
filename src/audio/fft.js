// fft.js — a small, fast radix-2 FFT for magnitude spectra.
//
// We need a high-resolution magnitude spectrum for polyphonic pluck detection
// (see polypitch.js). Meyda can produce one, but switching its window size every
// frame reallocates its FFT and is slow, so we keep our own fixed-size transform.
// Precomputes bit-reversal indices and twiddle factors once; mag() then applies a
// Hann window and returns the linear magnitude of the first size/2 bins.

export function createMagFFT(size) {
  if ((size & (size - 1)) !== 0) throw new Error("fft size must be a power of 2");
  const half = size >> 1;

  // Bit-reversal permutation table.
  const rev = new Uint32Array(size);
  let bits = 0;
  for (let t = size; t > 1; t >>= 1) bits++;
  for (let i = 0; i < size; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }

  // Twiddle factors.
  const cosT = new Float32Array(half);
  const sinT = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const a = (-2 * Math.PI * i) / size;
    cosT[i] = Math.cos(a);
    sinT[i] = Math.sin(a);
  }

  // Hann window (reduces spectral leakage so harmonic peaks stay sharp).
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));

  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const out = new Float32Array(half);

  // input: Float32Array of length `size` (time domain). Returns linear magnitude
  // of bins 0..size/2-1 (reused buffer — copy if you need to keep it).
  function mag(input) {
    for (let i = 0; i < size; i++) {
      const j = rev[i];
      re[i] = input[j] * win[j];
      im[i] = 0;
    }
    for (let len = 2; len <= size; len <<= 1) {
      const halfLen = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len) {
        let k = 0;
        for (let j = i; j < i + halfLen; j++) {
          const c = cosT[k];
          const s = sinT[k];
          const tr = re[j + halfLen] * c - im[j + halfLen] * s;
          const ti = re[j + halfLen] * s + im[j + halfLen] * c;
          re[j + halfLen] = re[j] - tr;
          im[j + halfLen] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
          k += step;
        }
      }
    }
    for (let i = 0; i < half; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  }

  return { mag, size, half };
}
