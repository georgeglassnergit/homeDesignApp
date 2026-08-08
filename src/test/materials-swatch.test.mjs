// E1 — materials library / swatch (engine-independent verification).
// Run: node src/test/materials-swatch.test.mjs
//
// E1 activates the dormant `materials-swatch` seam: a Simple-tier palette of surface finishes a
// user applies to a selected wall or floor from the inspector. Every piece of logic is pure and
// lives in core/edit/app (zero Three.js — the render layer resolves a chosen finish through the
// EXISTING material registry, unchanged):
//   • MATERIAL_LIBRARY / materialDef / isLibraryMaterial (core/model.js) — the catalog
//   • setElementMaterial(levelId, kind, id, materialId, def) — the undoable command; it repoints
//     the element's ALREADY-EXISTING `material` key and registers a library finish on first use,
//     removing it again on undo, so NO new save field is introduced and undo is byte-lossless
//   • buildSetMaterial(project, selection, materialId) — validates + emits the command; { unchanged }
//     skips a no-op re-click; { error } rejects a bad selection or an unknown id
//   • describeSelection(...).materials — the swatch slot (both tiers; current finish + options)
// It lives in its own file (not edit-core.test.mjs) so it never collides with in-flight test work
// (the pick-protocol rule the roof suite established).
import {
  createProject, createLevel, createWall, createRoom, validateProject,
  serialize, deserialize, findWall, findRoom, _resetIds,
  MATERIAL_LIBRARY, materialDef, isLibraryMaterial,
} from '../core/model.js';
import { setElementMaterial } from '../edit/commands.js';
import { describeSelection, buildSetMaterial } from '../app/inspector.js';
import { isAvailable, MODE } from '../app/state.js';
import { History } from '../edit/history.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// A one-level home: one 4 m wall + one room (floor). Neither carries a library finish (they use
// the base 'wall'/'floor' roles from defaultMaterials()), so this doubles as an "old save" — it
// must validate and round-trip byte-identically before and after a finish is applied+undone.
function makeProject() {
  _resetIds();
  const wall = createWall({ x: 0, z: 0 }, { x: 4, z: 0 });
  const room = createRoom([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], { name: 'Living' });
  const level = createLevel({ name: 'Ground', walls: [wall], rooms: [room] });
  const project = createProject({ name: 'E1', levels: [level] });
  return { project, level, wall, room };
}

// ---- 1) the command: setElementMaterial repoints the material + registers the finish ---------
{
  const { project, level, wall, room } = makeProject();
  const h = new History(project);
  const brick = materialDef('red-brick');
  ok(!('red-brick' in project.materials), '1a the finish is NOT in project.materials before use');
  h.execute(setElementMaterial(level.id, 'wall', wall.id, 'red-brick', brick));
  ok(findWall(level, wall.id).material === 'red-brick', '1b command repoints the wall material key');
  ok(project.materials['red-brick'] && project.materials['red-brick'].color === brick.color,
    '1c the finish definition is registered in project.materials on first use');
  ok(validateProject(project).ok, '1d project stays valid after applying a finish');
  // a floor (room) takes a finish through the same command via the 'room' finder
  h.execute(setElementMaterial(level.id, 'room', room.id, 'oak', materialDef('oak')));
  ok(findRoom(level, room.id).material === 'oak', '1e command applies a finish to a floor (room)');
  // missing element throws (guards a stale selection)
  let threw = false;
  try { setElementMaterial(level.id, 'wall', 'nope', 'oak', materialDef('oak')).do(project); } catch { threw = true; }
  ok(threw, '1f applying to a missing element throws');
}

// ---- 2) LOSSLESS undo: apply a finish then undo → byte-identical (key repointed + preset removed)
{
  const { project, level, wall } = makeProject();
  const before = serialize(project);
  const h = new History(project);
  h.execute(setElementMaterial(level.id, 'wall', wall.id, 'slate', materialDef('slate')));
  ok(serialize(project) !== before, '2a serialize changes once a finish is applied');
  ok('slate' in project.materials, '2b the finish key is present after apply');
  h.undo();
  ok(findWall(level, wall.id).material === 'wall', '2c undo restores the prior material key');
  ok(!('slate' in project.materials), '2d undo REMOVES the preset this command added (no orphan key)');
  ok(serialize(project) === before, '2e apply→undo is byte-lossless');
  // redo re-applies, undo removes again — stable across the round-trip
  h.redo();
  ok(findWall(level, wall.id).material === 'slate' && 'slate' in project.materials, '2f redo re-applies + re-registers');
  h.undo();
  ok(serialize(project) === before, '2g second undo is byte-lossless again');
}

