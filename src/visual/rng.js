// rng.js — a tiny seeded random generator (mulberry32).
//
// Used so a blot or splatter keeps the same shape every frame (seeded by its
// spec) and so an uploaded song can paint identically each time (seeded by a
// hash of the audio). Takes a 0..1 float seed.

export function seededRng(seed) {
  let s = Math.floor(seed * 4294967296) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
