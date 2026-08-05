// Per-slope roof overhang (eaves vs. rake) — engine-independent verification (plain Node).
// Run: node src/test/roof-overhang.test.mjs
//
// B2 (PHASE-3-PLAN.md): a pitched roof should be able to oversail the walls by a different
// amount at the EAVES (the two sloped sides, perpendicular to the ridge) than at the RAKES
// (the gable/hip ends, along the ridge). This proves the pure math + the lossless model:
//   • roofOverhangs backfills eave/rake from the legacy uniform `overhang` (old saves unchanged)
//   • roofFootprint stays uniform for FLAT roofs and for pitched roofs carrying only `overhang`
//     (byte-identical to pre-B2), but expands eave/rake independently once they differ
//   • ridge orientation is resolved from the bare WALL bounds — stable regardless of overhang —
//     so a big rake overhang that flips the footprint's aspect never flips the ridge axis
//   • a larger EAVE raises the ridge (wider perpendicular span); a larger RAKE extends the ends
//     WITHOUT changing ridge height; both keep the gable infill apex on the real ridge
//   • createRoof carries eave/rake ONLY when set (byte-identical save otherwise); the command
//     round-trips losslessly (undo restores a roof that never had the fields); validation guards them
// Lives in its own file so it composes with other in-flight work (the roof suite's approach).
import {
  createProject, createLevel, createWall, createRoof, validateProject,
  serialize, deserialize, _resetIds,
} from '../core/model.js';
import {
  wallBounds, roofFootprint, roofOverhangs, roofSolid, gableInfill,
  resolveRidgeAlongX, pitchRise,
} from '../core/roofShape.js';
import { setRoofType } from '../edit/commands.js';
import { History } from '../edit/history.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const allFinite = (arr) => arr.every((v) => Number.isFinite(v));

// A wide level: 8 m (X) × 4 m (Z) footprint, walls (eave) at y=3.
const A = { x: -4, z: -2 }, B = { x: 4, z: -2 }, C = { x: 4, z: 2 }, D = { x: -4, z: 2 };
function wideLevel(roofOpts = {}) {
  return createLevel({
    id: 'L1', name: 'Ground', elevation: 0, height: 3,
    walls: [
      createWall(A, B), createWall(B, C), createWall(C, D), createWall(D, A),
    ],
    roof: createRoof({ type: 'gable', pitch: 45, ridge: 'auto', ...roofOpts }),
  });
}

// ---- 1. roofOverhangs backfill ---------------------------------------------
ok(JSON.stringify(roofOverhangs({ overhang: 0.3 })) === JSON.stringify({ eave: 0.3, rake: 0.3 }),
  '1a no per-slope fields → eave and rake both fall back to the uniform overhang');
ok(JSON.stringify(roofOverhangs({ overhang: 0.3, eaveOverhang: 0.6 })) === JSON.stringify({ eave: 0.6, rake: 0.3 }),
  '1b eaveOverhang overrides only the eave; rake still falls back to overhang');
ok(JSON.stringify(roofOverhangs({ overhang: 0.3, rakeOverhang: 0.1 })) === JSON.stringify({ eave: 0.3, rake: 0.1 }),
  '1c rakeOverhang overrides only the rake; eave still falls back to overhang');
ok(JSON.stringify(roofOverhangs({ eaveOverhang: 0.5, rakeOverhang: 0.2 })) === JSON.stringify({ eave: 0.5, rake: 0.2 }),
  '1d both set → both used, independent of a missing overhang');
ok(JSON.stringify(roofOverhangs({})) === JSON.stringify({ eave: 0, rake: 0 }),
  '1e a roof with no overhang at all resolves to zero (never NaN/undefined)');
ok(JSON.stringify(roofOverhangs({ overhang: 0.3, eaveOverhang: 0 })) === JSON.stringify({ eave: 0, rake: 0.3 }),
  '1f an explicit ZERO eave is honoured (not treated as "unset")');

// ---- 2. roofFootprint: flat + backward-compatible pitched ------------------
const flat = createLevel({ id: 'LF', elevation: 0, height: 3,
  walls: [createWall(A, B), createWall(B, C), createWall(C, D), createWall(D, A)],
  roof: createRoof({ type: 'flat', overhang: 0.3 }) });
const ffp = roofFootprint(flat);
ok(near(ffp.x0, -4.3) && near(ffp.x1, 4.3) && near(ffp.z0, -2.3) && near(ffp.z1, 2.3),
  '2a a FLAT roof still overhangs uniformly on all four sides (Phase-1 behaviour)');

const uniform = wideLevel({ overhang: 0.3 }); // pitched, only the legacy uniform field
const ufp = roofFootprint(uniform);
ok(near(ufp.x0, -4.3) && near(ufp.x1, 4.3) && near(ufp.z0, -2.3) && near(ufp.z1, 2.3),
  '2b a pitched roof with ONLY `overhang` expands uniformly — byte-identical to pre-B2');