// ---- 3) a finish shared by two elements: LIFO add/remove keeps it while still referenced ------
{
  const { project, level, wall, room } = makeProject();
  const h = new History(project);
  h.execute(setElementMaterial(level.id, 'wall', wall.id, 'sage', materialDef('sage')));   // adds 'sage'
  h.execute(setElementMaterial(level.id, 'room', room.id, 'sage', materialDef('sage')));   // 'sage' already present → no add
  ok(findWall(level, wall.id).material === 'sage' && findRoom(level, room.id).material === 'sage',
    '3a both elements carry the shared finish');
  h.undo();  // undo the room apply — must NOT remove 'sage' (still used by the wall)
  ok('sage' in project.materials, '3b undoing the second apply keeps the finish (still referenced)');
  ok(findRoom(level, room.id).material === 'floor', '3c the room reverts to its default');
  h.undo();  // undo the wall apply — the command that ADDED 'sage' → removes it
  ok(!('sage' in project.materials), '3d undoing the apply that added the finish removes it');
}

// ---- 4) applying a base role (already in the map) adds no key + undoes cleanly ----------------
{
  const { project, level, wall } = makeProject();
  const before = serialize(project);
  const keysBefore = Object.keys(project.materials).length;
  const h = new History(project);
  // 'roof' is a base role already present in defaultMaterials(); buildSetMaterial passes def=null
  h.execute(setElementMaterial(level.id, 'wall', wall.id, 'roof', null));
  ok(findWall(level, wall.id).material === 'roof', '4a a wall can take a base-role material');
  ok(Object.keys(project.materials).length === keysBefore, '4b applying an existing key adds nothing to the map');
  h.undo();
  ok(serialize(project) === before, '4c undo of an existing-key apply is byte-lossless');
}

// ---- 5) old saves stay valid + round-trip byte-identical after a full save cycle -------------
{
  const { project, level, wall } = makeProject();
  const roundtrip = serialize(deserialize(serialize(project)));
  ok(validateProject(deserialize(serialize(project))).ok, '5a a finishless (old) save still validates');
  ok(roundtrip === serialize(project), '5b finishless save round-trips byte-identically');
  // apply a finish, then prove serialize→deserialize→serialize is byte-identical (both fields persist)
  new History(project).execute(setElementMaterial(level.id, 'wall', wall.id, 'walnut', materialDef('walnut')));
  const s1 = serialize(project);
  const s2 = serialize(deserialize(s1));
  ok(s1 === s2, '5c a finished save round-trips byte-identically');
  const rt = deserialize(s1);
  ok(rt.levels[0].walls[0].material === 'walnut' && rt.materials.walnut, '5d the finish + its definition survive save/load');
  ok(validateProject(rt).ok, '5e a finished save validates');
}

// ---- 6) buildSetMaterial: the inspector's validate + set/unchanged/reject paths ---------------
{
  const { project, wall, room } = makeProject();
  const wSel = { kind: 'wall', id: wall.id };
  const rSel = { kind: 'room', id: room.id };
  // a known library finish → a command
  const r1 = buildSetMaterial(project, wSel, 'red-brick');
  ok(r1.command && r1.materialId === 'red-brick', '6a a library finish emits a command');
  // a floor takes a finish through the same builder
  ok(buildSetMaterial(project, rSel, 'oak').command, '6b a room (floor) applies through the same builder');
  // an already-applied finish is unchanged (a re-click pushes no history)
  new History(project).execute(buildSetMaterial(project, wSel, 'concrete').command);
  ok(buildSetMaterial(project, wSel, 'concrete').unchanged === true, '6c re-applying the current finish is unchanged');
  // an unknown id is rejected (guards against a phantom material key)
  ok(buildSetMaterial(project, wSel, 'not-a-finish').error, '6d an unknown material id is rejected');
  // a base role already present in project.materials is accepted (not a library id, but resolvable)
  ok(buildSetMaterial(project, rSel, 'wall').command, '6e a base role already in the map is accepted');
  // an opening / null selection is rejected (openings are voids, not surfaces)
  ok(buildSetMaterial(project, { kind: 'opening', id: 'x' }, 'oak').error, '6f an opening selection is rejected');
  ok(buildSetMaterial(project, null, 'oak').error, '6g a null selection is rejected');
}

