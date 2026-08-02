// A3 — label a wall/opening (engine-independent verification).
// Run: node src/test/element-label.test.mjs
//
// A3 extends the room-rename seam to walls and openings: a Pro user can give a selected wall or
// opening an OPTIONAL free-text label (e.g. "Front door", "Party wall"). Every piece of logic is
// pure and lives in core/edit/app:
//   • setElementLabel(levelId, kind, id, label) — the undoable command; the ONE place a save
//     field is added, and it's optional (empty clears the key), so old saves stay byte-identical
//   • buildElementLabel(project, selection, value) — trims/collapses/caps + emits the command,
//     allowing an empty value (clear) unlike a room name; { unchanged } skips no-op history
//   • describeSelection(...).rename — the Pro-gated label slot + title-reflects-label behaviour
// The DOM harness only has to confirm the wiring renders + updates; this file proves the logic
// end-to-end. It lives in its own file (not edit-core.test.mjs) so it never collides with other
// in-flight test work (the pick-protocol rule the roof suite established).
import {
  createProject, createLevel, createWall, createOpening, validateProject,
  serialize, deserialize, findWall, findOpening, _resetIds,
} from '../core/model.js';
import { setElementLabel } from '../edit/commands.js';
import { describeSelection, buildElementLabel, MAX_ELEMENT_LABEL } from '../app/inspector.js';
import { isAvailable, MODE } from '../app/state.js';
import { History } from '../edit/history.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// A one-level home: a single 4 m wall with a door on it. Neither carries a `label` (Phase 1
// never wrote one), so this doubles as an "old save" — it must validate and round-trip clean.
function makeProject() {
  _resetIds();
  const wall = createWall({ x: 0, z: 0 }, { x: 4, z: 0 });
  const door = createOpening(wall.id, 'door', { offset: 1, width: 0.9 });
  const level = createLevel({ name: 'Ground', walls: [wall], openings: [door] });
  const project = createProject({ name: 'A3', levels: [level] });
  return { project, level, wall, door };
}

// ---- 1) the command: setElementLabel writes the optional field on a wall / opening ----------
{
  const { project, level, wall, door } = makeProject();
  const h = new History(project);
  h.execute(setElementLabel(level.id, 'wall', wall.id, 'Party wall'));
  ok(findWall(level, wall.id).label === 'Party wall', '1a setElementLabel sets a wall label');
  h.execute(setElementLabel(level.id, 'door', door.id, 'Front door'));
  ok(findOpening(level, door.id).label === 'Front door', '1b setElementLabel sets an opening label');
  // model still valid with the new (optional) field present
  ok(validateProject(project).ok, '1c project stays valid with labels set');
  // a set→re-set overwrites the prior label (not appends)
  h.execute(setElementLabel(level.id, 'wall', wall.id, 'Exterior'));
  ok(findWall(level, wall.id).label === 'Exterior', '1d re-labelling overwrites the prior label');
  // missing element throws (guards a stale selection)
  let threw = false;
  try { setElementLabel(level.id, 'wall', 'nope', 'x').do(project); } catch { threw = true; }
  ok(threw, '1e labelling a missing element throws');
}

// ---- 2) LOSSLESS undo: labelling then undoing an unlabelled element deletes the key ---------
// The critical Phase-1 guarantee: a wall/opening that had NO label must, after label→undo,
// serialize BYTE-IDENTICALLY to before — the key must be deleted, not left as `undefined`.
{
  const { project, level, wall, door } = makeProject();
  const before = serialize(project);
  const h = new History(project);
  h.execute(setElementLabel(level.id, 'wall', wall.id, 'Party wall'));
  ok(serialize(project) !== before, '2a serialize changes once a label is set');
  ok(Object.prototype.hasOwnProperty.call(findWall(level, wall.id), 'label'), '2b label key present after set');
  h.undo();
  ok(!Object.prototype.hasOwnProperty.call(findWall(level, wall.id), 'label'), '2c undo DELETES the label key (not set to undefined)');
  ok(serialize(project) === before, '2d undo of a first label is byte-lossless');
  // redo re-applies, undo removes again — stable across the round-trip
  h.redo();
  ok(findWall(level, wall.id).label === 'Party wall', '2e redo re-applies the label');
  h.undo();
  ok(serialize(project) === before, '2f second undo is byte-lossless again');
  // same guarantee for an opening
  const beforeO = serialize(project);
  h.execute(setElementLabel(level.id, 'door', door.id, 'Front door'));
  h.undo();
  ok(serialize(project) === beforeO, '2g opening label→undo is byte-lossless');
}

// ---- 3) undo RESTORES a prior label when the element already had one ------------------------
{
  const { project, level, wall } = makeProject();
  const h = new History(project);
  h.execute(setElementLabel(level.id, 'wall', wall.id, 'First'));
  const afterFirst = serialize(project);
  h.execute(setElementLabel(level.id, 'wall', wall.id, 'Second'));
  ok(findWall(level, wall.id).label === 'Second', '3a second label applied');
  h.undo();
  ok(findWall(level, wall.id).label === 'First', '3b undo restores the PRIOR label (not deleted)');
  ok(serialize(project) === afterFirst, '3c undo to a prior label is byte-lossless');
}

// ---- 4) CLEARING a label removes the key (empty label is legal, unlike a room name) ---------
{
  const { project, level, wall } = makeProject();
  const clean = serialize(project);
  const h = new History(project);
  h.execute(setElementLabel(level.id, 'wall', wall.id, 'Temp'));
  h.execute(setElementLabel(level.id, 'wall', wall.id, ''));
  ok(!Object.prototype.hasOwnProperty.call(findWall(level, wall.id), 'label'), '4a setting an empty label deletes the key');
  ok(serialize(project) === clean, '4b clearing back to no-label is byte-identical to the original');
  h.undo();
  ok(findWall(level, wall.id).label === 'Temp', '4c undo of a clear restores the label');
}

