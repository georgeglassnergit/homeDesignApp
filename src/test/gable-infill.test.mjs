// Gable-end wall infill — engine-independent verification (plain Node, no Three.js).
// Run: node src/test/gable-infill.test.mjs
//
// B1 (PHASE-3-PLAN.md): a gable roof leaves a triangular void between the top of the
// walls and the rising roof slopes at each end. In reality that triangle is WALL, not
// roof or void. This proves the pure shape math that fills it:
//   • wallBounds returns the bare (no-overhang) wall box; roofFootprint == wallBounds ± overhang
//   • gableInfill emits two solid triangular prisms (one per gable end) on the WALL plane
//   • the panel apex meets the ACTUAL roof ridge height (roofSolid.ridgeY) — no gap under the peak
//   • the panels sit inside the roof's overhang footprint (rake overhang stays visible)
//   • ridge orientation ('auto'|'x'|'z') places the gable ends on the correct axis
//   • hip / flat roofs produce NO infill (they have no gable end)
//   • the geometry is finite, watertight-shaped (8 tris/panel), and adds NOTHING to the save
// Lives in its own file so it composes with other in-flight work (the roof suite's approach).
import {
  createProject, createLevel, createWall, createRoof, createRoom, validateProject,
  serialize, deserialize, _resetIds,
} from '../core/model.js';
import {
  wallBounds, roofFootprint, roofSolid, gableInfill, DEFAULT_INFILL_THICKNESS,
} from '../core/roofShape.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const allFinite = (arr) => arr.every((v) => Number.isFinite(v));

// helpers to pull triangle vertices out of the flat position soup
const verts = (positions) => {
  const out = [];
  for (let i = 0; i < positions.length; i += 3) out.push([positions[i], positions[i + 1], positions[i + 2]]);
  return out;
};
const bbox = (positions) => {
  const v = verts(positions);
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const [x, y, z] of v) {
    b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x);
    b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y);
    b.z0 = Math.min(b.z0, z); b.z1 = Math.max(b.z1, z);
  }
  return b;
};

// A wide level: 8 m (X) × 4 m (Z), eave (walls) at y=3, gable pitch 45°, overhang 0.3.
// baseY = 3. roofFp = wallFp expanded by 0.3 all round.
const A = { x: -4, z: -2 }, B = { x: 4, z: -2 }, C = { x: 4, z: 2 }, D = { x: -4, z: 2 };
function wideLevel(ridge = 'auto', overhang = 0.3) {
  return createLevel({
    id: 'L1', name: 'Ground', elevation: 0, height: 3,
    walls: [createWall(A, B), createWall(B, C), createWall(C, D), createWall(D, A)],
    rooms: [createRoom([A, B, C, D], { name: 'Room' })],
    roof: createRoof({ type: 'gable', pitch: 45, ridge, overhang }),
  });
}

// ---------------------------------------------------------------------------
// 1) wallBounds / roofFootprint — the bare wall plane vs the overhang-expanded roof
// ---------------------------------------------------------------------------
_resetIds();
const lvl = wideLevel('auto', 0.3);
const wb = wallBounds(lvl);
ok(wb.x0 === -4 && wb.x1 === 4 && wb.z0 === -2 && wb.z1 === 2, '1a wallBounds is the bare wall bbox (no overhang)');
const rf = roofFootprint(lvl);
ok(near(rf.x0, -4.3) && near(rf.x1, 4.3) && near(rf.z0, -2.3) && near(rf.z1, 2.3),
   '1b roofFootprint expands wallBounds by the overhang on every side');
ok(wallBounds(createLevel({})) === null, '1c wallBounds is null when the level has no walls');

// ---------------------------------------------------------------------------
// 2) gableInfill — two solid prisms on the WALL plane, apex at the real ridge
// ---------------------------------------------------------------------------
const baseY = lvl.elevation + lvl.height; // 3
const roof = roofSolid('gable', rf, { baseY, pitch: 45, ridge: 'auto' });
const infill = gableInfill('gable', rf, wb, { baseY, pitch: 45, ridge: 'auto', thickness: 0.12 });
ok(infill.positions.length > 0 && infill.positions.length % 9 === 0, '2a gable infill emits triangles (9 numbers each)');
ok(allFinite(infill.positions), '2b all infill positions are finite');
// Two triangular prisms: 8 triangles each (2 caps + 3 quad sides = 2 + 6) → 16 tris total.
ok(infill.triangleCount === 16, `2c two gable-end prisms = 16 triangles (got ${infill.triangleCount})`);
// The apex reaches the ACTUAL roof ridge — wide footprint, auto ridge runs along X,
// short half = (roof depth)/2 = (4 + 2*0.3)/2 = 2.3 → rise at 45° = 2.3 → ridgeY = 5.3.
ok(near(infill.ridgeY, baseY + 2.3), '2d infill ridgeY rises by the roof short-half run (2.3 m at 45°)');
ok(near(infill.ridgeY, roof.ridgeY), '2e infill apex height EQUALS the roof ridge height (no gap under the peak)');

