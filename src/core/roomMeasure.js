// core/roomMeasure.js — pure floor-plan geometry for a room polygon.
// A room is a plan polygon of {x,z} points (see createRoom in model.js). This module
// derives read-only measurements from that shape: floor area, wall perimeter, and a
// centroid for placing a label. It adds NO model fields — measurements are computed
// on demand from the existing points, so the Phase 1 save round-trip is untouched.
// ZERO Three.js and ZERO DOM (importing under Node is itself the separation guard).
//
// Convention: points are plan coordinates {x, z}; area is in m², perimeter in m. The
// polygon is treated as a closed loop (last point implicitly joins the first), matching
// how createRoom / buildFloorMesh already interpret the points.
import { formatArea, formatLength, UNIT } from './units.js';

// A polygon needs at least 3 points to enclose any area; anything less is degenerate.
function valid(points) {
  return Array.isArray(points) && points.length >= 3;
}

// Signed shoelace area (may be negative depending on winding); callers that want a
// magnitude use polygonArea. Kept separate so polygonCentroid can reuse the sign.
function signedArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

// Floor area (m²) via the shoelace formula. Absolute value, so winding (CW/CCW) doesn't
// matter — createRoom documents CCW but a hand-built or imported room may wind either way.
export function polygonArea(points) {
  if (!valid(points)) return 0;
  return Math.abs(signedArea(points));
}

// Perimeter (m): the total length of the closed boundary (every edge, including the
// closing edge back to the first point).
export function polygonPerimeter(points) {
  if (!valid(points)) return 0;
  let p = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    p += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return p;
}

// Area-weighted centroid {x,z} — where a room label sits so it reads inside the shape.
// Falls back to the vertex average for a degenerate (zero-area) polygon, so a label
// never lands at NaN/Infinity when the points are collinear or coincident.
export function polygonCentroid(points) {
  if (!valid(points)) {
    if (Array.isArray(points) && points.length) {
      const n = points.length;
      return {
        x: points.reduce((s, p) => s + p.x, 0) / n,
        z: points.reduce((s, p) => s + p.z, 0) / n,
      };
    }
    return { x: 0, z: 0 };
  }
  const a = signedArea(points);
  if (Math.abs(a) < 1e-9) {                       // collinear/degenerate — average the vertices
    const n = points.length;
    return {
      x: points.reduce((s, p) => s + p.x, 0) / n,
      z: points.reduce((s, p) => s + p.z, 0) / n,
    };
  }
  let cx = 0, cz = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    const cross = p.x * q.z - q.x * p.z;
    cx += (p.x + q.x) * cross;
    cz += (p.z + q.z) * cross;
  }
  return { x: cx / (6 * a), z: cz / (6 * a) };
}

// Describe a room's measurements for the inspector + plan label. Pure data: name, raw
// area/perimeter in SI, their display-formatted labels (metric or imperial, following
// the units toggle), and the centroid. Returns null for a room with no usable polygon.
export function describeRoom(room, units = UNIT.METRIC) {
  if (!room || !valid(room.points)) return null;
  const area = polygonArea(room.points);
  const perimeter = polygonPerimeter(room.points);
  return {
    name: room.name || 'Room',
    area,
    perimeter,
    areaLabel: formatArea(area, units),
    perimeterLabel: formatLength(perimeter, units),
    centroid: polygonCentroid(room.points),
  };
}
