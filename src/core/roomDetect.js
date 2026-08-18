// Auto room detection — derive closed room polygons from a set of wall centrelines.
// Pure geometry / graph code: NO Three.js, NO model mutation, NO save-field. A companion to
// the model.js polygon helpers (polygonArea/pointInPolygon), engine-independent and verified
// with plain Node (src/test/room-detect.test.mjs).
//
// A4 (PHASE-3-PLAN.md): hand-drawn walls that enclose a space should become a *measurable*
// room without the user hand-tracing a floor polygon. We treat the wall centrelines as a
// planar straight-line graph and enumerate its bounded faces (the minimal cycles). Each bounded
// face is a room candidate; the single unbounded face (the outer boundary) is discarded.
//
// Robustness handled here:
//   • coincident endpoints are merged within a tolerance (walls snapped to a grid still land a
//     hair apart after float math), so a shared corner is ONE graph node;
//   • a wall whose endpoint lands part-way along another wall (a T-junction) splits that wall,
//     so the junction is a real node and the faces on both sides close;
//   • dangling walls / spurs trace an out-and-back degenerate face (zero area) and are dropped;
//   • duplicate/zero-length walls are ignored.
//
// NOT handled (out of scope — Group C territory, and the CSG guardrails already prefer clean
// corners): two walls that cross scissor-style with no shared endpoint are not split at the
// crossing. Such inputs simply yield no face through the crossing; they never crash.
//
// The detector is derived-on-read: it returns plain {points:[{x,z}...]} polygons. A caller wires
// them to createRoom(...) if/when it wants named, saved rooms — detection itself stores nothing.

import { polygonArea, polygonCentroid, pointInPolygon } from './model.js';

export const DEFAULT_TOL = 1e-3;       // 1 mm: merge endpoints closer than this into one node
export const DEFAULT_MIN_AREA = 1e-4;  // drop faces below 0.0001 m² (spurs / float slivers)

// squared distance between two {x,z} points
function d2(p, q) { const dx = p.x - q.x, dz = p.z - q.z; return dx * dx + dz * dz; }

// Distance (and parameter t) from point p to segment a→b, plus whether p lies ON the segment
// strictly between the endpoints (used for T-junction splitting).
function pointOnSegment(p, a, b, tol) {
  const vx = b.x - a.x, vz = b.z - a.z;
  const len2 = vx * vx + vz * vz;
  if (len2 < tol * tol) return null;                 // degenerate segment
  let t = ((p.x - a.x) * vx + (p.z - a.z) * vz) / len2;
  if (t <= 0 || t >= 1) return null;                 // at/beyond an endpoint — not an interior split
  const projx = a.x + t * vx, projz = a.z + t * vz;
  const dist2 = (p.x - projx) * (p.x - projx) + (p.z - projz) * (p.z - projz);
  if (dist2 > tol * tol) return null;                // not on the line
  // keep it clear of the endpoints by more than tol (avoid splitting at a shared corner)
  const distA = Math.hypot(p.x - a.x, p.z - a.z);
  const distB = Math.hypot(p.x - b.x, p.z - b.z);
  if (distA <= tol || distB <= tol) return null;
  return t;
}

// Build the merged node set + undirected edges from wall centrelines. Returns {nodes, edges}
// where nodes is [{x,z}] and edges is a Set of "i:j" (i<j) index pairs.
function buildGraph(walls, tol) {
  const nodes = [];
  const findOrAdd = (p) => {
    for (let i = 0; i < nodes.length; i++) if (d2(nodes[i], p) <= tol * tol) return i;
    nodes.push({ x: p.x, z: p.z });
    return nodes.length - 1;
  };

  // raw edges from walls (merged endpoints), dropping zero-length and duplicates
  const edgeKey = (i, j) => (i < j ? `${i}:${j}` : `${j}:${i}`);
  let edges = new Set();
  for (const w of walls) {
    if (!w || !w.a || !w.b) continue;
    const i = findOrAdd(w.a), j = findOrAdd(w.b);
    if (i === j) continue;                            // zero-length after merge
    edges.add(edgeKey(i, j));
  }

  // T-junction splitting: a node that lies part-way along an edge splits that edge in two.
  // Iterate to a fixed point (a split can expose further splits).
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of Array.from(edges)) {
      const [ai, bi] = key.split(':').map(Number);
      const a = nodes[ai], b = nodes[bi];
      let best = null;                                // { node, t }
      for (let n = 0; n < nodes.length; n++) {
        if (n === ai || n === bi) continue;
        const t = pointOnSegment(nodes[n], a, b, tol);
        if (t == null) continue;
        if (best == null || t < best.t) best = { node: n, t };
      }
      if (best) {
        edges.delete(key);
        edges.add(edgeKey(ai, best.node));
        edges.add(edgeKey(best.node, bi));
        changed = true;
      }
    }
  }

  return { nodes, edges };
}

// Angle of the ray node[from]→node[to], in (-π, π].
function angleOf(nodes, from, to) {
  return Math.atan2(nodes[to].z - nodes[from].z, nodes[to].x - nodes[from].x);
}

