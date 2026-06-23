// params.js — live, user-tunable painting parameters.
//
// Every fluid/ink dial lives here so the Tuning panel can change it at runtime.
// The solver and the ink injector read the CURRENT value from `params` each time
// they use it (not a frozen const captured at module load), so dragging a slider
// affects the running simulation immediately — and because the painting is the
// fluid FIELD (not a list of stamps), the ink already on screen re-evolves under
// the new physics on the next sim step.
//
// PARAM_GROUPS is the single source of truth: the panel UI is generated from it,
// and the defaults below ARE the values the app ships with. Change a default here
// and both the code behaviour and the panel's starting point move together.

export const PARAM_GROUPS = [
  {
    title: "Flow",
    note: "How the water itself behaves. Affects ink already on the page.",
    params: [
      { key: "velDissipation", label: "Velocity settle", min: 0, max: 4, step: 0.05, value: 0.4,
        help: "How fast the water's motion calms down. Higher = pushes fade quickly and the ink settles sooner." },
      { key: "dyeDissipation", label: "Ink fade", min: 0, max: 1, step: 0.005, value: 0.12,
        help: "How quickly pigment fades over time. Higher = ink thins out and disappears faster." },
      { key: "curlStrength", label: "Swirl / tendrils", min: 0, max: 40, step: 0.5, value: 2.5,
        help: "How much the flow curls into wisps and fingers. Higher = more swirling, lacy tendrils." },
      { key: "pressureIters", label: "Solver quality", min: 4, max: 40, step: 1, value: 25, int: true,
        help: "How hard the simulation works to keep the water realistic. Higher = smoother flow, a little heavier." },
      { key: "pressureDecay", label: "Pressure reuse", min: 0, max: 1, step: 0.02, value: 0,
        help: "Reuses the last frame's solve for speed. Higher = faster but the flow can look slightly looser." },
    ],
  },
  {
    title: "Ink per note",
    note: "How each new note is dropped. Affects future notes, not existing ink.",
    params: [
      { key: "velMag", label: "Push strength", min: 0, max: 600, step: 5, value: 600,
        help: "How hard each note shoves the ink. Higher = longer, more directional plumes." },
      { key: "dyeStrength", label: "Ink density", min: 0.2, max: 4, step: 0.05, value: 2,
        help: "How much pigment each note drops. Higher = bolder, darker ink." },
      { key: "dyeRadius", label: "Ink size", min: 0.2, max: 2.5, step: 0.05, value: 1.7,
        help: "Size of each note's ink blot. Higher = bigger blooms." },
      { key: "velRadius", label: "Push focus", min: 0.2, max: 3, step: 0.05, value: 3,
        help: "How wide the push is. Lower = a tight jet that shears ink into a tail; higher = a broad shove." },
      { key: "fadeDecay", label: "Restrike dim", min: 0, max: 1, step: 0.02, value: 0.5,
        help: "When a note repeats, how much of the old ink at that spot is kept. Higher = the old mark stays stronger." },
      { key: "fadeRadius", label: "Restrike area", min: 0.2, max: 3, step: 0.05, value: 1.25,
        help: "How wide the dimming reaches when a note is replayed at the same spot." },
    ],
  },
  {
    title: "Look",
    note: "How the accumulated ink is rendered. Affects everything instantly.",
    params: [
      { key: "inkDepth", label: "Ink depth", min: 0.5, max: 8, step: 0.1, value: 8,
        help: "How dark dense ink is allowed to get. Higher = deeper, richer overlaps." },
    ],
  },
  {
    title: "Containment",
    note: "The soft walls that keep ink from washing off the sheet.",
    params: [
      { key: "wallMargin", label: "Edge margin", min: 0, max: 0.4, step: 0.01, value: 0,
        help: "Width of the soft wall near each edge that keeps ink on the sheet. 0 = no wall." },
      { key: "wallFloor", label: "Edge flow", min: 0, max: 1, step: 0.05, value: 0.25,
        help: "How much flow is allowed right at the very edge. 0 = hard wall, 1 = ink can flow off freely." },
    ],
  },
  {
    title: "Resolution",
    note: "Grid detail. Higher = finer + heavier. Changing this rebuilds the field.",
    params: [
      { key: "simRes", label: "Sim grid", min: 128, max: 768, step: 64, value: 192, int: true, rebuild: true,
        help: "Detail of the water simulation. Higher = finer swirls but heavier on the GPU." },
      { key: "dyeRes", label: "Ink grid", min: 256, max: 2048, step: 128, value: 1152, int: true, rebuild: true,
        help: "Detail of the ink layer. Higher = sharper, smoother ink but heavier." },
    ],
  },
];

// Flatten defaults out of the group definitions so there is exactly one source.
const defaults = {};
for (const g of PARAM_GROUPS) for (const p of g.params) defaults[p.key] = p.value;

// The live values everything else reads. Seeded from the defaults.
export const params = { ...defaults };

const listeners = new Set();

// Subscribe to changes. Returns an unsubscribe function. Used by index.js to
// rebuild the field when a resolution dial moves.
export function onParamChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Update one value and notify. Out-of-range keys are ignored defensively so a
// stale panel can never inject a bad key.
export function setParam(key, value) {
  if (!(key in params)) return;
  params[key] = value;
  for (const fn of listeners) fn(key, value);
}

// Reset every value to its shipped default (the panel's Reset button).
export function resetParams() {
  for (const k in defaults) setParam(k, defaults[k]);
}

// A plain snapshot, for the "Copy values" button.
export function exportParams() {
  return { ...params };
}

export const PARAM_DEFAULTS = { ...defaults };
