// core/wallJoin.js — pure wall-corner mitre geometry (the Group C "clean corners" engine).
//
// PHASE-3-PLAN.md Group C (C1/C2): walls are stored as centrelines with a thickness and are
// built today as independent overlapping boxes (build/geometry.js `buildWallMesh`). That reads
// fine for grid-orthogonal corners — the boxes overlap into a square — but for angled walls the
// overlap is wrong (a spike on the outside, a notch on the inside), and the CSG watertight guard
// (constraint #5) cares about the seam. This module computes, per wall, the mitred quad footprint
// so a future builder run can extrude gap-free, non-overlapping corner prisms.
//
// It is the recommended "small step, pure geometry first" for Group C: engine-independent (imports
// only model.js, NO Three.js — importing it under Node is itself the model/view-separation guard),
// derived-on-read (stores nothing, mutates nothing, adds NO save field — the Phase 1 lossless save
// is untouched), and never throws on malformed/partial input.
//
// Model:  each wall is the rectangle swept by its centreline a→b offset by ±thickness/2 along the
// wall's LEFT normal. The four corners, in a consistent CCW order, are [aR, bR, bL, aL] where
// L(eft)/R(ight) are the same side all along the wall. At a junction where EXACTLY two walls share
// an endpoint we mitre: the two walls' offset edges are intersected so their rectangles meet along
// a single clean seam (no gap, no overlap). Endpoints with 1 wall (a free end) or 3+ walls (a T / X
// junction) are left as plain square ends — a safe, watertight-preserving fallback, never a spike.

import { wallLength } from './model.js';

export const DEFAULT_JOIN_TOL = 1e-3;   // metres: endpoints within 1 mm are the same junction node
export const DEFAULT_MITRE_LIMIT = 8;   // cap the mitre spike at very acute angles (× half-thickness)

// ── small 2-D vector helpers (plan coords {x, z}) ─────────────────────────────
const sub = (p, q) => ({ x: p.x - q.x, z: p.z - q.z });
const add = (p, q) => ({ x: p.x + q.x, z: p.z + q.z });
const scale = (p, s) => ({ x: p.x * s, z: p.z * s });
const len = (p) => Math.hypot(p.x, p.z);
const cross = (p, q) => p.x * q.z - p.z * q.x;   // z-component of the 2-D cross product
function unit(p) { const L = len(p); return L < 1e-12 ? null : { x: p.x / L, z: p.z / L }; }
// left normal of a direction (rotate +90° in the x→z plane)
const leftNormal = (d) => ({ x: -d.z, z: d.x });

// Intersection of two lines given as (point, direction). Returns the point, or null when the
// directions are parallel (no unique mitre — caller falls back to a square end).
function lineIntersect(p1, d1, p2, d2) {
  const denom = cross(d1, d2);
  if (Math.abs(denom) < 1e-12) return null;      // parallel / collinear
  const diff = sub(p2, p1);
  const t = cross(diff, d2) / denom;
  return add(p1, scale(d1, t));
}

// ── the plain (un-joined) rectangle of one wall ──────────────────────────────
// Order [aR, bR, bL, aL]: right side a→b, then left side b→a. Zero-length → null.
export function wallQuad(wall, thickness = wall.thickness) {
  const d = unit(sub(wall.b, wall.a));
  if (!d) return null;
  const h = Math.max(0, thickness) / 2;
  const n = leftNormal(d);                       // +n = left, -n = right
  const off = scale(n, h);
  const aL = add(wall.a, off), aR = sub(wall.a, off);
  const bL = add(wall.b, off), bR = sub(wall.b, off);
  return [aR, bR, bL, aL];
}

// Which corners of a wall's quad sit at endpoint `end` ('a' | 'b'), tagged by side.
// aR/aL are indices 0/3; bR/bL are 1/2. Left corner = a + leftNormal*h.
function endCorners(end) {
  return end === 'a' ? { left: 3, right: 0 } : { left: 2, right: 1 };
}

// Direction a wall points AWAY from one of its endpoints, and its left normal in that frame.
function awayFrom(wall, end) {
  const d = end === 'a' ? unit(sub(wall.b, wall.a)) : unit(sub(wall.a, wall.b));
  return d ? { d, n: leftNormal(d) } : null;
}

// Group wall endpoints into junction nodes (coincident within tol). Distance-based clustering,
// not grid hashing — two endpoints a hair apart must land in the SAME node even when they straddle
// a grid cell boundary (the same tolerant-merge the room detector uses). O((2N)²): fine for a home
// plan's wall count. Returns an array of nodes, each an array of { wi (wall index), end }.
function junctionNodes(walls, tol) {
  const reps = [];  // one representative point per node
  const nodes = [];
  walls.forEach((w, wi) => {
    for (const end of ['a', 'b']) {
      const p = w[end];
      let ni = -1;
      for (let i = 0; i < reps.length; i++) {
        if (Math.hypot(p.x - reps[i].x, p.z - reps[i].z) <= tol) { ni = i; break; }
      }
      if (ni === -1) { reps.push({ x: p.x, z: p.z }); nodes.push([]); ni = nodes.length - 1; }
      nodes[ni].push({ wi, end });
    }
  });
  return nodes;
}

