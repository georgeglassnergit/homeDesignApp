// Wall-corner mitre geometry — engine-independent verification (plain Node, no Three.js).
// Run: node src/test/wall-join.test.mjs
//
// PHASE-3-PLAN.md Group C (C2 "clean corners", the pure-geometry first step): proves the mitre
// engine in src/core/wallJoin.js turns overlapping wall boxes into gap-free, non-overlapping
// corner quads:
//   • wallQuad rectangle: right/left offset corners, order [aR,bR,bL,aL], area = length×thickness
//   • a right-angle L corner mitres both walls to a SHARED seam (simultaneously no gap, no overlap)
//   • a closed square mitres all four corners, every quad a simple positive-area polygon
//   • collinear walls (continuing straight, or doubling back) get NO mitre — edges already align
//   • obtuse / acute corners mitre; a near-degenerate spike falls back to a square end (mitre limit)
//   • unequal wall thicknesses still meet on one shared seam
//   • a T / X junction (3+ walls at a node) and a free end stay square ends — safe fallback
//   • an a↔a and a b↔b meeting both mitre (endpoint bookkeeping is direction-independent)
//   • near-coincident endpoints within tol form one junction; malformed input never throws
//   • purity: joining a real project mutates NOTHING, adds NO save field, save stays byte-identical
// Lives in its own file so it composes with in-flight work (the roof/room suites' approach).
import {
  createProject, createLevel, createWall, serialize, deserialize, _resetIds, wallLength,
} from '../core/model.js';
import {
  joinWalls, wallQuad, quadSignedArea, DEFAULT_JOIN_TOL, DEFAULT_MITRE_LIMIT,
} from '../core/wallJoin.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const ptNear = (p, x, z, e = 1e-9) => p && near(p.x, x, e) && near(p.z, z, e);
const W = (id, ax, az, bx, bz, t = 0.2) => createWall({ x: ax, z: az }, { x: bx, z: bz }, { id, thickness: t });
// corner index map (mirrors wallJoin's endCorners): quad = [aR, bR, bL, aL]
const CORNER = { a: { left: 3, right: 0 }, b: { left: 2, right: 1 } };
// set-equality of two unordered point pairs within eps
function samePair(p1, p2, q1, q2, e = 1e-9) {
  const eq = (u, v) => near(u.x, v.x, e) && near(u.z, v.z, e);
  return (eq(p1, q1) && eq(p2, q2)) || (eq(p1, q2) && eq(p2, q1));
}

// ── 1. wallQuad — the plain rectangle ─────────────────────────────────────────
{
  const q = wallQuad(W('w', 0, 0, 2, 0, 0.2));
  ok(q && q.length === 4, 'wallQuad returns 4 corners');
  // a→b along +x, left normal +z: aR=(0,-0.1) aL=(0,0.1) bR=(2,-0.1) bL=(2,0.1)
  ok(ptNear(q[0], 0, -0.1), 'aR at (0,-0.1)');
  ok(ptNear(q[1], 2, -0.1), 'bR at (2,-0.1)');
  ok(ptNear(q[2], 2, 0.1), 'bL at (2,0.1)');
  ok(ptNear(q[3], 0, 0.1), 'aL at (0,0.1)');
  ok(near(Math.abs(quadSignedArea(q)), 2 * 0.2), 'quad area = length × thickness');
  ok(quadSignedArea(q) > 0, 'a→+x wall quad is CCW (positive)');
  ok(wallQuad(W('z', 1, 1, 1, 1)) === null, 'zero-length wall → null quad');
}

// ── 2. Right-angle L corner mitres to a shared seam ───────────────────────────
{
  _resetIds();
  const w1 = W('w1', 0, 0, 1, 0), w2 = W('w2', 0, 0, 0, 1); // meet at origin, both endpoint a
  const r = joinWalls([w1, w2]);
  ok(r[0].joints.a === 'mitre' && r[1].joints.a === 'mitre', 'both walls mitre at the shared corner');
  ok(r[0].joints.b === 'end' && r[1].joints.b === 'end', 'the free far ends stay square');
  const a1L = r[0].quad[CORNER.a.left], a1R = r[0].quad[CORNER.a.right];
  const a2L = r[1].quad[CORNER.a.left], a2R = r[1].quad[CORNER.a.right];
  // inner mitre (0.1,0.1), outer mitre (-0.1,-0.1)
  ok(samePair(a1L, a1R, { x: 0.1, z: 0.1 }, { x: -0.1, z: -0.1 }), 'w1 corner sits on the inner+outer mitre');
  ok(samePair(a1L, a1R, a2L, a2R), 'both walls share the SAME two mitre points (gap-free & non-overlapping)');
  ok(quadSignedArea(r[0].quad) > 0 && quadSignedArea(r[1].quad) > 0, 'both mitred quads stay simple, positive-area');
  // area is preserved by an equal-thickness right-angle mitre (trim one side = extend the other)
  ok(near(Math.abs(quadSignedArea(r[0].quad)), 1 * 0.2, 1e-9), 'right-angle mitre preserves wall area');
}