// Signed area (shoelace) of a polygon of {x,z}; positive == counter-clockwise in the x/z plane
// (with z treated as the vertical axis of the 2-D plan).
function signedArea(points) {
  let sum = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    sum += p.x * q.z - q.x * p.z;
  }
  return sum / 2;
}

// Enumerate the bounded faces of the wall graph as room-candidate polygons.
//   walls  : [{ a:{x,z}, b:{x,z} }, ...]  (wall objects or bare segments)
//   opts   : { tol, minArea }
// Returns [{ points: [{x,z}, ...] }]  — each polygon CCW, no repeated closing vertex, ordered
// largest-area first for stable output. Never throws on malformed input; returns [] instead.
export function detectRooms(walls, opts = {}) {
  const tol = opts.tol ?? DEFAULT_TOL;
  const minArea = opts.minArea ?? DEFAULT_MIN_AREA;
  if (!Array.isArray(walls) || walls.length < 3) return [];

  const { nodes, edges } = buildGraph(walls, tol);
  if (edges.size < 3) return [];

  // adjacency: for each node, its neighbours sorted CCW by angle (a stable rotation order)
  const adj = nodes.map(() => []);
  for (const key of edges) {
    const [i, j] = key.split(':').map(Number);
    adj[i].push(j);
    adj[j].push(i);
  }
  for (let v = 0; v < nodes.length; v++) {
    adj[v].sort((p, q) => angleOf(nodes, v, p) - angleOf(nodes, v, q));
  }
  // index of neighbour u within v's sorted ring
  const ringIndex = nodes.map(() => new Map());
  for (let v = 0; v < nodes.length; v++) adj[v].forEach((u, k) => ringIndex[v].set(u, k));

  // DCEL face traversal: for a dart u→v, the next dart around the SAME face is v→w where w is
  // the neighbour immediately clockwise of u in v's CCW ring (i.e. previous index, wrapping).
  const next = (u, v) => {
    const ring = adj[v];
    const k = ringIndex[v].get(u);
    const w = ring[(k - 1 + ring.length) % ring.length];
    return w;
  };

  const seen = new Set();                             // visited darts "u>v"
  const dartKey = (u, v) => `${u}>${v}`;
  const faces = [];
  for (const key of edges) {
    const [a, b] = key.split(':').map(Number);
    for (const [u0, v0] of [[a, b], [b, a]]) {
      if (seen.has(dartKey(u0, v0))) continue;
      const cycle = [];
      let u = u0, v = v0, guard = 0;
      const limit = edges.size * 2 + 4;
      while (!seen.has(dartKey(u, v)) && guard++ <= limit) {
        seen.add(dartKey(u, v));
        cycle.push(u);
        const w = next(u, v);
        u = v; v = w;
        if (u === u0 && v === v0) break;
      }
      if (cycle.length >= 3) faces.push(cycle);
    }
  }

  // Turn node cycles into polygons; keep only bounded interior faces (positive CCW area above
  // the floor), drop the unbounded outer boundary (it comes out clockwise / negative) and any
  // degenerate spur (|area| below minArea). Output CCW, largest first.
  const rooms = [];
  for (const cycle of faces) {
    const pts = cycle.map((n) => ({ x: nodes[n].x, z: nodes[n].z }));
    const sa = signedArea(pts);
    if (sa <= minArea) continue;                       // outer face is negative; spurs ≈ 0
    rooms.push({ points: pts, _area: sa });
  }
  rooms.sort((r1, r2) => r2._area - r1._area);
  return rooms.map((r) => ({ points: r.points }));
}

// Convenience read over a model level: detect rooms from the level's walls and return polygons
// that are NOT already covered by an existing room (so the UI can offer only the *new* ones).
// "Covered" = an existing room's area matches within areaTol AND its centroid falls inside the
// candidate. Pure — reads the level, mutates nothing.
export function detectNewRooms(level, opts = {}) {
  if (!level || !Array.isArray(level.walls)) return [];
  const candidates = detectRooms(level.walls, opts);
  const existing = Array.isArray(level.rooms) ? level.rooms : [];
  const areaTol = opts.areaTol ?? 0.05;              // 5 cm² — existing vs derived area slack
  // "Covered" = an existing room matches the candidate by area AND sits IN THE SAME PLACE (its
  // centroid falls inside the candidate). The position test matters: two rooms of equal area at
  // different spots (a duplex's mirrored halves, say) must not both vanish when only one is saved
  // — an area-only test would hide the still-undrawn twin. Belt-and-braces, we also treat the
  // candidate's own centroid landing inside the existing room as a match, so a near-identical
  // polygon is covered from either side.
  const covered = (poly) => {
    const a = polygonArea(poly.points);
    const pc = polygonCentroid(poly.points);
    return existing.some((r) => {
      if (Math.abs(polygonArea(r.points) - a) > Math.max(areaTol, a * 0.01)) return false;
      return pointInPolygon(polygonCentroid(r.points), poly.points) || pointInPolygon(pc, r.points);
    });
  };
  return candidates.filter((poly) => !covered(poly));
}
