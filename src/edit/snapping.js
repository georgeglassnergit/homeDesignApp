// edit/snapping.js — pure snapping/constraint math for the plan-view drawing tools.
// VIEW-LAYER-CONTRACT.md §4: pure screen<->world/plan-space math, stores no geometry,
// ZERO Three.js and ZERO DOM. Importing under Node is itself the separation guard.
//
// The Simple/Pro seam: Simple mode uses a fixed grid snap (unchanged from S2). Pro mode
// exposes THESE settings so a precision user can control three independent constraints —
// grid step, angle increment (ortho / 45°), and endpoint (snap onto an existing corner).
// This is the tier-table row "Snapping/constraint settings — Pro". All of it lives in one
// pure function so the tool controller carries no scattered snapping conditionals.

// Default Pro snapping settings. Endpoint wins over angle wins over grid (see snapPoint).
export function defaultSnapSettings() {
  return {
    grid: true, gridStep: 0.1,       // metres; quantize free points (and lengths under angle-lock)
    angle: true, angleStep: 45,      // degrees; lock the drawn direction to 0/45/90… off the anchor
    endpoint: true, endpointTol: 0.25, // metres; land exactly on an existing wall corner within this radius
  };
}

// Normalize/guard a settings object so a bad value can never corrupt the point math.
export function normalizeSnapSettings(s = {}) {
  const d = defaultSnapSettings();
  const step = Number(s.gridStep);
  const ang = Number(s.angleStep);
  const tol = Number(s.endpointTol);
  return {
    grid: s.grid !== undefined ? !!s.grid : d.grid,
    gridStep: Number.isFinite(step) && step > 0 ? step : d.gridStep,
    angle: s.angle !== undefined ? !!s.angle : d.angle,
    angleStep: Number.isFinite(ang) && ang > 0 && ang <= 180 ? ang : d.angleStep,
    endpoint: s.endpoint !== undefined ? !!s.endpoint : d.endpoint,
    endpointTol: Number.isFinite(tol) && tol >= 0 ? tol : d.endpointTol,
  };
}

// Nearest of `points` to `p` within `tol` metres, or null.
function nearestWithin(p, points, tol) {
  let best = null;
  for (const q of points) {
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (d <= tol && (!best || d < best.dist)) best = { point: { x: q.x, z: q.z }, dist: d };
  }
  return best;
}

// Round the anchor->p direction to the nearest `stepDeg` increment, keeping the length.
function constrainAngle(anchor, p, stepDeg) {
  const dx = p.x - anchor.x, dz = p.z - anchor.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-9) return { x: p.x, z: p.z };
  const inc = (stepDeg * Math.PI) / 180;
  const ang = Math.round(Math.atan2(dz, dx) / inc) * inc;
  return { x: anchor.x + Math.cos(ang) * dist, z: anchor.z + Math.sin(ang) * dist };
}

// Quantize the anchor->p LENGTH to `step`, keeping the (already angle-locked) direction.
function snapDistanceOnRay(anchor, p, step) {
  const dx = p.x - anchor.x, dz = p.z - anchor.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-9) return { x: p.x, z: p.z };
  const snapped = Math.round(dist / step) * step;
  return { x: anchor.x + (dx / dist) * snapped, z: anchor.z + (dz / dist) * snapped };
}

// Quantize a free point to the grid.
export function snapToGrid(p, step = 0.1) {
  return { x: Math.round(p.x / step) * step, z: Math.round(p.z / step) * step };
}

// The one entry point the tool controller calls. Given a raw world point, the active
// settings, and drawing context, return the snapped point plus which constraints fired.
//
//   ctx.anchor    — the point the current segment starts from (chain prev / drag origin);
//                   enables angle-lock. Omit for a free point (grid/endpoint still apply).
//   ctx.vertices  — existing corners to snap onto (endpoint snap). Exclude the vertex being
//                   dragged so a corner never snaps to itself.
//
// Precedence: endpoint (exact corner) > angle-lock (+ length grid) > free grid. Endpoint
// wins because landing on an existing corner is the intent that closes a room cleanly.
export function snapPoint(raw, settings, ctx = {}) {
  const s = normalizeSnapSettings(settings);
  const snapped = { endpoint: false, angle: false, grid: false };

  if (s.endpoint && ctx.vertices && ctx.vertices.length) {
    const hit = nearestWithin(raw, ctx.vertices, s.endpointTol);
    if (hit) return { point: hit.point, snapped: { ...snapped, endpoint: true } };
  }

  let p = { x: raw.x, z: raw.z };
  if (s.angle && ctx.anchor) {
    p = constrainAngle(ctx.anchor, p, s.angleStep);
    snapped.angle = true;
    if (s.grid) { p = snapDistanceOnRay(ctx.anchor, p, s.gridStep); snapped.grid = true; }
  } else if (s.grid) {
    p = snapToGrid(p, s.gridStep);
    snapped.grid = true;
  }
  return { point: p, snapped };
}
