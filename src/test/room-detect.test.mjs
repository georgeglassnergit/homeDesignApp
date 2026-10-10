// Auto room detection — engine-independent verification (plain Node, no Three.js).
// Run: node src/test/room-detect.test.mjs
//
// A4 (PHASE-3-PLAN.md): derive closed room polygons from wall centrelines by enumerating the
// bounded faces of the wall graph. This proves the pure detector in src/core/roomDetect.js:
//   • a single closed loop of walls → exactly ONE room, correct area, CCW winding
//   • two rooms sharing a wall → TWO rooms (the shared wall closes both faces)
//   • a T-junction (a wall butting mid-way along another) is split so both faces close
//   • a non-convex L-shaped loop → ONE room with the right area
//   • an OPEN loop (a missing side) → NO room
//   • a dangling spur wall is dropped (out-and-back degenerate face), room still found
//   • coincident-but-float-apart corners are merged within tolerance
//   • duplicate / zero-length walls are ignored
//   • detectNewRooms hides polygons already covered by an existing saved room
//   • malformed input never throws; detection mutates NOTHING and adds NO save field
// Lives in its own file so it composes with in-flight work (the roof suite's approach).
import {
  createProject, createLevel, createWall, createRoom, serialize, deserialize, _resetIds,
  polygonArea,
} from '../core/model.js';
import { detectRooms, detectNewRooms, DEFAULT_TOL } from '../core/roomDetect.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// bare segment helper (detectRooms accepts anything with a/b {x,z})
const seg = (ax, az, bx, bz) => ({ a: { x: ax, z: az }, b: { x: bx, z: bz } });
// signed area to check winding
function signedArea(points) {
  let s = 0;
  for (let i = 0, n = points.length; i < n; i++) { const p = points[i], q = points[(i + 1) % n]; s += p.x * q.z - q.x * p.z; }
  return s / 2;
}

// ── 1. Single closed square → one room ────────────────────────────────────────
{
  const walls = [seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4), seg(0, 4, 0, 0)];
  const rooms = detectRooms(walls);
  ok(rooms.length === 1, `single square → 1 room (got ${rooms.length})`);
  ok(rooms[0] && near(polygonArea(rooms[0].points), 16, 1e-6), 'single square area == 16 m²');
  ok(rooms[0] && rooms[0].points.length === 4, 'single square has 4 vertices (no repeated close)');
  ok(rooms[0] && signedArea(rooms[0].points) > 0, 'output polygon is CCW (positive signed area)');
}

// ── 2. Two rooms sharing a middle wall (T-junctions at top & bottom) ──────────
{
  // outer 8×4 rectangle split at x=4 by a middle wall; the middle wall's ends land mid-way
  // along the top & bottom edges → the detector must split those edges to close both faces.
  const walls = [
    seg(0, 0, 8, 0), seg(8, 0, 8, 4), seg(8, 4, 0, 4), seg(0, 4, 0, 0), // perimeter
    seg(4, 0, 4, 4),                                                     // divider
  ];
  const rooms = detectRooms(walls);
  ok(rooms.length === 2, `split rectangle → 2 rooms (got ${rooms.length})`);
  ok(rooms.every((r) => near(polygonArea(r.points), 16, 1e-6)), 'each half is 16 m²');
  ok(rooms.every((r) => signedArea(r.points) > 0), 'both halves CCW');
}

// ── 3. Non-convex L-shape → one room, correct area ────────────────────────────
{
  // L polygon: (0,0)(6,0)(6,2)(2,2)(2,6)(0,6). area = full 6×6 minus the 4×4 notch = 36-16 = 20
  const p = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
  const walls = p.map((_, i) => { const a = p[i], b = p[(i + 1) % p.length]; return seg(a[0], a[1], b[0], b[1]); });
  const rooms = detectRooms(walls);
  ok(rooms.length === 1, `L-shape → 1 room (got ${rooms.length})`);
  ok(rooms[0] && near(polygonArea(rooms[0].points), 20, 1e-6), 'L-shape area == 20 m²');
  ok(rooms[0] && rooms[0].points.length === 6, 'L-shape keeps 6 vertices');
}

// ── 4. Open loop (missing a side) → no room ───────────────────────────────────
{
  const walls = [seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4)]; // 3 of 4 sides
  const rooms = detectRooms(walls);
  ok(rooms.length === 0, `open loop → 0 rooms (got ${rooms.length})`);
}

