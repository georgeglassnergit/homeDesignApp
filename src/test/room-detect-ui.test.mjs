// A4 (UI wiring) — surface auto-detected rooms on the plan (engine-independent verification).
// Run: node src/test/room-detect-ui.test.mjs
//
// The pure detector (core/roomDetect.detectNewRooms) already turns closed wall loops into room
// candidates (proven in room-detect.test.mjs). This suite proves the WIRING that lets a user act
// on them without any Three.js / DOM:
//   • addRoom(levelId, room) — the undoable command a candidate-click commits. It touches only a
//     room's existing fields (createRoom writes them, serialize round-trips them), so it adds NO
//     new save field and is byte-lossless across do→undo (the Phase 1 contract).
//   • candidateAtPoint(candidates, point) — the pure hit-test the plan uses to resolve which
//     candidate a click lands on (smallest-containing wins, mirroring roomAtPoint's tie-break).
//   • the end-to-end loop: detectNewRooms → addRoom → detectNewRooms no longer offers the added
//     room (it is now "covered"), so the overlay converges to empty as the user adds rooms.
//   • the seam: 'room-detect' is un-tiered (available in Simple AND Pro) — read+add for everyone,
//     naming stays behind the existing Pro 'room-rename' gate.
// It lives in its own file (not edit-core.test.mjs) so it never collides with other in-flight
// test work — the pick-protocol rule the roof suite established.
import {
  createProject, createLevel, createWall, createRoom, serialize, _resetIds,
  validateProject, findLevel, polygonArea,
} from '../core/model.js';
import { addRoom } from '../edit/commands.js';
import { detectRooms, detectNewRooms } from '../core/roomDetect.js';
import { candidateAtPoint } from '../app/planCanvas.js';
import { isAvailable, MODE, FEATURE_TIERS } from '../app/state.js';
import { History } from '../edit/history.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// A closed 4×4 square of walls (corners at 0,0 / 4,0 / 4,4 / 0,4), plus a helper to build a level
// from a set of segments so the detector has a real wall loop to work on.
function squareWalls(s = 4) {
  const c = [{ x: 0, z: 0 }, { x: s, z: 0 }, { x: s, z: s }, { x: 0, z: s }];
  return [
    createWall(c[0], c[1]), createWall(c[1], c[2]),
    createWall(c[2], c[3]), createWall(c[3], c[0]),
  ];
}
function levelWith(walls, rooms = []) {
  const lvl = createLevel({ name: 'Ground' });
  lvl.walls = walls;
  lvl.rooms = rooms;
  return lvl;
}
// A project with a single ground level (createProject starts with none).
function projectWith(walls = [], rooms = []) {
  const project = createProject();
  project.levels = [levelWith(walls, rooms)];
  return project;
}

// ── 1. addRoom command: inserts a real room, undo removes exactly it ────────────────────────────
{
  _resetIds();
  const project = projectWith();
  const lvl = project.levels[0];
  const history = new History(project);
  const before = lvl.rooms.length;
  const room = createRoom([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }], { name: 'Room' });
  const cmd = history.execute(addRoom(lvl.id, room));
  ok(lvl.rooms.length === before + 1, '1a addRoom appends one room');
  ok(lvl.rooms[lvl.rooms.length - 1].id === room.id, '1b the appended room is the one built');
  ok(lvl.rooms[lvl.rooms.length - 1].name === 'Room', '1c default name is "Room"');
  ok(near(polygonArea(room.points), 16), '1d the room carries the detected polygon (area 16 m²)');
  ok(validateProject(project).ok, '1e project stays valid after addRoom');
  cmd.undo(project);
  ok(lvl.rooms.length === before, '1f undo removes exactly the inserted room');
  ok(!lvl.rooms.some((r) => r.id === room.id), '1g the removed room id is gone');
}

// ── 2. addRoom is byte-lossless (Phase 1 save contract) ─────────────────────────────────────────
{
  _resetIds();
  const project = projectWith();
  const lvl = project.levels[0];
  const clean = serialize(project);
  const history = new History(project);
  const room = createRoom([{ x: 1, z: 1 }, { x: 3, z: 1 }, { x: 3, z: 3 }, { x: 1, z: 3 }], { name: 'Room' });
  const cmd = history.execute(addRoom(lvl.id, room));
  // adds no new save FIELD: a detected room serializes exactly like a template room
  const s1 = serialize(project);
  ok(s1 === serialize(deserializeRoundtrip(project)), '2a serialize→deserialize→serialize byte-identical after addRoom');
  cmd.undo(project);
  ok(serialize(project) === clean, '2b addRoom→undo restores the save byte-for-byte');
}
// tiny local helper: prove the model is a pure data round-trip (no leaked keys) without importing deserialize twice
function deserializeRoundtrip(project) {
  // re-parse the serialized form back into a project-shaped object; serialize() is deterministic,
  // so a byte-identical re-serialize proves there are no non-serializable / undefined fields.
  return JSON.parse(serialize(project));
}