// ── 3. Closed square — every corner mitred ────────────────────────────────────
{
  const sq = [W('a', 0, 0, 4, 0), W('b', 4, 0, 4, 4), W('c', 4, 4, 0, 4), W('d', 0, 4, 0, 0)];
  const r = joinWalls(sq);
  ok(r.every(x => x.joints.a === 'mitre' && x.joints.b === 'mitre'), 'all 4 corners of a closed square mitre');
  ok(r.every(x => quadSignedArea(x.quad) > 0), 'every mitred quad is a simple positive-area polygon');
  // corner at (0,0): wall a endpoint a and wall d endpoint b — shared seam
  const aA = [r[0].quad[CORNER.a.left], r[0].quad[CORNER.a.right]];
  const dB = [r[3].quad[CORNER.b.left], r[3].quad[CORNER.b.right]];
  ok(samePair(aA[0], aA[1], dB[0], dB[1]), 'square corner (0,0) is a shared a↔b seam');
  ok(samePair(aA[0], aA[1], { x: 0.1, z: 0.1 }, { x: -0.1, z: -0.1 }), 'that seam is inner(0.1,0.1)+outer(-0.1,-0.1)');
}

// ── 4. Collinear walls get NO mitre ───────────────────────────────────────────
{
  // continuing straight through the shared point
  const straight = joinWalls([W('s1', -1, 0, 0, 0), W('s2', 0, 0, 1, 0)]);
  ok(straight.every(x => x.joints.a === 'end' && x.joints.b === 'end'), 'collinear-continuing walls: no mitre');
  // the quads are the untouched rectangles
  ok(near(Math.abs(quadSignedArea(straight[0].quad)), 1 * 0.2), 'collinear quad left as the plain rectangle');
  // doubling back (spur): both point the same way out of the node → still collinear
  const spur = joinWalls([W('u1', 0, 0, 1, 0), W('u2', 0, 0, 2, 0)]);
  ok(spur.every(x => x.joints.a === 'end'), 'overlapping collinear spur: no mitre, no throw');
}

// ── 5. Obtuse and acute corners; the mitre limit ──────────────────────────────
{
  // 135° corner (obtuse): still one shared seam
  const ob = joinWalls([W('o1', 0, 0, 2, 0), W('o2', 0, 0, -2, 2)]);
  ok(ob[0].joints.a === 'mitre' && ob[1].joints.a === 'mitre', 'obtuse corner mitres');
  ok(samePair(ob[0].quad[CORNER.a.left], ob[0].quad[CORNER.a.right],
    ob[1].quad[CORNER.a.left], ob[1].quad[CORNER.a.right]), 'obtuse corner shares one seam');
  // near-degenerate ~5.7° with a thick wall: spike exceeds the default limit → square fallback
  const acute = joinWalls([W('p', 0, 0, 10, 0, 0.2), W('q', 0, 0, 10, 1, 0.2)]);
  ok(acute.every(x => x.joints.a === 'end'), 'near-degenerate spike falls back to a square end (mitre limit)');
  // a generous limit lets the same corner mitre
  const acute2 = joinWalls([W('p', 0, 0, 10, 0, 0.2), W('q', 0, 0, 10, 1, 0.2)], { mitreLimit: 40 });
  ok(acute2[0].joints.a === 'mitre', 'a higher mitreLimit permits the acute mitre');
  ok(DEFAULT_MITRE_LIMIT === 8, 'DEFAULT_MITRE_LIMIT exported');
}

// ── 6. Unequal thicknesses still meet on one seam ─────────────────────────────
{
  const r = joinWalls([W('t1', 0, 0, 2, 0, 0.30), W('t2', 0, 0, 0, 2, 0.10)]);
  ok(r[0].joints.a === 'mitre' && r[1].joints.a === 'mitre', 'unequal-thickness corner mitres');
  ok(samePair(r[0].quad[CORNER.a.left], r[0].quad[CORNER.a.right],
    r[1].quad[CORNER.a.left], r[1].quad[CORNER.a.right]),
    'unequal thicknesses still share ONE seam (offset lines intersect exactly)');
}

