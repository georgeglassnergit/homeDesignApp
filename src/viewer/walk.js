// viewer/walk.js — PURE first-person walk-camera math. ZERO Three.js so it stays
// node-testable (importing it under Node is itself part of the separation guard).
//
// S6 walk-through: the camera is pure view state (no model fields). This module turns
// key/pointer input into plain {x, y, z, yaw, pitch} numbers; the view layer maps those
// onto the Three camera each frame. It never touches geometry or the Project model.
//
// Conventions (right-handed, +Y up, matching the builder's model→world XZ mapping):
//   yaw = 0  → look toward -Z;  yaw increases turning left (CCW seen from above).
//   forward horizontal = (-sin yaw, -cos yaw);  right = (cos yaw, -sin yaw).
//   look direction (with pitch) = (-sin yaw·cos pitch, sin pitch, -cos yaw·cos pitch).

export const EYE_HEIGHT = 1.6;             // camera height off the floor (m) — average eye level
export const WALK_SPEED = 3.0;             // m/s ground speed
export const LOOK_SENSITIVITY = 0.0025;    // radians per pixel of pointer drag
export const MAX_PITCH = Math.PI / 2 - 0.05; // clamp just shy of straight up/down

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Horizontal forward / right unit vectors in the XZ plane for a given yaw.
export function forwardXZ(yaw) { return { x: -Math.sin(yaw), z: -Math.cos(yaw) }; }
export function rightXZ(yaw) { return { x: Math.cos(yaw), z: -Math.sin(yaw) }; }

// Full look direction including pitch (unit vector). The view layer aims the camera at
// position + this vector.
export function lookDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

// Camera eye height for a level: its floor elevation + standing eye height.
export function eyeHeight(level) {
  return ((level && level.elevation) || 0) + EYE_HEIGHT;
}

// Axis-aligned footprint of a level's walls in the XZ plane, inset by `pad` so the walker
// stays off the exterior walls instead of wandering through them into the void. If the room
// is narrower than 2·pad on an axis the inset would invert — collapse that axis to its
// midpoint so clamping still yields a sane point inside the footprint.
export function levelBoundsXZ(walls, pad = 0) {
  if (!walls || walls.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const w of walls) {
    minX = Math.min(minX, w.a.x, w.b.x); maxX = Math.max(maxX, w.a.x, w.b.x);
    minZ = Math.min(minZ, w.a.z, w.b.z); maxZ = Math.max(maxZ, w.a.z, w.b.z);
  }
  let iMinX = minX + pad, iMaxX = maxX - pad, iMinZ = minZ + pad, iMaxZ = maxZ - pad;
  if (iMinX > iMaxX) { const m = (minX + maxX) / 2; iMinX = iMaxX = m; }
  if (iMinZ > iMaxZ) { const m = (minZ + maxZ) / 2; iMinZ = iMaxZ = m; }
  return { minX: iMinX, maxX: iMaxX, minZ: iMinZ, maxZ: iMaxZ };
}

// Clamp an XZ point into bounds (null bounds → unclamped copy).
export function clampToBounds(p, bounds) {
  if (!bounds) return { x: p.x, z: p.z };
  return { x: clamp(p.x, bounds.minX, bounds.maxX), z: clamp(p.z, bounds.minZ, bounds.maxZ) };
}

// Integrate one movement step. `keys` = {forward, back, left, right} booleans; `dt` in
// seconds. Diagonal input is normalized so moving two directions isn't faster than one.
// Pure translation in XZ — pitch never affects ground movement (you don't fly by looking up).
export function stepWalk(pos, yaw, keys, dt, speed = WALK_SPEED) {
  const f = forwardXZ(yaw), r = rightXZ(yaw);
  let dx = 0, dz = 0;
  if (keys.forward) { dx += f.x; dz += f.z; }
  if (keys.back) { dx -= f.x; dz -= f.z; }
  if (keys.right) { dx += r.x; dz += r.z; }
  if (keys.left) { dx -= r.x; dz -= r.z; }
  const len = Math.hypot(dx, dz);
  if (len > 1e-9) { const s = (speed * dt) / len; dx *= s; dz *= s; }
  return { x: pos.x + dx, z: pos.z + dz };
}

// Update yaw/pitch from a pointer drag delta (pixels). Dragging right turns right (yaw down),
// dragging up looks up (pitch up); pitch is clamped so you never flip over.
export function stepLook(look, dx, dy, sens = LOOK_SENSITIVITY) {
  return { yaw: look.yaw - dx * sens, pitch: clamp(look.pitch - dy * sens, -MAX_PITCH, MAX_PITCH) };
}