// ---- 3. roofFootprint: per-slope expansion mapped by ridge axis ------------
// Wide level → auto ridge runs along X. Eaves are the ±Z (sloped) sides; rakes the ±X ends.
const perSlopeX = wideLevel({ eaveOverhang: 0.5, rakeOverhang: 0.1 });
ok(resolveRidgeAlongX(wallBounds(perSlopeX), 'auto') === true, '3a wide 8×4 footprint → auto ridge along X');
const pfx = roofFootprint(perSlopeX);
ok(near(pfx.z0, -2.5) && near(pfx.z1, 2.5), '3b eave overhang (0.5) expands the ±Z (eave) sides');
ok(near(pfx.x0, -4.1) && near(pfx.x1, 4.1), '3c rake overhang (0.1) expands the ±X (rake/end) sides');

// Force the ridge along Z on the same footprint → eave/rake axes swap.
const perSlopeZ = wideLevel({ ridge: 'z', eaveOverhang: 0.5, rakeOverhang: 0.1 });
ok(resolveRidgeAlongX(wallBounds(perSlopeZ), 'z') === false, '3d ridge forced along Z');
const pfz = roofFootprint(perSlopeZ);
ok(near(pfz.x0, -4.5) && near(pfz.x1, 4.5), '3e with ridge along Z, eaves are the ±X sides (expand by 0.5)');
ok(near(pfz.z0, -2.1) && near(pfz.z1, 2.1), '3f with ridge along Z, rakes are the ±Z ends (expand by 0.1)');

// ---- 4. ridge axis is stable even when a big rake flips the footprint aspect
// Near-square 5×4 walls → auto ridge along X. A huge EAVE (on Z) makes the footprint's
// Z-span exceed its X-span; a naive auto-on-footprint would flip to Z. Because the view
// resolves the ridge from the WALL bounds, the axis stays X and stays consistent.
_resetIds();
const nsA = { x: -2.5, z: -2 }, nsB = { x: 2.5, z: -2 }, nsC = { x: 2.5, z: 2 }, nsD = { x: -2.5, z: 2 };
const flip = createLevel({ id: 'LN', elevation: 0, height: 3,
  walls: [createWall(nsA, nsB), createWall(nsB, nsC), createWall(nsC, nsD), createWall(nsD, nsA)],
  roof: createRoof({ type: 'gable', pitch: 45, ridge: 'auto', eaveOverhang: 3, rakeOverhang: 0 }) });
const flipFp = roofFootprint(flip);            // z-span (10) now > x-span (5)
ok((flipFp.z1 - flipFp.z0) > (flipFp.x1 - flipFp.x0), '4a a large eave makes the footprint taller than wide');
ok(resolveRidgeAlongX(wallBounds(flip), 'auto') === true, '4b …but the ridge axis (from wall bounds) is still X');
const flipRidgeAlongX = resolveRidgeAlongX(wallBounds(flip), 'auto');
const flipSolid = roofSolid('gable', flipFp, { baseY: 3, pitch: 45, ridge: flipRidgeAlongX ? 'x' : 'z' });
ok(flipSolid.ridgeAlongX === true && allFinite(flipSolid.positions),
  '4c the shell built with the concrete (wall-derived) ridge stays on X — footprint and shell agree');

// ---- 5. eave raises the ridge; rake extends the ends without raising it -----
const baseY = 3, pitch = 45;
const rax = resolveRidgeAlongX(wallBounds(perSlopeX), 'auto'); // true → along X
// perpendicular (eave) span = z-span; ridge rise = pitchRise(halfSpan, pitch)
const solidPS = roofSolid('gable', roofFootprint(perSlopeX), { baseY, pitch, ridge: rax ? 'x' : 'z' });
const expectedRidgeY = baseY + pitchRise((pfx.z1 - pfx.z0) / 2, pitch);
ok(near(solidPS.ridgeY, expectedRidgeY), '5a ridge height rises with the EAVE overhang (wider perpendicular span)');

// bigger eave → strictly higher ridge; bigger rake → same ridge height
const solidBiggerEave = roofSolid('gable', roofFootprint(wideLevel({ eaveOverhang: 1.0, rakeOverhang: 0.1 })),
  { baseY, pitch, ridge: 'x' });
ok(solidBiggerEave.ridgeY > solidPS.ridgeY, '5b a larger eave overhang gives a strictly higher ridge');
const solidBiggerRake = roofSolid('gable', roofFootprint(wideLevel({ eaveOverhang: 0.5, rakeOverhang: 2.0 })),
  { baseY, pitch, ridge: 'x' });
ok(near(solidBiggerRake.ridgeY, solidPS.ridgeY), '5c a larger RAKE overhang does NOT change ridge height');
// the rake overhang really does push the ends out along X
const bx = (() => { let x0 = Infinity, x1 = -Infinity; const p = solidBiggerRake.positions;
  for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); } return { x0, x1 }; })();
