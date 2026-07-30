// A1 — rename a room by double-clicking it on the plan (engine-independent verification).
// Run: node src/test/room-rename-plan.test.mjs
//
// The plan-side rename is a VIEW wiring (main.js opens a floating <input> over the room's
// centroid), but every piece of logic it composes is pure and lives in core/app:
//   • roomAtPoint(level, world) resolves which room a double-click landed in
//   • polygonCentroid(points) places the inline editor (and must fall inside the room)
//   • buildRoomRename(project, selection, value) builds the SAME renameRoom command the
//     inspector uses — same trim/collapse/cap/validate, same byte-lossless undo
// This file proves that composition end-to-end so the DOM harness only has to confirm the
// wiring renders. It lives in its own file (not edit-core.test.mjs) so it never collides
// with other in-flight test work (the pick-protocol rule the roof suite established).
import {
  createProject, createLevel, createRoom, validateProject,
  serialize, deserialize, findRoom, roomAtPoint, polygonCentroid, pointInPolygon, _resetIds,
} from '../core/model.js';
import { buildRoomRename, MAX_ROOM_NAME } from '../app/inspector.js';
import { History } from '../edit/history.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// A two-room level: a big 6×6 living room and a small 2×2 closet nested in its corner, so we
// can prove both an ordinary hit and the "smallest containing room wins" tie-break (a closet
// double-click renames the closet, not the living room it sits inside).
function makeProject() {
  _resetIds();
  const living = createRoom([{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 6 }, { x: 0, z: 6 }], { name: 'Living' });
  const closet = createRoom([{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }], { name: 'Closet' });
  const level = createLevel({ name: 'Ground', rooms: [living, closet] });
  const project = createProject({ name: 'A1', levels: [level] });
  return { project, level, living, closet };
}

// ---- 1) hit-test: a double-click resolves the room under the cursor -----------------------
{
  const { level, living, closet } = makeProject();
  ok(roomAtPoint(level, { x: 4, z: 4 }).id === living.id, '1a click in the open living area resolves Living');
  ok(roomAtPoint(level, { x: 1, z: 1 }).id === closet.id, '1b click in the overlap resolves the SMALLER room (Closet)');
  ok(roomAtPoint(level, { x: 9, z: 9 }) === null, '1c click outside every room resolves null (no rename opens)');
  ok(roomAtPoint({ rooms: [] }, { x: 1, z: 1 }) === null, '1d empty level resolves null');
}

// ---- 2) editor placement: the centroid the editor floats over falls inside the room -------
{
  const { living, closet } = makeProject();
  const cL = polygonCentroid(living.points);
  const cC = polygonCentroid(closet.points);
  ok(pointInPolygon(cL, living.points), '2a Living centroid lies inside Living (editor sits on the room)');
  ok(pointInPolygon(cC, closet.points), '2b Closet centroid lies inside Closet');
  // and the centroid itself round-trips through the hit-test to the right room
  ok(roomAtPoint(makeProject().level, cL).name === 'Living', '2c double-clicking a room label (its centroid) renames that room');
}

// ---- 3) the shared command path: buildRoomRename from a plan-resolved room selection -------
{
  const { project, level } = makeProject();
  const room = roomAtPoint(level, { x: 4, z: 4 });          // as beginPlanRoomRename resolves it
  const selection = { kind: 'room', id: room.id };
  const before = serialize(project);

  const res = buildRoomRename(project, selection, '  Master  Suite  ');
  ok(res.command && !res.error, '3a plan-resolved room selection builds a rename command');
  ok(res.name === 'Master Suite', '3b whitespace is collapsed and trimmed before commit');

  const history = new History(project, { limit: 50 });
  history.execute(res.command);
  ok(findRoom(level, room.id).name === 'Master Suite', '3c executing the command renames the room');
  ok(validateProject(project).ok, '3d project still validates after the rename');

  // Lossless undo — the Phase 1 guarantee: rename→undo is byte-identical to the pre-rename save.
  history.undo();
  ok(serialize(project) === before, '3e undo restores the byte-identical save (lossless)');
  ok(findRoom(level, room.id).name === 'Living', '3f undo restores the exact prior name');
}

// ---- 4) input guards mirror the inspector exactly (same buildRoomRename) -------------------
{
  const { project, level } = makeProject();
  const sel = { kind: 'room', id: roomAtPoint(level, { x: 4, z: 4 }).id };
  ok(buildRoomRename(project, sel, '   ').error, '4a an all-whitespace name is rejected (editor keeps the old name)');
  ok(buildRoomRename(project, sel, 'Living').unchanged, '4b re-entering the current name is a no-op (no history push)');
  const longRes = buildRoomRename(project, sel, 'X'.repeat(MAX_ROOM_NAME + 40));
  ok(longRes.name.length === MAX_ROOM_NAME, '4c an over-long name is capped at MAX_ROOM_NAME');
  ok(buildRoomRename(project, { kind: 'wall', id: 'nope' }, 'Nope').error, '4d a non-room selection cannot be renamed here');
}

// ---- 5) old saves without the rename still round-trip (no new save field) ------------------
{
  const { project } = makeProject();
  const json = serialize(project);
  const reparsed = deserialize(json);
  ok(validateProject(reparsed).ok && serialize(reparsed) === json, '5a A1 adds no save field — the project round-trips unchanged');
}

if (fail) { console.log(`\n${fails.length} FAILED`); console.log('FAILURES:\n  ' + fails.join('\n  ')); process.exit(1); }
else console.log(`\nALL PASS — ${pass} passed, 0 failed`);
