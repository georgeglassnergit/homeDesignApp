// Roof ridge-direction override — engine-independent verification (plain Node, no Three.js).
// Run: node src/test/roof-ridge.test.mjs
//
// Proves the ridge-orientation control added to the pure roof-shape math and wired
// through the model + command layer:
//   • resolveRidgeAlongX resolves 'auto'|'x'|'z' to a concrete orientation
//   • roofSolid honours a forced ridge and stays backward-compatible ('auto' === old default)
//   • forcing a hip ridge along the shorter axis degenerates to a pyramid, never inverts
//   • createRoof carries the ridge field, validateProject gates it, setRoofType edits it losslessly
// Lives in its own file (not edit-core.test.mjs) so it composes with other in-flight work.
import {
  createProject, createLevel, createWall, createRoof, createRoom, validateProject,
  serialize, deserialize, findLevel, _resetIds,
} from '../core/model.js';
import {
  RIDGE_MODES, DEFAULT_RIDGE, resolveRidgeAlongX, roofSolid, roofFootprint, isPitched,
} from '../core/roofShape.js';
import { setRoofType } from '../edit/commands.js';
import { History } from '../edit/history.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const allFinite = (arr) => arr.every((v) => Number.isFinite(v));

// Footprints: WIDE (W=8 along X, D=4 along Z), SQUARE (4x4).
const WIDE = { x0: -4, x1: 4, z0: -2, z1: 2 };
const SQUARE = { x0: -2, x1: 2, z0: -2, z1: 2 };

// ---------------------------------------------------------------------------
// 1) resolveRidgeAlongX — the pure mode → orientation resolver
// ---------------------------------------------------------------------------
ok(resolveRidgeAlongX(WIDE, 'auto') === true, '1a auto on a wide (W>D) footprint runs the ridge along X (longer axis)');
ok(resolveRidgeAlongX({ x0: 0, x1: 4, z0: 0, z1: 8 }, 'auto') === false, '1b auto on a deep (D>W) footprint runs the ridge along Z');
ok(resolveRidgeAlongX(SQUARE, 'auto') === true, '1c auto on a square footprint favours X (W>=D)');
ok(resolveRidgeAlongX(WIDE, 'x') === true, "1d 'x' forces the ridge along X");
ok(resolveRidgeAlongX(WIDE, 'z') === false, "1e 'z' forces the ridge along Z (even though X is longer)");
ok(resolveRidgeAlongX({ x0: 0, x1: 4, z0: 0, z1: 8 }, 'x') === true, "1f 'x' forces X even when Z is the longer axis");
ok(resolveRidgeAlongX(WIDE, 'wat') === resolveRidgeAlongX(WIDE, 'auto'), '1g an unknown mode falls back to auto (never throws)');
ok(resolveRidgeAlongX(WIDE) === resolveRidgeAlongX(WIDE, 'auto'), '1h the default arg is auto');
ok(DEFAULT_RIDGE === 'auto' && RIDGE_MODES.join(',') === 'auto,x,z', '1i RIDGE_MODES / DEFAULT_RIDGE exported as expected');

// ---------------------------------------------------------------------------
// 2) roofSolid — backward compatibility (omitting ridge === 'auto' === old behaviour)
// ---------------------------------------------------------------------------
for (const type of ['gable', 'hip']) {
  const legacy = roofSolid(type, WIDE, { baseY: 3, pitch: 30 });               // no ridge arg
  const explicit = roofSolid(type, WIDE, { baseY: 3, pitch: 30, ridge: 'auto' });
  ok(legacy.positions.length === explicit.positions.length &&
     legacy.positions.every((v, i) => near(v, explicit.positions[i])),
     `2a-${type} omitting ridge is byte-identical to ridge:'auto' (no regression)`);
  ok(legacy.ridgeAlongX === true, `2b-${type} auto on the wide footprint keeps the ridge along X (previous default)`);
  ok(allFinite(legacy.positions) && legacy.positions.length % 9 === 0, `2c-${type} positions are all finite, 9 per triangle`);
}

// ---------------------------------------------------------------------------
// 3) roofSolid — a forced ridge actually flips the orientation & the geometry
// ---------------------------------------------------------------------------
// Gable on WIDE: auto ridge runs along X (slopes span the 4 m depth); forcing 'z'
// runs it along Z (slopes span the 8 m width) → a taller ridge at the same pitch.
const gA = roofSolid('gable', WIDE, { baseY: 0, pitch: 45 });        // auto → X, run = D/2 = 2 → rise 2
const gZ = roofSolid('gable', WIDE, { baseY: 0, pitch: 45, ridge: 'z' }); // forced Z, run = W/2 = 4 → rise 4
ok(gA.ridgeAlongX === true && gZ.ridgeAlongX === false, '3a forcing ridge:z flips ridgeAlongX from true to false');
ok(near(gA.ridgeY, 2), '3b auto gable ridge rises by the short-axis run (2 m at 45°)');
ok(near(gZ.ridgeY, 4), '3c forced-Z gable ridge rises by the long-axis run (4 m at 45°) — the geometry really changed');
// Forcing 'x' on the wide footprint is a no-op vs auto (X already the longer axis).
const gX = roofSolid('gable', WIDE, { baseY: 0, pitch: 45, ridge: 'x' });
ok(gX.positions.length === gA.positions.length && gX.positions.every((v, i) => near(v, gA.positions[i])),
   "3d forcing 'x' on a wide footprint matches auto (X already longer)");