// ---------------------------------------------------------------------------
// 3) The panels sit on the wall plane, inside the roof overhang (rake stays visible)
// ---------------------------------------------------------------------------
const ib = bbox(infill.positions);
// auto ridge → along X → gable ends at the X extremes; panels span the wall X range ± half-thickness.
ok(near(ib.x0, -4 - 0.06) && near(ib.x1, 4 + 0.06), '3a panels straddle the wall X-planes by ±half-thickness (0.06)');
ok(ib.x0 > rf.x0 && ib.x1 < rf.x1, '3b the infill stays INSIDE the roof overhang in X (rake overhang not covered)');
ok(near(ib.z0, -2) && near(ib.z1, 2), '3c panels span exactly the wall Z range (the eave line)');
ok(near(ib.y0, baseY) && near(ib.y1, infill.ridgeY), '3d panels rise from eave height to the ridge');

// ---------------------------------------------------------------------------
// 4) Ridge orientation controls which end gets the gable
// ---------------------------------------------------------------------------
const infZ = gableInfill('gable', rf, wb, { baseY, pitch: 45, ridge: 'z', thickness: 0.12 });
ok(infZ.ridgeAlongX === false, '4a forcing ridge:z runs the ridge along Z');
const zb = bbox(infZ.positions);
// ridge along Z → gable ends at the Z extremes; panels straddle the wall Z-planes.
ok(near(zb.z0, -2 - 0.06) && near(zb.z1, 2 + 0.06), '4b ridge:z puts the gable ends on the Z-planes (straddle by ±0.06)');
ok(near(zb.x0, -4) && near(zb.x1, 4), '4c ridge:z panels span the full wall X range (the eave line)');
// forced-Z ridge is taller: short half = (roof width)/2 = (8 + 0.6)/2 = 4.3 → ridgeY = 3 + 4.3.
ok(near(infZ.ridgeY, baseY + 4.3), '4d ridge:z apex uses the long-axis run (taller ridge, geometry really changed)');

// ---------------------------------------------------------------------------
// 5) Only a gable has gable ends — hip and flat produce no infill
// ---------------------------------------------------------------------------
ok(gableInfill('hip', rf, wb, { baseY, pitch: 45 }).positions.length === 0, '5a a hip roof produces NO gable infill');
ok(gableInfill('flat', rf, wb, { baseY, pitch: 45 }).positions.length === 0, '5b a flat roof produces NO gable infill');
ok(gableInfill('gable', rf, null, { baseY, pitch: 45 }).positions.length === 0, '5c no wall footprint → no infill (never throws)');

// ---------------------------------------------------------------------------
// 6) Defaults & purity — sensible fallback thickness; the infill touches NO save field
// ---------------------------------------------------------------------------
ok(near(DEFAULT_INFILL_THICKNESS, 0.12), '6a default infill thickness matches the default wall thickness');
const infDefault = gableInfill('gable', rf, wb, { baseY, pitch: 45 }); // thickness omitted
const db = bbox(infDefault.positions);
ok(near(db.x1 - 4, DEFAULT_INFILL_THICKNESS / 2), '6b omitting thickness falls back to the default depth');

// The infill is DERIVED geometry — it must never appear in the model / save.
_resetIds();
const proj = createProject({ name: 'Gable', levels: [wideLevel('auto', 0.3)] });
ok(validateProject(proj).ok, '6c a gable-roofed project still validates (infill adds no model field)');
const before = serialize(proj);
gableInfill('gable', rf, wb, { baseY, pitch: 45 }); // computing infill mutates nothing
ok(serialize(proj) === before, '6d computing the infill does not touch the model');
ok(serialize(deserialize(before)) === before, '6e the project round-trips byte-identically (Phase 1 lossless save holds)');

// backward-compat: an old gable roof with NO ridge field still yields a sane infill
const legacy = wideLevel('auto', 0.3);
delete legacy.roof.ridge;
const infLegacy = gableInfill('gable', roofFootprint(legacy), wallBounds(legacy), { baseY, pitch: 45, ridge: legacy.roof.ridge });
ok(infLegacy.ridgeAlongX === true && infLegacy.triangleCount === 16, '6f an old gable roof (no ridge field) still infills sanely');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