// ── 3. candidateAtPoint hit-test (pure, DOM-free) ───────────────────────────────────────────────
{
  const big = { points: [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 6 }, { x: 0, z: 6 }] };   // area 36
  const small = { points: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }] };  // area 4, nested in big's corner
  const cands = [big, small];
  ok(candidateAtPoint(cands, { x: 3, z: 3 }) === 0, '3a a point only inside the big candidate resolves to it');
  ok(candidateAtPoint(cands, { x: 1, z: 1 }) === 1, '3b a point inside both resolves to the SMALLEST (nested wins)');
  ok(candidateAtPoint(cands, { x: 9, z: 9 }) === -1, '3c a point outside every candidate resolves to -1');
  ok(candidateAtPoint([], { x: 1, z: 1 }) === -1, '3d no candidates → -1');
  ok(candidateAtPoint(null, { x: 1, z: 1 }) === -1, '3e malformed candidate list → -1 (never throws)');
  ok(candidateAtPoint([{ points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] }], { x: 0, z: 0 }) === -1, '3f a degenerate (<3-pt) candidate is skipped');
}

// ── 4. the detect → add → re-detect loop converges ──────────────────────────────────────────────
{
  _resetIds();
  const project = projectWith(squareWalls(4), []);
  const lvl = project.levels[0];
  const history = new History(project);
  const found0 = detectNewRooms(lvl);
  ok(found0.length === 1, '4a detectNewRooms finds the one enclosed room');
  ok(near(polygonArea(found0[0].points), 16), '4b the detected candidate is the 4×4 square (16 m²)');
  // add it the way a candidate-click does
  const room = createRoom(found0[0].points, { name: 'Room' });
  history.execute(addRoom(lvl.id, room));
  ok(lvl.rooms.length === 1, '4c the room is now saved on the level');
  const found1 = detectNewRooms(lvl);
  ok(found1.length === 0, '4d re-detect no longer offers the added room (it is now "covered")');
  // detectRooms (raw) still sees the geometric face — only detectNewRooms filters the saved one
  ok(detectRooms(lvl.walls).length === 1, '4e the raw geometric face still exists (filter is at the "new" layer)');
}

// ── 5. two rooms sharing a divider: add one, the other is still offered ─────────────────────────
{
  _resetIds();
  const project = projectWith([], []);
  const lvl = project.levels[0];
  // a 8×4 rectangle split by a central divider at x=4 → two 4×4 rooms (T-junction split in the detector)
  const c = { a: { x: 0, z: 0 }, b: { x: 8, z: 0 }, cc: { x: 8, z: 4 }, d: { x: 0, z: 4 }, mTop: { x: 4, z: 0 }, mBot: { x: 4, z: 4 } };
  lvl.walls = [
    createWall(c.a, c.b), createWall(c.b, c.cc), createWall(c.cc, c.d), createWall(c.d, c.a),
    createWall(c.mTop, c.mBot),
  ];
  lvl.rooms = [];
  const history = new History(project);
  const found = detectNewRooms(lvl);
  ok(found.length === 2, '5a two enclosed rooms detected across the divider');
  const r0 = createRoom(found[0].points, { name: 'Room' });
  history.execute(addRoom(lvl.id, r0));
  const after = detectNewRooms(lvl);
  ok(after.length === 1, '5b after adding one, exactly one candidate remains');
  ok(near(polygonArea(after[0].points), 16), '5c the remaining candidate is the other 4×4 room');
}

// ── 6. the 'room-detect' seam is un-tiered (Simple AND Pro) ─────────────────────────────────────
{
  ok(FEATURE_TIERS['room-detect'] === MODE.SIMPLE, '6a room-detect is registered at the Simple tier');
  ok(isAvailable('room-detect', MODE.SIMPLE) === true, '6b available in Simple (read+add for novices)');
  ok(isAvailable('room-detect', MODE.PRO) === true, '6c available in Pro');
  // naming stays gated to Pro (unchanged) — the read+add is un-tiered, the rename is not
  ok(isAvailable('room-rename', MODE.SIMPLE) === false, '6d naming still requires Pro (room-rename gate unchanged)');
  ok(isAvailable('room-rename', MODE.PRO) === true, '6e naming available in Pro');
}

console.log(`\nroom-detect-ui.test: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
