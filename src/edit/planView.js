// edit/planView.js — the 2D top-down interaction surface (S2).
// VIEW-LAYER-CONTRACT.md §4: maps ONLY between screen and world; stores no geometry.
// The model in core/ stays the single source of truth (real-world meters).
//
// ZERO Three.js in here — this is pure screen<->world math + pure plan-space
// hit-testing against the plain model, so it is fully node-testable. (If this
// file ever imported three, the engine-independent test suite would fail to load.)

// ---- pure grid snapping (Simple mode; Pro uses units.parseLength for exact entry) ----
export function snap(pt, gridStep = 0.1) {
  return { x: Math.round(pt.x / gridStep) * gridStep, z: Math.round(pt.z / gridStep) * gridStep };
}

// ---- pure plan-space geometry (no viewport needed; directly testable) ----

// Closest point on segment a->b to p. Returns { dist, t, point } with t in [0,1].
export function pointToSegment(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + abx * t, z: a.z + abz * t };
  return { dist: Math.hypot(p.x - point.x, p.z - point.z), t, point };
}

// Nearest wall endpoint to `world` within `tol` meters (for corner dragging).
// Returns { wallId, end:'a'|'b', point, dist } or null.
export function nearestVertex(world, walls, tol = 0.25) {
  let best = null;
  for (const w of walls) {
    for (const end of ['a', 'b']) {
      const v = w[end];
      const d = Math.hypot(world.x - v.x, world.z - v.z);
      if (d <= tol && (!best || d < best.dist)) best = { wallId: w.id, end, point: { x: v.x, z: v.z }, dist: d };
    }
  }
  return best;
}

// All wall endpoints coincident with `pt` (within eps). Lets a corner-drag move
// every wall that shares that corner as one command (S2 acceptance).
export function verticesAt(pt, walls, eps = 1e-4) {
  const out = [];
  for (const w of walls) {
    for (const end of ['a', 'b']) {
      if (Math.hypot(w[end].x - pt.x, w[end].z - pt.z) <= eps) out.push({ wallId: w.id, end });
    }
  }
  return out;
}

// Nearest wall segment to `world` within `tol` meters (for placing an opening).
// Returns { wallId, offset, point, dist } where offset = distance from endpoint a
// along the wall to the hit — the model's opening-offset convention.
export function nearestWallHit(world, walls, tol = 0.3) {
  let best = null;
  for (const w of walls) {
    const r = pointToSegment(world, w.a, w.b);
    if (r.dist <= tol && (!best || r.dist < best.dist)) {
      const len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z);
      best = { wallId: w.id, offset: r.t * len, point: r.point, dist: r.dist };
    }
  }
  return best;
}

// ---- screen<->world viewport (top-down orthographic over the XZ plane) ----
// `pxPerMeter` sets zoom; `center` is the world point under the canvas center.
// Screen +y (downward) maps to world +z, matching the plan's top-down convention.
export function createPlanView({ width, height, pxPerMeter = 40, center = { x: 0, z: 0 } }) {
  const vp = { width, height, pxPerMeter, center: { x: center.x, z: center.z } };

  function screenToWorld(px, py) {
    return {
      x: vp.center.x + (px - vp.width / 2) / vp.pxPerMeter,
      z: vp.center.z + (py - vp.height / 2) / vp.pxPerMeter,
    };
  }
  function worldToScreen(pt) {
    return {
      px: vp.width / 2 + (pt.x - vp.center.x) * vp.pxPerMeter,
      py: vp.height / 2 + (pt.z - vp.center.z) * vp.pxPerMeter,
    };
  }
  // pixel tolerance -> world meters, so hit-tests feel consistent at any zoom.
  const toMeters = (px) => px / vp.pxPerMeter;

  return {
    vp,
    screenToWorld,
    worldToScreen,
    snap,
    toMeters,
    setViewport(next) { Object.assign(vp, next); },
    // pass-through pure hit-testers so callers use one object
    nearestVertex: (world, walls, tolPx = 12) => nearestVertex(world, walls, toMeters(tolPx)),
    nearestWallHit: (world, walls, tolPx = 12) => nearestWallHit(world, walls, toMeters(tolPx)),
    verticesAt,
  };
}