// Compute the two mitre points where the offset edges of wall1 and wall2 meet at shared point p.
// u1/u2 point away from p along each wall; h1/h2 are the half-thicknesses. Returns { M1, M2 }
// where M1 lies on wall1's LEFT offset edge and M2 on wall1's RIGHT offset edge, or null when the
// walls are collinear (parallel edges) or the mitre spike exceeds the limit.
function mitrePoints(p, u1, h1, u2, h2, mitreLimit) {
  const n1 = leftNormal(u1.d), n2 = leftNormal(u2.d);
  const P1L = add(p, scale(n1, h1)), P1R = sub(p, scale(n1, h1));
  const P2L = add(p, scale(n2, h2)), P2R = sub(p, scale(n2, h2));
  const turn = cross(u1.d, u2.d);
  if (Math.abs(turn) < 1e-9) return null;        // collinear: edges already align, no mitre needed
  let M1, M2;
  if (turn > 0) {                                // left turn: wall1.left meets wall2.right
    M1 = lineIntersect(P1L, u1.d, P2R, u2.d);
    M2 = lineIntersect(P1R, u1.d, P2L, u2.d);
  } else {                                        // right turn: wall1.left meets wall2.left
    M1 = lineIntersect(P1L, u1.d, P2L, u2.d);
    M2 = lineIntersect(P1R, u1.d, P2R, u2.d);
  }
  if (!M1 || !M2) return null;
  // Reject a runaway spike at very acute angles (fall back to a square end instead).
  const cap = mitreLimit * Math.max(h1, h2, 1e-6);
  if (len(sub(M1, p)) > cap || len(sub(M2, p)) > cap) return null;
  return { M1, M2 };
}

// Assign the two mitre points to a wall's two corners at endpoint `end` by nearest match, so the
// left/right bookkeeping is automatic regardless of which endpoint (a or b) meets the junction.
function applyMitre(quad, end, M1, M2) {
  const { left, right } = endCorners(end);
  const cL = quad[left], cR = quad[right];
  // nearest-of-two assignment
  const d1L = len(sub(M1, cL)), d1R = len(sub(M1, cR));
  if (d1L <= d1R) { quad[left] = M1; quad[right] = M2; }
  else { quad[left] = M2; quad[right] = M1; }
}

// ── the public engine ────────────────────────────────────────────────────────
// joinWalls(walls, opts) → array parallel to `walls`:
//   { id, quad: [{x,z}×4] (CCW: [aR,bR,bL,aL], corners relocated at mitred ends),
//     joints: { a: 'mitre'|'end', b: 'mitre'|'end' } }
// A wall too short to have a direction is returned with quad:null and both joints 'end'.
// Reads only the plain model; returns fresh geometry; mutates nothing.
export function joinWalls(walls, opts = {}) {
  const tol = opts.tol ?? DEFAULT_JOIN_TOL;
  const mitreLimit = opts.mitreLimit ?? DEFAULT_MITRE_LIMIT;
  const usable = Array.isArray(walls) ? walls : [];

  const out = usable.map((w) => ({
    id: w && w.id,
    quad: (w && w.a && w.b && wallLength(w) >= tol) ? wallQuad(w) : null,
    joints: { a: 'end', b: 'end' },
  }));

  // Build junction nodes over the walls that have a usable quad only. `valid` preserves the
  // mapping back to the original index so a mitre writes into the right `out` entry.
  const valid = [];
  usable.forEach((w, wi) => { if (out[wi].quad) valid.push({ wi, w }); });
  const nodeMap = junctionNodes(valid.map(({ w }) => w), tol);

  for (const members of nodeMap) {
    if (members.length !== 2) continue;          // free end (1) or T/X (3+) → square fallback
    const A = members[0], B = members[1];
    const wa = valid[A.wi], wb = valid[B.wi];     // NOTE: A.wi/B.wi index into `valid`
    const wallA = wa.w, wallB = wb.w;
    const outA = out[wa.wi], outB = out[wb.wi];
    if (!outA.quad || !outB.quad) continue;
    const p = wallA[A.end];
    const uA = awayFrom(wallA, A.end), uB = awayFrom(wallB, B.end);
    if (!uA || !uB) continue;
    const hA = Math.max(0, wallA.thickness) / 2, hB = Math.max(0, wallB.thickness) / 2;
    const m = mitrePoints(p, uA, hA, uB, hB, mitreLimit);
    if (!m) continue;                             // collinear or over-limit → leave square ends
    applyMitre(outA.quad, A.end, m.M1, m.M2);
    applyMitre(outB.quad, B.end, m.M1, m.M2);
    outA.joints[A.end] = 'mitre';
    outB.joints[B.end] = 'mitre';
  }
  return out;
}

// Signed area of a polygon (positive = CCW in the x→z plane). Small utility so callers/tests can
// confirm a mitred quad stays a simple, positively-wound polygon.
export function quadSignedArea(quad) {
  if (!Array.isArray(quad) || quad.length < 3) return 0;
  let s = 0;
  for (let i = 0, n = quad.length; i < n; i++) {
    const p = quad[i], q = quad[(i + 1) % n];
    s += p.x * q.z - q.x * p.z;
  }
  return s / 2;
}