ok(allFinite(gZ.positions), '3e forced-ridge gable positions are all finite');

// ---------------------------------------------------------------------------
// 4) roofSolid — hip clamp: forcing the ridge along the shorter axis makes a pyramid,
//    never an inverted/self-crossing shell.
// ---------------------------------------------------------------------------
const hipAuto = roofSolid('hip', WIDE, { baseY: 0, pitch: 30 });          // auto → X, proper ridge
ok(hipAuto.ridgeAlongX === true && hipAuto.apex === null, '4a auto hip on a wide footprint is a proper (non-degenerate) hip');
const hipForcedShort = roofSolid('hip', WIDE, { baseY: 0, pitch: 30, ridge: 'z' }); // forced along short axis
ok(hipForcedShort.ridgeAlongX === false && hipForcedShort.apex !== null,
   '4b forcing a hip ridge along the shorter axis collapses to a pyramid apex (clamped, not inverted)');
ok(allFinite(hipForcedShort.positions) && hipForcedShort.triangleCount > 0, '4c the clamped hip is still finite geometry with real triangles');
// A square footprint hip is a pyramid under auto too (the pre-existing behaviour is preserved).
const hipSquare = roofSolid('hip', SQUARE, { baseY: 0, pitch: 30 });
ok(hipSquare.apex !== null, '4d a square-footprint hip is still a pyramid under auto (no regression)');

// ---------------------------------------------------------------------------
// 5) Model layer — createRoof carries the ridge field; validateProject gates it
// ---------------------------------------------------------------------------
_resetIds();
ok(createRoof().ridge === 'auto', '5a createRoof() defaults ridge to auto');
ok(createRoof({ ridge: 'x' }).ridge === 'x', '5b createRoof carries an explicit ridge');
ok(createRoof({ type: 'gable' }).ridge === 'auto', '5c a gable roof still defaults ridge to auto');

// a small valid project: one square room enclosed by 4 walls, capped by a gable roof
const A = { x: -4, z: -2 }, B = { x: 4, z: -2 }, C = { x: 4, z: 2 }, D = { x: -4, z: 2 };
function makeProject(ridge) {
  const level = createLevel({
    id: 'L1', name: 'Ground', height: 2.7,
    walls: [createWall(A, B), createWall(B, C), createWall(C, D), createWall(D, A)],
    rooms: [createRoom([A, B, C, D], { name: 'Room' })],
    roof: createRoof({ type: 'gable', pitch: 30, ridge }),
  });
  return createProject({ name: 'Ridge test', levels: [level] });
}
for (const r of RIDGE_MODES) ok(validateProject(makeProject(r)).ok, `5d-${r} a gable roof with ridge:${r} validates`);
ok(!validateProject(makeProject('diagonal')).ok, '5e an unknown ridge value fails validation');
const errs = validateProject(makeProject('diagonal')).errors.join(' ');
ok(/ridge/.test(errs), '5f the validation error names the bad ridge');

// backward-compat: a roof object predating the ridge field still validates (ridge is optional)
const legacyProj = makeProject('auto');
delete findLevel(legacyProj, 'L1').roof.ridge;
ok(validateProject(legacyProj).ok, '5g a roof with NO ridge field (old save) still validates — ridge is optional');

// the footprint the builder would derive still resolves the (absent) ridge sanely
const fp = roofFootprint(findLevel(legacyProj, 'L1'));
ok(fp && resolveRidgeAlongX(fp, findLevel(legacyProj, 'L1').roof.ridge) === true,
   '5h an absent ridge on a wide footprint resolves to auto → along X');

// ---------------------------------------------------------------------------
// 6) Command layer — setRoofType edits the ridge, undoably & losslessly
// ---------------------------------------------------------------------------
_resetIds();
const proj = makeProject('auto');
const history = new History(proj);
const before = serialize(proj);

history.execute(setRoofType('L1', { ridge: 'z' }));
ok(findLevel(proj, 'L1').roof.ridge === 'z', '6a setRoofType({ridge:z}) sets the ridge on the roof-bearing level');
ok(findLevel(proj, 'L1').roof.type === 'gable', '6b setRoofType leaves the roof type untouched when only ridge changes');

history.undo();
ok(findLevel(proj, 'L1').roof.ridge === 'auto', '6c undo restores the previous ridge');
ok(serialize(proj) === before, '6d ridge undo is byte-lossless (the Phase 1 save guarantee holds)');

// combined patch: type + ridge in one command
history.execute(setRoofType('L1', { type: 'hip', ridge: 'x' }));
ok(findLevel(proj, 'L1').roof.type === 'hip' && findLevel(proj, 'L1').roof.ridge === 'x',
   '6e a combined {type,ridge} patch applies both fields');

// round-trip: ridge survives serialize → deserialize (it is a plain model field)
const round = deserialize(serialize(proj));
ok(findLevel(round, 'L1').roof.ridge === 'x', '6f ridge round-trips losslessly through serialize/deserialize');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
