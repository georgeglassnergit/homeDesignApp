// A2 — hover-highlight the room under the plan cursor (engine-independent verification).
// Run: node src/test/room-hover-plan.test.mjs
//
// Hover is pure VIEW state: on pointer-move the plan resolves which room the cursor is over
// and warms its fill — no command, no history push, no model/save touch. All of the logic is
// the exported pure resolver hoverRoomId(level, point, tool):
//   • it reuses roomAtPoint (smallest-containing-room-wins) to find the room under the point
//   • it is gated to the SELECT tool, so hovering never warms a room while drawing walls/doors
//   • it returns a room id or null (null off every room, null under any non-select tool)
// This file proves that resolver end-to-end so the DOM harness only has to confirm the fill
// changes on move. It lives in its own file (not edit-core.test.mjs) so it never collides with
// other in-flight test work (the pick-protocol rule the roof suite established).
import {
  createProject, createLevel, createRoom, serialize, _resetIds,
} from '../core/model.js';
import { hoverRoomId } from '../app/planCanvas.js';
import { TOOL } from '../app/state.js';
import { History } from '../edit/history.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// A two-room level: a big 6×6 living room and a small 2×2 closet nested in its corner, so we can
// prove an ordinary hover, an off-room miss, and the "smallest containing room wins" tie-break
// (hovering the closet's corner warms the closet, not the living room it sits inside) — mirrors
// the A1 fixture so both plan gestures resolve rooms the same way.
function makeProject() {
  _resetIds();
  const living = createRoom([{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 6 }, { x: 0, z: 6 }], { name: 'Living' });
  const closet = createRoom([{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }], { name: 'Closet' });
  const level = createLevel({ name: 'Ground', rooms: [living, closet] });
  const project = createProject({ name: 'A2', levels: [level] });
  return { project, level, living, closet };
}

// ---- 1) hover resolves the room under the cursor (SELECT tool) -----------------------------
{
  const { level, living, closet } = makeProject();
  ok(hoverRoomId(level, { x: 4, z: 4 }, TOOL.SELECT) === living.id, '1a hovering the open living area warms Living');
  ok(hoverRoomId(level, { x: 1, z: 1 }, TOOL.SELECT) === closet.id, '1b hovering the overlap warms the SMALLER room (Closet)');
  ok(hoverRoomId(level, { x: 9, z: 9 }, TOOL.SELECT) === null, '1c hovering outside every room warms nothing (null)');
  ok(hoverRoomId(level, { x: 6, z: 6 }, TOOL.SELECT) === null, '1d hovering exactly on a corner warms nothing (half-open edge test)');
}

// ---- 2) the SELECT-tool gate: no room warms under a drawing/placing tool -------------------
{
  const { level, living } = makeProject();
  ok(hoverRoomId(level, { x: 4, z: 4 }, TOOL.DRAW_WALL) === null, '2a hovering while DRAW_WALL warms nothing (gate closed)');
  ok(hoverRoomId(level, { x: 4, z: 4 }, TOOL.PLACE_DOOR) === null, '2b hovering while PLACE_DOOR warms nothing');
  ok(hoverRoomId(level, { x: 4, z: 4 }, TOOL.PLACE_WINDOW) === null, '2c hovering while PLACE_WINDOW warms nothing');
  ok(hoverRoomId(level, { x: 4, z: 4 }, TOOL.MEASURE) === null, '2d hovering while MEASURE warms nothing');
  ok(hoverRoomId(level, { x: 4, z: 4 }, TOOL.SELECT) === living.id, '2e ...but the very same point warms under SELECT');
}

// ---- 3) null-safety mirrors roomAtPoint (never throws on a degenerate level) ---------------
{
  ok(hoverRoomId({ rooms: [] }, { x: 1, z: 1 }, TOOL.SELECT) === null, '3a an empty level warms nothing');
  ok(hoverRoomId(null, { x: 1, z: 1 }, TOOL.SELECT) === null, '3b a null level warms nothing (no throw)');
  ok(hoverRoomId({ rooms: [] }, { x: 1, z: 1 }, undefined) === null, '3c an undefined tool warms nothing (gate closed)');
}

// ---- 4) hover is view-only: resolving it emits no command and never touches the save --------
{
  const { project, level } = makeProject();
  const before = serialize(project);
  const history = new History(project, { limit: 50 });
  const depth0 = history.undoStack.length;
  // "move" the cursor across several points, as pointermove would — hover recomputes each time.
  for (const p of [{ x: 4, z: 4 }, { x: 1, z: 1 }, { x: 9, z: 9 }, { x: 5, z: 5 }]) hoverRoomId(level, p, TOOL.SELECT);
  ok(history.undoStack.length === depth0, '4a hovering pushes nothing to history (not a command)');
  ok(serialize(project) === before, '4b the model save is byte-identical after hovering (no model touch)');
}

// ---- 5) hover and selection are independent view state (hover doesn't change selection) -----
{
  const { level, living, closet } = makeProject();
  // hovering one room while another is "selected" is fine — the resolver knows nothing of
  // selection; the renderer simply prefers the selected fill (proven in the headless harness).
  const h = hoverRoomId(level, { x: 4, z: 4 }, TOOL.SELECT);
  ok(h === living.id && h !== closet.id, '5a the hover resolver is pure of selection — it just returns the room under the point');
}

if (fail) { console.log(`\n${fails.length} FAILED`); console.log('FAILURES:\n  ' + fails.join('\n  ')); process.exit(1); }
else console.log(`\nALL PASS — ${pass} passed, 0 failed`);
