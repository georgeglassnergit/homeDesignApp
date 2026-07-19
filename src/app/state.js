// App state + the Simple/Pro seam.
// Novice-first: Simple mode exposes a small, safe toolset; Pro reveals precision
// tools. This is the single gate the whole UI reads from (progressive disclosure).

import { UNIT } from '../core/units.js';
import { defaultSnapSettings, normalizeSnapSettings } from '../edit/snapping.js';

export const MODE = Object.freeze({ SIMPLE: 'simple', PRO: 'pro' });

// Every tool/panel declares the minimum tier it appears in. The UI (later phases)
// calls isAvailable(id, mode) to decide what to show — one place, no scattered ifs.
export const FEATURE_TIERS = Object.freeze({
  // always-on, novice-friendly
  'add-room-template': MODE.SIMPLE,
  'draw-wall':         MODE.SIMPLE,
  'place-door':        MODE.SIMPLE,
  'place-window':      MODE.SIMPLE,
  'furnish-photo-3d':  MODE.SIMPLE,   // the Meshy pipeline
  'orbit-walkthrough': MODE.SIMPLE,
  'templates':         MODE.SIMPLE,
  'materials-swatch':  MODE.SIMPLE,
  // revealed in Pro
  'exact-dimensions':  MODE.PRO,
  'snapping-constraints': MODE.PRO,
  'multi-level':       MODE.PRO,
  'roof-editor':       MODE.PRO,
  'code-checks':       MODE.PRO,      // ADA / building-code aware
  'ifc-export':        MODE.PRO,      // BIM interop
  'measure-tool':      MODE.PRO,
});

const TIER_RANK = { [MODE.SIMPLE]: 0, [MODE.PRO]: 1 };

export function isAvailable(featureId, mode) {
  const need = FEATURE_TIERS[featureId];
  if (need === undefined) return true; // unknown features default visible
  return TIER_RANK[mode] >= TIER_RANK[need];
}

export function availableTools(mode) {
  return Object.keys(FEATURE_TIERS).filter(id => isAvailable(id, mode));
}

// Tool ids the S1 interaction layer switches between (the state machine's states).
export const TOOL = Object.freeze({
  SELECT: 'select', DRAW_WALL: 'draw-wall', PLACE_DOOR: 'place-door', PLACE_WINDOW: 'place-window',
});
export const VIEW = Object.freeze({ EXTERIOR: 'exterior', CUTAWAY: 'cutaway' });
export const CAMERA = Object.freeze({ ORBIT: 'orbit', WALK: 'walk' });

export function createAppState(opts = {}) {
  return {
    mode: opts.mode || MODE.SIMPLE,
    units: opts.units || UNIT.METRIC,
    selection: null,
    activeTool: opts.activeTool || TOOL.SELECT,   // S1 tool state machine
    view: opts.view || VIEW.EXTERIOR,             // S5 exterior <-> cutaway (view pref)
    camera: opts.camera || CAMERA.ORBIT,          // S6 orbit <-> walk
    snap: normalizeSnapSettings(opts.snap || defaultSnapSettings()), // Pro snapping/constraint settings
    setMode(m) { this.mode = m; },
    setUnits(u) { this.units = u; },
    setTool(t) { this.activeTool = t; },
    setView(v) { this.view = v; },
    setCamera(c) { this.camera = c; },
    setSnap(patch) { this.snap = normalizeSnapSettings({ ...this.snap, ...patch }); return this.snap; },
  };
}
