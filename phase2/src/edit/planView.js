// edit/planView.js — STUB (UNVERIFIED: needs the view environment).
// See VIEW-LAYER-CONTRACT.md §4. Maps ONLY between screen and world (top-down). Stores no geometry.

export function screenToWorld(/* px, py, camera/viewport */) {
  throw new Error('planView.screenToWorld: not implemented (view layer)');
}
export function worldToScreen(/* pt, camera/viewport */) {
  throw new Error('planView.worldToScreen: not implemented (view layer)');
}

// Grid snapping is pure — safe to use now (Simple mode). Pro mode uses units.parseLength for exact entry.
export function snap(pt, gridStep = 0.1) {
  return { x: Math.round(pt.x / gridStep) * gridStep, z: Math.round(pt.z / gridStep) * gridStep };
}