// ── 5. Dangling spur wall is dropped; the room is still found ──────────────────
{
  const walls = [
    seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4), seg(0, 4, 0, 0), // square
    seg(0, 0, -2, 0),                                                    // spur off a corner
  ];
  const rooms = detectRooms(walls);
  ok(rooms.length === 1, `square + spur → 1 room (got ${rooms.length})`);
  ok(rooms[0] && near(polygonArea(rooms[0].points), 16, 1e-6), 'spur does not distort the room area');
}

// ── 6. Coincident-but-float-apart corners are merged within tolerance ─────────
{
  const e = DEFAULT_TOL * 0.4;                       // inside the 1 mm merge tolerance
  const walls = [
    seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4), seg(0, 4, e, e), // last corner off by <tol
  ];
  const rooms = detectRooms(walls);
  ok(rooms.length === 1, `near-coincident corner merged → 1 room (got ${rooms.length})`);
  ok(rooms[0] && near(polygonArea(rooms[0].points), 16, 1e-3), 'merged-corner area ≈ 16 m²');
}

// ── 7. Duplicate & zero-length walls are ignored ──────────────────────────────
{
  const walls = [
    seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4), seg(0, 4, 0, 0),
    seg(0, 0, 4, 0),                                                     // exact duplicate
    seg(4, 0, 4, 0),                                                     // zero length
  ];
  const rooms = detectRooms(walls);
  ok(rooms.length === 1, `duplicate + zero-length ignored → 1 room (got ${rooms.length})`);
}

// ── 8. detectNewRooms hides polygons already covered by an existing room ───────
{
  _resetIds();
  const square = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }];
  const walls = [seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4), seg(0, 4, 0, 0)];
  const levelNoRoom = createLevel({ walls });
  ok(detectNewRooms(levelNoRoom).length === 1, 'no existing room → 1 new room offered');
  const levelWithRoom = createLevel({ walls, rooms: [createRoom(square, { name: 'Kitchen' })] });
  ok(detectNewRooms(levelWithRoom).length === 0, 'room already saved → 0 new rooms offered');

  // Equal-area but DIFFERENT-PLACE rooms: two 4×4 rooms side by side (a shared divider at x=4).
  // Saving one must NOT hide the other — the covered() test is position-aware (area + centroid-in),
  // not area-only. (An area-only filter wrongly vanished the undrawn twin.)
  const twinWalls = [
    seg(0, 0, 8, 0), seg(8, 0, 8, 4), seg(8, 4, 0, 4), seg(0, 4, 0, 0), seg(4, 0, 4, 4),
  ];
  const twoRooms = detectNewRooms(createLevel({ walls: twinWalls }));
  ok(twoRooms.length === 2, 'two equal-area rooms across a divider → both offered');
  const leftSquare = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }];
  const oneSaved = createLevel({ walls: twinWalls, rooms: [createRoom(leftSquare, { name: 'Left' })] });
  const stillNew = detectNewRooms(oneSaved);
  ok(stillNew.length === 1, 'saving the left 4×4 leaves the equal-area right 4×4 still offered (position-aware)');
  ok(polygonArea(stillNew[0].points) > 15.9 && polygonArea(stillNew[0].points) < 16.1, 'the remaining offer is the other 16 m² room');
}

// ── 9. Malformed input never throws; returns [] ───────────────────────────────
{
  let threw = false;
  try {
    ok(detectRooms(null).length === 0, 'null → []');
    ok(detectRooms([]).length === 0, 'empty → []');
    ok(detectRooms([seg(0, 0, 1, 0)]).length === 0, 'one wall → []');
    ok(detectRooms([{ a: { x: 0, z: 0 } }, {}, seg(0, 0, 1, 1)]).length === 0, 'junk walls → []');
    ok(detectNewRooms(null).length === 0, 'detectNewRooms(null) → []');
  } catch (_) { threw = true; }
  ok(!threw, 'malformed input never throws');
}

// ── 10. Detection mutates NOTHING and adds NO save field ──────────────────────
{
  _resetIds();
  const walls = [seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4), seg(0, 4, 0, 0)]
    .map((s) => createWall(s.a, s.b));
  const proj = createProject({ levels: [createLevel({ walls })] });
  const before = serialize(proj);
  const rooms = detectRooms(proj.levels[0].walls);
  const after = serialize(proj);
  ok(rooms.length === 1, 'detection over a real project level finds the room');
  ok(before === after, 'serialize is byte-identical before/after detection (no mutation)');
  // full lossless round-trip still holds with the walls in place
  const rt = serialize(deserialize(after));
  ok(rt === before, 'serialize→deserialize→serialize is byte-identical (lossless preserved)');
}