// ── 7. T / X junctions and free ends stay square ──────────────────────────────
{
  // T: three walls share (4,0)
  const t = joinWalls([W('t1', 0, 0, 4, 0), W('t2', 4, 0, 8, 0), W('t3', 4, 0, 4, 4)]);
  ok(t.every(x => x.joints.a === 'end' && x.joints.b === 'end'), 'a 3-wall T-junction node stays square (safe fallback)');
  // single free wall
  const free = joinWalls([W('f', 0, 0, 3, 0)]);
  ok(free[0].joints.a === 'end' && free[0].joints.b === 'end', 'a free-standing wall has two square ends');
}

// ── 8. b↔b meeting and near-coincident tolerance ──────────────────────────────
{
  // two walls meeting tail-to-tail at (2,0): w1 a→b ends at (2,0); w2 a→b also ends at (2,0)
  const r = joinWalls([W('w1', 0, 0, 2, 0), W('w2', 2, 2, 2, 0)]);
  ok(r[0].joints.b === 'mitre' && r[1].joints.b === 'mitre', 'a b↔b meeting mitres (direction-independent)');
  ok(samePair(r[0].quad[CORNER.b.left], r[0].quad[CORNER.b.right],
    r[1].quad[CORNER.b.left], r[1].quad[CORNER.b.right]), 'the b↔b corner shares one seam');
  // endpoints a hair apart (< tol) still count as one junction
  const eps = DEFAULT_JOIN_TOL / 2;
  const nc = joinWalls([W('n1', 0, 0, 1, 0), W('n2', eps, eps, 0, 1)]);
  ok(nc[0].joints.a === 'mitre' && nc[1].joints.a === 'mitre', 'near-coincident endpoints (< tol) form one junction');
}

// ── 9. Malformed input never throws ───────────────────────────────────────────
{
  let threw = false, r;
  try {
    r = joinWalls([
      null,
      { id: 'zero', a: { x: 0, z: 0 }, b: { x: 0, z: 0 }, thickness: 0.2 }, // zero length
      { id: 'noThick', a: { x: 0, z: 0 }, b: { x: 1, z: 0 } },               // missing thickness
      W('good', 5, 5, 6, 5),
    ]);
  } catch (e) { threw = true; }
  ok(!threw, 'malformed walls (null / zero-length / missing thickness) never throw');
  ok(r.length === 4, 'output is parallel to input length');
  ok(r[0].quad === null && r[1].quad === null, 'null and zero-length walls yield quad:null');
  ok(r[3].id === 'good' && r[3].quad, 'a valid wall in a malformed batch still gets its quad');
  ok(joinWalls(null).length === 0 && joinWalls(undefined).length === 0, 'non-array input → empty result, no throw');
  ok(quadSignedArea(null) === 0 && quadSignedArea([{ x: 0, z: 0 }]) === 0, 'quadSignedArea guards degenerate input');
}

// ── 10. Purity — joining a real project mutates nothing, adds no save field ────
{
  _resetIds();
  const proj = createProject();
  const lvl = createLevel();
  lvl.walls.push(W('a', 0, 0, 4, 0), W('b', 4, 0, 4, 3), W('c', 4, 3, 0, 3), W('d', 0, 3, 0, 0));
  proj.levels.push(lvl);
  const before = serialize(proj);
  const r = joinWalls(lvl.walls);
  const after = serialize(proj);
  ok(r.length === 4 && r.every(x => x.joints.a === 'mitre' && x.joints.b === 'mitre'), 'the project rectangle mitres all 4 corners');
  ok(before === after, 'serialize is byte-identical before/after joinWalls (no mutation, no save field)');
  const rt = serialize(deserialize(after));
  ok(rt === before, 'serialize→deserialize→serialize stays byte-identical (Phase 1 lossless preserved)');
  // joinWalls must not have written onto the wall objects
  ok(!('quad' in lvl.walls[0]) && !('joints' in lvl.walls[0]), 'no derived field leaks onto the wall model');
  // spot-check the wall length is untouched
  ok(near(wallLength(lvl.walls[0]), 4), 'wall geometry (length) unchanged by joining');
}

// ── summary ───────────────────────────────────────────────────────────────────
if (fail === 0) console.log(`\nALL PASS — ${pass} passed, 0 failed`);
else { console.log(`\nFAILED — ${pass} passed, ${fail} failed`); for (const f of fails) console.log('  · ' + f); process.exit(1); }
