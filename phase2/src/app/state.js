// app/state.js — mode + units + the Simple/Pro seam.
// The whole UI reads availability from isAvailable(tool, mode). Adding a tool = one line in FEATURE_TIERS.

export const MODES = { SIMPLE: 'simple', PRO: 'pro' };

// Minimum mode in which each tool appears (progressive disclosure).
export const FEATURE_TIERS = Object.freeze({
  select:        MODES.SIMPLE,
  orbit:         MODES.SIMPLE,
  template:      MODES.SIMPLE,
  drawWall:      MODES.SIMPLE,
  placeDoor:     MODES.SIMPLE,
  placeWindow:   MODES.SIMPLE,
  furnishPhoto:  MODES.SIMPLE,
  materials:     MODES.SIMPLE,
  viewToggle:    MODES.SIMPLE,   // exterior <-> cutaway
  walkthrough:   MODES.SIMPLE,
  // pro depth
  exactDims:     MODES.PRO,
  customOpening: MODES.PRO,
  snapConfig:    MODES.PRO,
  multiLevel:    MODES.PRO,
  roofEditor:    MODES.PRO,
  codeChecks:    MODES.PRO,
  ifcExport:     MODES.PRO,
  measure:       MODES.PRO,
});

const RANK = { [MODES.SIMPLE]: 0, [MODES.PRO]: 1 };

export function isAvailable(tool, mode) {
  const need = FEATURE_TIERS[tool];
  if (need == null) return false;
  return RANK[mode] >= RANK[need];
}

export function createAppState(opts = {}) {
  return {
    mode: opts.mode || MODES.SIMPLE,
    units: opts.units || 'metric',
    activeTool: 'select',
    viewMode: 'exterior',   // 'exterior' | 'cutaway'
    camera: 'orbit',        // 'orbit' | 'walk'
    selection: [],          // model ids
  };
}

export function toolsForMode(mode) {
  return Object.keys(FEATURE_TIERS).filter(t => isAvailable(t, mode));
}