// ── 11. Winding independence: input walls in CW order still yield CCW rooms ────
{
  const cw = [seg(0, 0, 0, 4), seg(0, 4, 4, 4), seg(4, 4, 4, 0), seg(4, 0, 0, 0)]; // reversed
  const rooms = detectRooms(cw);
  ok(rooms.length === 1, `CW-drawn square → 1 room (got ${rooms.length})`);
  ok(rooms[0] && signedArea(rooms[0].points) > 0, 'CW input still produces CCW output room');
}

// ── 12. X-crossing: scissor walls with no shared endpoint are split at the crossing ──
{
  // A 4×4 square with BOTH diagonals drawn across it. The diagonals cross at the centre (2,2)
  // with no shared endpoint, so the crossing must be inserted as a node and both diagonals split
  // — subdividing the interior into 4 triangles of 4 m² each. Before X-splitting the diagonals
  // sliced the square without closing sub-faces, so it read as one undivided space.
  const walls = [
    seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4), seg(0, 4, 0, 0), // square
    seg(0, 0, 4, 4), seg(0, 4, 4, 0),                                   // two diagonals (an X)
  ];
  const rooms = detectRooms(walls);
  ok(rooms.length === 4, `square + crossing diagonals → 4 rooms (got ${rooms.length})`);
  ok(rooms.every((r) => near(polygonArea(r.points), 4, 1e-6)), 'each triangular quarter is 4 m²');
  ok(rooms.every((r) => signedArea(r.points) > 0), 'every quarter is CCW');
  ok(near(rooms.reduce((s, r) => s + polygonArea(r.points), 0), 16, 1e-6), 'quarters sum to the 16 m² square');
}

// ── 13. Two rooms divided by a single wall that crosses the middle (a +) ──────────
{
  // An 8×4 outer rectangle with a vertical divider at x=4 whose ENDS overshoot the top and
  // bottom edges (so they are true crossings, not endpoint T-junctions). The overshoot tails
  // are spurs (dropped); the two 4×4 halves must still close.
  const walls = [
    seg(0, 0, 8, 0), seg(8, 0, 8, 4), seg(8, 4, 0, 4), seg(0, 4, 0, 0), // perimeter
    seg(4, -1, 4, 5),                                                    // divider overshooting both edges
  ];
  const rooms = detectRooms(walls);
  ok(rooms.length === 2, `overshooting divider → 2 rooms (got ${rooms.length})`);
  ok(rooms.every((r) => near(polygonArea(r.points), 16, 1e-6)), 'each half is 16 m² (overshoot tails dropped as spurs)');
}

// ── 14. Crossing walls that enclose nothing → no room, never throws ──────────────
{
  // Two diagonals cross at (2,2) and split into four spurs; a disjoint far segment keeps the
  // input at ≥3 walls so the crossing path actually runs. No wall closes a face → 0 rooms.
  let threw = false;
  let rooms = [];
  try { rooms = detectRooms([seg(0, 0, 4, 4), seg(0, 4, 4, 0), seg(10, 10, 11, 11)]); }
  catch (_) { threw = true; }
  ok(!threw, 'crossing walls with no closed face never throw');
  ok(rooms.length === 0, `crossing walls enclosing nothing → 0 rooms (got ${rooms.length})`);
}

// ── 15. A crossing near an existing corner stays a T-junction (no redundant node) ─
{
  // The divider's bottom end lands EXACTLY on the bottom edge (a genuine T at (4,0)); its top
  // end overshoots the top edge (a true crossing at (4,4)). Mixed T + X on one wall still yields
  // the two clean 4×4 halves — proving the endpoint-clearance guard routes each case correctly.
  const walls = [
    seg(0, 0, 8, 0), seg(8, 0, 8, 4), seg(8, 4, 0, 4), seg(0, 4, 0, 0),
    seg(4, 0, 4, 5),                                                     // T at bottom, X at top
  ];
  const rooms = detectRooms(walls);
  ok(rooms.length === 2, `mixed T+X divider → 2 rooms (got ${rooms.length})`);
  ok(rooms.every((r) => near(polygonArea(r.points), 16, 1e-6)), 'both halves 16 m² with mixed junctions');
}

// ── summary ───────────────────────────────────────────────────────────────────
if (fail === 0) console.log(`\nALL PASS — ${pass} passed, 0 failed`);
else { console.log(`\nFAILED — ${pass} passed, ${fail} failed`); for (const f of fails) console.log('  · ' + f); process.exit(1); }