// ---- 5) old saves stay valid + round-trip is byte-identical after a full save cycle ---------
{
  const { project, level, wall } = makeProject();
  // an "old save" (no labels anywhere) must validate + round-trip
  const roundtrip = serialize(deserialize(serialize(project)));
  ok(validateProject(deserialize(serialize(project))).ok, '5a a labelless (old) save still validates');
  ok(roundtrip === serialize(project), '5b labelless save round-trips byte-identically');
  // set a label, then prove serialize→deserialize→serialize is byte-identical (the field persists)
  new History(project).execute(setElementLabel(level.id, 'wall', wall.id, 'Gable end'));
  const s1 = serialize(project);
  const s2 = serialize(deserialize(s1));
  ok(s1 === s2, '5c a labelled save round-trips byte-identically');
  ok(deserialize(s1).levels[0].walls[0].label === 'Gable end', '5d the label survives a save/load cycle');
  ok(validateProject(deserialize(s1)).ok, '5e a labelled save validates');
}

// ---- 6) buildElementLabel: the inspector's trim/collapse/cap + set/clear/unchanged path -----
{
  const { project, level, wall, door } = makeProject();
  const wSel = { kind: 'wall', id: wall.id };
  const oSel = { kind: 'opening', id: door.id };
  // whitespace is trimmed + collapsed
  const r1 = buildElementLabel(project, wSel, '  Front   wall  ');
  ok(r1.command && r1.label === 'Front wall', '6a label is trimmed + whitespace-collapsed');
  // capped at MAX_ELEMENT_LABEL
  const long = 'x'.repeat(MAX_ELEMENT_LABEL + 20);
  ok(buildElementLabel(project, wSel, long).label.length === MAX_ELEMENT_LABEL, '6b label capped at MAX_ELEMENT_LABEL');
  // empty on an UNlabelled element is a no-op (nothing to clear → no history churn)
  ok(buildElementLabel(project, wSel, '   ').unchanged === true, '6c empty on an unlabelled element is unchanged');
  // an opening can be labelled too
  ok(buildElementLabel(project, oSel, 'Front door').command, '6d openings label through the same builder');
  // a non-wall/opening selection is rejected
  ok(buildElementLabel(project, { kind: 'room', id: 'r1' }, 'x').error, '6e a room selection is rejected (rooms rename, not label)');
  ok(buildElementLabel(project, null, 'x').error, '6f a null selection is rejected');
  // set, then setting the SAME value is unchanged (blur that changed nothing pushes no history)
  const h = new History(project);
  h.execute(buildElementLabel(project, wSel, 'Load-bearing').command);
  ok(buildElementLabel(project, wSel, 'Load-bearing').unchanged === true, '6g re-committing the same label is unchanged');
  // clearing a LABELLED element emits a command (empty is legal here)
  ok(buildElementLabel(project, wSel, '').command, '6h clearing a labelled element emits a (clear) command');
}

// ---- 7) describeSelection: the Pro-gated label slot + title-reflects-label ------------------
{
  const { project, wall, door } = makeProject();
  const wSel = { kind: 'wall', id: wall.id };
  // Simple: no rename slot (novice keeps a clean read-only card), title is the plain type name
  const wSimple = describeSelection(project, wSel, { mode: MODE.SIMPLE });
  ok(!wSimple.rename, '7a Simple shows no label field on a wall (clean card)');
  ok(wSimple.title === 'Wall', '7b unlabelled wall titles as "Wall"');
  // Pro: a rename slot keyed to `label`, empty value + a helpful placeholder
  const wPro = describeSelection(project, wSel, { mode: MODE.PRO });
  ok(wPro.rename && wPro.rename.key === 'label', '7c Pro exposes an editable label slot on a wall');
  ok(wPro.rename.value === '' && /optional/i.test(wPro.rename.placeholder), '7d empty label shows a placeholder');
  // once labelled, the title reflects the label (both tiers) — a named element reads by its name
  new History(project).execute(setElementLabel(project.levels[0].id, 'wall', wall.id, 'Party wall'));
  ok(describeSelection(project, wSel, { mode: MODE.SIMPLE }).title === 'Party wall', '7e a labelled wall titles by its label');
  ok(describeSelection(project, wSel, { mode: MODE.PRO }).rename.value === 'Party wall', '7f the Pro slot shows the current label');
  // an opening: default title is Door/Window; label overrides it
  const oSel = { kind: 'opening', id: door.id };
  ok(describeSelection(project, oSel, { mode: MODE.PRO }).title === 'Door', '7g unlabelled opening titles by kind (Door)');
  new History(project).execute(setElementLabel(project.levels[0].id, 'door', door.id, 'Front entry'));
  ok(describeSelection(project, oSel, { mode: MODE.PRO }).title === 'Front entry', '7h a labelled door titles by its label');
}

// ---- 8) the seam registers once, Pro-only (no scattered if(pro)) ---------------------------
{
  ok(isAvailable('element-label', MODE.PRO) && !isAvailable('element-label', MODE.SIMPLE),
    '8a element-label registers once in the tier table (Pro-only)');
}

// ---- 9) labelling never touches geometry — the model's counts are unchanged ----------------
{
  const { project, level, wall } = makeProject();
  const wallsBefore = level.walls.length, openBefore = level.openings.length;
  new History(project).execute(setElementLabel(level.id, 'wall', wall.id, 'x'));
  ok(level.walls.length === wallsBefore && level.openings.length === openBefore,
    '9a labelling adds/removes no walls or openings (metadata only)');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'SOME FAILED'} — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
