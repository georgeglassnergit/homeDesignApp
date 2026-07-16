// app/dirty.js — pure, engine-free "unsaved changes" tracking for the S4 template picker.
//
// The model is the single source of truth, so "dirty" needs no extra flags scattered
// through the edit layer: it's simply whether the current serialized project differs
// from the last clean baseline (the moment we loaded a template or the user saved).
// Reusing the Phase 1 lossless `serialize` as the identity function means a real edit
// (add/move/remove a wall or opening) flips it dirty and an undo-all flips it clean
// again for free. No Three.js, no DOM.

// Snapshot `json` as the clean baseline; `isDirty(current)` compares against it.
export function createDirtyTracker(baselineJson) {
  let baseline = baselineJson;
  return {
    markClean(json) { baseline = json; },
    isDirty(currentJson) { return currentJson !== baseline; },
    baseline() { return baseline; },
  };
}