// ---- 7) describeSelection: the swatch slot (both tiers), absent on an opening -----------------
{
  const { project, wall, room } = makeProject();
  const wSel = { kind: 'wall', id: wall.id };
  const rSel = { kind: 'room', id: room.id };
  // materials-swatch is a Simple-tier seam → the slot appears in BOTH modes
  const wSimple = describeSelection(project, wSel, { mode: MODE.SIMPLE });
  const wPro = describeSelection(project, wSel, { mode: MODE.PRO });
  ok(wSimple.materials && wSimple.materials.key === 'material', '7a a wall carries a materials slot in Simple');
  ok(wPro.materials, '7b a wall carries a materials slot in Pro too');
  // the slot reports the current finish + a swatch list including the whole library
  ok(wSimple.materials.current === 'wall', '7c the slot reports the current finish (the wall default)');
  ok(wSimple.materials.options.length >= MATERIAL_LIBRARY.length, '7d the slot lists at least the whole library');
  // the current finish (a base role not in the library) is prepended so it stays selectable
  ok(wSimple.materials.options.some((o) => o.id === 'wall'), '7e the current base-role finish is shown/selectable');
  // a room (floor) also carries the slot; an opening does NOT (it is a void, not a surface)
  ok(describeSelection(project, rSel, { mode: MODE.SIMPLE }).materials, '7f a room (floor) carries a materials slot');
  // once a library finish is applied, the slot reflects it and it appears in the options
  new History(project).execute(buildSetMaterial(project, wSel, 'terracotta').command);
  const wAfter = describeSelection(project, wSel, { mode: MODE.PRO });
  ok(wAfter.materials.current === 'terracotta', '7g the slot reflects the newly applied finish');
  ok(wAfter.materials.options.some((o) => o.id === 'terracotta'), '7h the applied finish is in the swatch list');
  // colour resolution: the current swatch colour matches the catalog colour
  ok(wAfter.materials.currentColor === materialDef('terracotta').color, '7i the slot resolves the current finish colour');
}

// ---- 8) the seam registers once, Simple-tier (available in both modes) ------------------------
{
  ok(isAvailable('materials-swatch', MODE.SIMPLE) && isAvailable('materials-swatch', MODE.PRO),
    '8a materials-swatch registers once in the tier table (Simple → both modes)');
}

// ---- 9) applying a finish never touches geometry — model counts are unchanged -----------------
{
  const { project, level, wall } = makeProject();
  const wallsBefore = level.walls.length, roomsBefore = level.rooms.length, openBefore = level.openings.length;
  new History(project).execute(setElementMaterial(level.id, 'wall', wall.id, 'deep-navy', materialDef('deep-navy')));
  ok(level.walls.length === wallsBefore && level.rooms.length === roomsBefore && level.openings.length === openBefore,
    '9a applying a finish adds/removes no walls, rooms or openings (a surface property only)');
}

// ---- 10) the catalog is well-formed (unique ids, valid colours, helper consistency) ----------
{
  const ids = MATERIAL_LIBRARY.map((m) => m.id);
  ok(new Set(ids).size === ids.length, '10a every library finish has a unique id');
  ok(MATERIAL_LIBRARY.every((m) => /^#[0-9a-fA-F]{6}$/.test(m.color)), '10b every finish has a valid 6-digit hex colour');
  ok(MATERIAL_LIBRARY.every((m) => typeof m.label === 'string' && m.label.length > 0), '10c every finish has a human label');
  ok(MATERIAL_LIBRARY.every((m) => isLibraryMaterial(m.id) && materialDef(m.id) === m), '10d isLibraryMaterial/materialDef agree with the catalog');
  ok(materialDef('nope') === null && !isLibraryMaterial('nope'), '10e an unknown id resolves to null / not-a-library-material');
  ok(Object.isFrozen(MATERIAL_LIBRARY) && MATERIAL_LIBRARY.every(Object.isFrozen), '10f the catalog is frozen (immutable)');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'SOME FAILED'} — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
