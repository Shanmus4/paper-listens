// onset.js — decides *when* to paint.
//
// A held note or a sustained chord should paint once, at the moment it starts,
// not on every frame. We detect that moment from spectral flux (how much new
// energy just appeared) using an adaptive threshold.
//
// The baseline uses the median + MAD (median absolute deviation), not the
// mean + std. That matters: onsets are themselves large flux spikes, and a
// mean-based baseline gets dragged up by recent spikes until repeated, equal
// strums stop registering. The median ignores those spikes, so a steady
// rhythm keeps painting.

const HISTORY = 43; // ~1 second of flux frames
const WARMUP = 8; // frames before we trust the statistics
const DEBOUNCE_MS = 60; // minimum gap between onsets
const MIN_RMS = 0.006; // ignore room noise / silence
const MIN_RATIO = 1.4; // flux must clear this multiple of the median
const MAD_TO_STD = 1.4826; // scales MAD to a std-equivalent for normal data

export function createOnsetDetector({ sensitivity = 0.5, minRms = MIN_RMS } = {}) {
  const history = [];
  let lastOnsetMs = -Infinity;
  let sens = sensitivity;
  const minRms_ = minRms; // per-source loudness floor (mic uses a lower one)

  function median(sortedArr) {
    const n = sortedArr.length;
    const mid = n >> 1;
    return n % 2 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  }

  // Robust baseline: median level and median absolute deviation.
  function robustStats() {
    const sorted = [...history].sort((a, b) => a - b);
    const med = median(sorted);
    const devs = history.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    return { med, mad: median(devs) };
  }

  // Returns an onset object { strength } on an onset frame, else null.
  function process(flux, rms, nowMs) {
    let onset = null;

    if (history.length >= WARMUP && rms > minRms_) {
      const { med, mad } = robustStats();
      // More sensitivity -> lower bar. k spans ~4.5 (picky) to ~1.5 (eager).
      const k = 1.5 + (1 - sens) * 3;
      const threshold = med * MIN_RATIO + k * mad * MAD_TO_STD;

      if (flux > threshold && nowMs - lastOnsetMs > DEBOUNCE_MS) {
        lastOnsetMs = nowMs;
        onset = { strength: flux / (med + 1e-9) };
      }
    }

    history.push(flux);
    if (history.length > HISTORY) history.shift();
    return onset;
  }

  function setSensitivity(value) {
    sens = Math.max(0, Math.min(1, value));
  }

  return { process, setSensitivity };
}