ok(near(bx.x0, -6) && near(bx.x1, 6), '5d rake overhang (2.0) extends the roof ends to ±6 on X (walls end at ±4)');

// ---- 6. gable infill apex still meets the real ridge under per-slope overhang
const wb = wallBounds(perSlopeX), rf = roofFootprint(perSlopeX);
const inf = gableInfill('gable', rf, wb, { baseY, pitch, ridge: rax ? 'x' : 'z', thickness: 0.12 });
ok(near(inf.ridgeY, expectedRidgeY), '6a the infill apex height matches the eave-raised roof ridge');
ok(inf.triangleCount === 16 && allFinite(inf.positions), '6b two watertight infill panels, all-finite');
// apex sits on the wall plane at the ends (x = ±4), centred in Z (ridge line)
const iy = (() => { let y1 = -Infinity; const p = inf.positions;
  for (let i = 1; i < p.length; i += 3) y1 = Math.max(y1, p[i]); return y1; })();
ok(near(iy, expectedRidgeY), '6c the highest infill vertex is exactly the ridge height (no gap under the peak)');

// ---- 7. model: optional fields, byte-identical save, validation ------------
_resetIds();
const plain = createRoof({ type: 'gable', pitch: 45 });
ok(!('eaveOverhang' in plain) && !('rakeOverhang' in plain),
  '7a createRoof omits eave/rake when unset — so a save that never uses them is byte-identical');
const custom = createRoof({ type: 'gable', pitch: 45, eaveOverhang: 0.6, rakeOverhang: 0.1 });
ok(custom.eaveOverhang === 0.6 && custom.rakeOverhang === 0.1, '7b createRoof carries eave/rake when set');
// createRoof(existingRoof) preserves the per-slope fields (used when stacking storeys)
const copied = createRoof(custom);
ok(copied.eaveOverhang === 0.6 && copied.rakeOverhang === 0.1, '7c copying a roof keeps its per-slope overhangs');

_resetIds();
const projPlain = createProject({ name: 'Uniform', levels: [wideLevel({ overhang: 0.3 })] });
ok(validateProject(projPlain).ok, '7d a gable project with only uniform overhang validates');
ok(!serialize(projPlain).includes('eaveOverhang') && !serialize(projPlain).includes('rakeOverhang'),
  '7e its save contains no per-slope keys (old-save shape preserved)');

_resetIds();
const projCustom = createProject({ name: 'PerSlope', levels: [wideLevel({ eaveOverhang: 0.5, rakeOverhang: 0.1 })] });
ok(validateProject(projCustom).ok, '7f a per-slope project validates');
const cs = serialize(projCustom);
ok(serialize(deserialize(cs)) === cs, '7g the per-slope project round-trips byte-identically (lossless save)');

// negative overhang is rejected; explicit zero is accepted
const bad = createProject({ name: 'Bad', levels: [wideLevel({ eaveOverhang: -0.2 })] });
ok(!validateProject(bad).ok, '7h a negative eave overhang fails validation');
const zero = createProject({ name: 'Zero', levels: [wideLevel({ eaveOverhang: 0, rakeOverhang: 0 })] });
ok(validateProject(zero).ok, '7i a zero overhang (flush eaves) is valid');

// ---- 8. command: apply + lossless undo -------------------------------------
_resetIds();
const proj = createProject({ name: 'Cmd', levels: [wideLevel({ overhang: 0.3 })] });
const roofLevelId = proj.levels[0].id;
const before = serialize(proj);
const hist = new History(proj);
hist.execute(setRoofType(roofLevelId, { eaveOverhang: 0.7, rakeOverhang: 0.15 }));
ok(proj.levels[0].roof.eaveOverhang === 0.7 && proj.levels[0].roof.rakeOverhang === 0.15,
  '8a setRoofType applies the per-slope overhangs');
ok(validateProject(proj).ok, '8b the model is still valid after the per-slope edit');
const afterEdit = serialize(proj);
ok(serialize(deserialize(afterEdit)) === afterEdit, '8c the edited project round-trips byte-identically');
hist.undo();
ok(serialize(proj) === before, '8d undo restores the EXACT prior save — a roof that never had eave/rake comes back clean');
hist.redo();
ok(proj.levels[0].roof.eaveOverhang === 0.7 && serialize(proj) === afterEdit, '8e redo re-applies losslessly');

// setting overhang alone via the command still works (and undoes clean)
_resetIds();
const proj2 = createProject({ name: 'Cmd2', levels: [wideLevel({ overhang: 0.3 })] });
const b2 = serialize(proj2);
const h2 = new History(proj2);
h2.execute(setRoofType(proj2.levels[0].id, { overhang: 0.5 }));
ok(proj2.levels[0].roof.overhang === 0.5, '8f setRoofType can still set the uniform overhang');
h2.undo();
ok(serialize(proj2) === b2, '8g undo of a uniform-overhang edit is lossless too');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
