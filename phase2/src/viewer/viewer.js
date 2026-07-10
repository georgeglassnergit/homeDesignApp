// viewer/viewer.js — STUB (UNVERIFIED: needs Three.js + the Phase 0/1 environment).
// See VIEW-LAYER-CONTRACT.md §6. Renderer/camera/controls/lights/framing + view modes + walk camera.
// import * as THREE from 'three';

export function setViewMode(/* scene, mode 'exterior'|'cutaway' */) {
  // cutaway hides roof + far walls (see platform/phase1-interior.png). Display pref only — no geometry change.
  throw new Error('viewer.setViewMode: not implemented (view layer)');
}

export function setCamera(/* mode 'orbit'|'walk' */) {
  // walk = first-person, ~1.6 m eye height, WASD move + pointer look, clamped to level; Esc -> orbit.
  throw new Error('viewer.setCamera: not implemented (view layer)');
}
