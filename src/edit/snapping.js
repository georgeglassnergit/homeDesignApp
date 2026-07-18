// edit/snapping.js — pure snapping / constraint math (the Pro-seam "snapping-constraints").
// VIEW-LAYER-CONTRACT.md §4: this composes grid, vertex, and angle constraints into a
// single snapped point for the plan-view tools. It reads the plain model (walls) but
// stores no geometry and touches NO Three.js, so it loads in the engine-independent test
// suite — importing it under Node is itself the model/view-separation guard.
//
// Priority when several constraints are enabled, highest first:
//   1. vertex  — pull onto an existing corner (so drawn rooms close watertight, which the
//                CSG openings depend on) — this wins outright when a corner is in reach.
//   2. angle   — constrain the segment's direction from its anchor to a fixed increment
//                (ortho / 45°); the length is quantized to the grid when grid is also on.
//   3. grid    — round to the grid step.
// Before this slice, Simple mode grid-snapped and Pro mode used the raw point (no snap at
// all). Now all three are data-driven settings; Pro exposes them, Simple keeps safe
// defaults. The defaults preserve Simple's previously-verified grid behavior.

import { snap as gridSnap } from './planView.js';

// Safe defaults. Grid + vertex on keeps novice drawing forgiving and rooms watertight;
// angle is off by default (opt-in precision). Pro users edit every field live.
export function defaultSnapSettings() {
  return {
    grid:   { on: true,  step: 0.1 },   // meters between grid lines
    vertex: { on: true,  tol: 0.2 },    // meters — snap radius onto an existing corner
    angle:  { on: false, stepDeg: 45 }, // constrain a drawn segment to multiples of this
  };
}

// Clamp/normalize a settings object so bad UI input can never corrupt the math
// (non-positive grid/angle steps would divide-by-zero or loop). Returns a fresh object.
export function normalizeSnapSettings(s) {
  const d = defaultSnapSettings();
  s = s || d;
  return {
    grid:   { on: !!(s.grid && s.grid.on),   step: clampPos(s.grid && s.grid.step, d.grid.step) },
    vertex: { on: !!(s.vertex && s.vertex.on), tol: clampPos(s.vertex && s.vertex.tol, d.vertex.tol) },
    angle:  { on: !!(s.angle && s.angle.on),  stepDeg: clampAngle(s.angle && s.angle.stepDeg, d.angle.stepDeg) },
  };
}
function clampPos(v, fallback) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; }
function clampAngle(v, fallback) { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 180 ? n : fallback; }

// Nearest existing wall endpoint to `world` within `tol` meters. `excludeKeys` (a Set of
// "wallId:end") skips the endpoints currently being dragged, so a corner never snaps to
// itself. Returns { x, z, dist, key } or null.
export function nearestSnapVertex(world, walls, tol = 0.2, excludeKeys = null) {
  let best = null;
  for (const w of walls) {
    for (const end of ['a', 'b']) {
      const key = w.id + ':' + end;
      if (excludeKeys && excludeKeys.has(key)) continue;
      const v = w[end];
      const d = Math.hypot(world.x - v.x, world.z - v.z);
      if (d <= tol && (!best || d < best.dist)) best = { x: v.x, z: v.z, dist: d, key };
    }
  }
  return best;
}

// Constrain `target` to lie on a ray from `anchor` at the nearest multiple of `stepDeg`
// (measured in the XZ plane). When `lengthStep > 0` the distance along that ray is also
// quantized to the grid, so an ortho-drawn wall lands on both a clean angle and a clean
// length. A zero-length input returns the anchor unchanged.
export function constrainAngle(anchor, target, stepDeg = 45, lengthStep = 0) {
  const dx = target.x - anchor.x, dz = target.z - anchor.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-9) return { x: anchor.x, z: anchor.z };
  const stepRad = (stepDeg * Math.PI) / 180;
  const ang = Math.atan2(dz, dx);
  const snappedAng = Math.round(ang / stepRad) * stepRad;
  let len = dist;
  if (lengthStep > 0) len = Math.max(lengthStep, Math.round(dist / lengthStep) * lengthStep);
  return { x: anchor.x + Math.cos(snappedAng) * len, z: anchor.z + Math.sin(snappedAng) * len };
}

// Compose the enabled constraints for one pointer position.
//   settings    — { grid, vertex, angle } (normalized internally)
//   walls       — existing walls, for vertex snapping
//   anchor      — the fixed point the segment is drawn/dragged FROM (needed for angle snap)
//   excludeKeys — Set of "wallId:end" the vertex snap must ignore (the dragged corner)
// Returns { x, z, snapped: 'vertex' | 'angle' | 'grid' | null } — `snapped` lets the view
// give feedback about which constraint fired without re-deriving it.
export function snapPoint(world, { settings, walls = [], anchor = null, excludeKeys = null } = {}) {
  const s = normalizeSnapSettings(settings);
  // 1) vertex snap wins — closes rooms watertight
  if (s.vertex.on) {
    const v = nearestSnapVertex(world, walls, s.vertex.tol, excludeKeys);
    if (v) return { x: v.x, z: v.z, snapped: 'vertex' };
  }
  // 2) angle constraint (needs an anchor); quantize length to the grid when grid is on
  if (s.angle.on && anchor) {
    const p = constrainAngle(anchor, world, s.angle.stepDeg, s.grid.on ? s.grid.step : 0);
    return { x: p.x, z: p.z, snapped: 'angle' };
  }
  // 3) grid snap
  if (s.grid.on) {
    const p = gridSnap(world, s.grid.step);
    return { x: p.x, z: p.z, snapped: 'grid' };
  }
  return { x: world.x, z: world.z, snapped: null };
}
