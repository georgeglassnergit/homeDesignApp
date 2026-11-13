// Model — validateProject robustness + the save/load (serialize/deserialize) contract
// (engine-independent verification). Run: node src/test/model.test.mjs
//
// validateProject is the single load-time boundary the whole app trusts to decide whether a
// project is safe to build and round-trip. It carries a careful set of guards (finite
// coordinates, watertight-CSG opening sizes, referential integrity for openings and furniture,
// roof bounds) — yet it had NO direct unit coverage: every other suite only ever calls it on a
// well-formed project and asserts `ok === true`. That left its most important promise untested —
// that on a CORRUPT or hand-edited save it must fail *loudly AND gracefully*: return
// `{ ok:false, errors }`, never throw a raw exception out at the caller (which would crash the
// load path the guards exist to protect).
//
// This suite locks that contract. The headline cases are the newly fixed structural guards: a
// level missing its walls/openings/rooms array, or a null/primitive level entry, previously threw
// a TypeError straight out of the validator (`lvl.walls.map` / `for..of undefined` / `null.height`)
// instead of being reported as a validation error. The rest of the suite gives the function the
// direct regression coverage it never had: every existing guard, the valid-project baselines
// (createProject, the three starters), and the lossless serialize→deserialize round-trip that is
// the Phase-1 guarantee. No Three.js import — running under plain Node is itself the model/view
// separation guard. Own file (pick-protocol §5) so it never collides with in-flight test work.
import {
  SCHEMA_VERSION, createProject, createSite, createLevel, createWall, createOpening,
  createRoom, createRoof, createFurniture, validateProject, serialize, deserialize, _resetIds,
} from '../core/model.js';
import { sampleHome } from '../templates/sampleHome.js';
import { STARTERS } from '../templates/starters.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// Run validateProject and capture EITHER its result or a thrown error, so a regression that makes
// the validator throw is reported as a failed assertion instead of aborting the whole suite.
function validate(project) {
  try { return { threw: false, ...validateProject(project) }; }
  catch (e) { return { threw: true, ok: false, errors: [], error: e }; }
}
// True when some error string mentions `needle` (the validator's messages are human text, so we
// assert on a stable substring rather than the exact sentence).
const has = (res, needle) => res.errors.some(e => e.includes(needle));

// A minimal, fully-valid one-level project built field-by-field (not from a template), so each
// corrupt-case test can start from known-good and break exactly one thing.
function validBase() {
  _resetIds();
  const a = { x: 0, z: 0 }, b = { x: 4, z: 0 };
  const wall = createWall(a, b, { id: 'W1', height: 2.7, thickness: 0.12 });
  const level = createLevel({ id: 'L1', height: 2.7, walls: [wall], openings: [], rooms: [] });
  return createProject({ name: 'Base', levels: [level] });
}

// ---- 1) the never-throws contract: structural guards (the core of this fix) ---------------
{
  // Each of these used to throw a raw TypeError out of validateProject. They must now come back
  // as a clean { ok:false } with a descriptive error and threw:false.
  const noWalls = validate({ schemaVersion: SCHEMA_VERSION, levels: [{ id: 'L1', height: 2.7, openings: [], rooms: [] }] });
  ok(!noWalls.threw, '1a level missing walls: does not throw');
  ok(noWalls.ok === false && has(noWalls, 'walls must be an array'), '1b level missing walls: structured error');

  const noOpenings = validate({ schemaVersion: SCHEMA_VERSION, levels: [{ id: 'L1', height: 2.7, walls: [], rooms: [] }] });
  ok(!noOpenings.threw && has(noOpenings, 'openings must be an array'), '1c level missing openings: structured error, no throw');

  const noRooms = validate({ schemaVersion: SCHEMA_VERSION, levels: [{ id: 'L1', height: 2.7, walls: [], openings: [] }] });
  ok(!noRooms.threw && has(noRooms, 'rooms must be an array'), '1d level missing rooms: structured error, no throw');

  // A non-array (but present) collection is just as poisonous as a missing one.
  const badTypes = validate({ schemaVersion: SCHEMA_VERSION, levels: [{ id: 'L2', height: 2.7, walls: {}, openings: 5, rooms: 'x' }] });
  ok(!badTypes.threw, '1e non-array walls/openings/rooms: does not throw');
  ok(has(badTypes, 'walls must be an array') && has(badTypes, 'openings must be an array') && has(badTypes, 'rooms must be an array'),
    '1f non-array collections: all three reported, none masks the others');

  // A null / primitive level entry (a truncated or hand-edited levels array).
  const nullLvl = validate({ schemaVersion: SCHEMA_VERSION, levels: [null] });
  ok(!nullLvl.threw && has(nullLvl, 'must be an object'), '1g null level entry: reported, no throw');
  const strLvl = validate({ schemaVersion: SCHEMA_VERSION, levels: ['oops'] });
  ok(!strLvl.threw && has(strLvl, 'must be an object'), '1h primitive level entry: reported, no throw');

  // A level with no id must still be locatable in the error text — by its array index.
  const noId = validate({ schemaVersion: SCHEMA_VERSION, levels: [{ height: 2.7 }] });
  ok(!noId.threw && has(noId, 'level [0]:'), '1i level without id: error references its [index]');

  // A good level and a corrupt one in the same project: the good one must not be dragged down,
  // and the bad one is still reported (loop keeps going).
  const mixed = validate({ schemaVersion: SCHEMA_VERSION, levels: [
    createLevel({ id: 'GOOD', height: 2.7, walls: [], openings: [], rooms: [] }),
    null,
  ] });
  ok(!mixed.threw && mixed.ok === false && has(mixed, 'level [1]:'), '1j one bad level among good: reported by index, no throw');
}

// ---- 2) top-level shape guards -------------------------------------------------------------
{
  for (const [label, v] of [['null', null], ['undefined', undefined], ['string', 'x'], ['number', 7], ['array', []]]) {
    const r = validate(v);
    ok(!r.threw && r.ok === false, `2a non-object project (${label}): { ok:false }, no throw`);
  }
  const noLevels = validate({ schemaVersion: SCHEMA_VERSION, levels: 'nope' });
  ok(!noLevels.threw && has(noLevels, 'levels must be an array'), '2b levels not an array: reported, no throw');
  // levels may be legitimately absent-as-empty via `|| []` — an object with no levels key must not throw.
  const noLevelsKey = validate({ schemaVersion: SCHEMA_VERSION });
  ok(!noLevelsKey.threw, '2c project with no levels key: does not throw');
  // schemaVersion mismatch is an error (forward/backward incompatible save).
  const badVer = validate({ schemaVersion: SCHEMA_VERSION + 99, levels: [] });
  ok(!badVer.threw && has(badVer, 'schemaVersion'), '2d wrong schemaVersion: reported');
}

// ---- 3) valid projects must pass (baseline / no false positives) ---------------------------
{
  const blank = validate(createProject());
  ok(!blank.threw && blank.ok === true && blank.errors.length === 0, '3a createProject() (blank) validates clean');

  const base = validate(validBase());
  ok(base.ok === true, '3b hand-built one-wall level validates clean');

  const sh = validate(sampleHome());
  ok(sh.ok === true, `3c sampleHome template validates clean (${sh.errors.join('; ')})`);

  // Every starter the template picker offers must validate — a broken starter is a user-facing
  // dead end on the start screen.
  for (const s of STARTERS) {
    const r = validate(s.build());
    ok(r.ok === true, `3d starter "${s.id}" validates clean (${r.errors.join('; ')})`);
  }
}

// ---- 4) existing element guards — direct regression locks ----------------------------------
{
  // Walls
  let p = validBase(); p.levels[0].walls[0].thickness = 0;
  ok(has(validate(p), 'thickness must be > 0'), '4a wall thickness <= 0 rejected');
  p = validBase(); p.levels[0].walls[0].height = -1;
  ok(has(validate(p), 'height must be > 0'), '4b wall height <= 0 rejected');
  p = validBase(); p.levels[0].walls[0].b = { x: NaN, z: 0 };
  ok(has(validate(p), 'endpoint coordinates must be finite'), '4c non-finite wall endpoint rejected (not "zero length")');
  p = validBase(); p.levels[0].walls[0].b = { x: 0, z: 0 };   // a==b
  ok(has(validate(p), 'zero length'), '4d zero-length wall rejected');
  // level height
  p = validBase(); p.levels[0].height = 0;
  ok(has(validate(p), 'height must be > 0'), '4e level height <= 0 rejected');
}

// ---- 5) opening guards (watertight-CSG + referential integrity) ----------------------------
{
  const withOpening = (mut) => {
    const p = validBase();
    const o = createOpening('W1', 'door', { id: 'O1', width: 0.9, height: 2.0, offset: 1.0, sill: 0 });
    mut(o);
    p.levels[0].openings.push(o);
    return p;
  };
  ok(validate(withOpening(() => {})).ok === true, '5a well-formed opening validates clean');
  ok(has(validate(withOpening(o => o.wallId = 'NOPE')), 'unknown wallId'), '5b opening on unknown wall rejected');
  ok(has(validate(withOpening(o => o.width = 0)), 'width must be > 0'), '5c opening width <= 0 rejected');
  ok(has(validate(withOpening(o => o.height = -1)), 'height must be > 0'), '5d opening height <= 0 rejected');
  ok(has(validate(withOpening(o => o.offset = NaN)), 'offset must be a finite'), '5e non-finite opening offset rejected');
  ok(has(validate(withOpening(o => o.sill = Infinity)), 'sill must be a finite'), '5f non-finite opening sill rejected');
  ok(has(validate(withOpening(o => o.offset = 10)), "doesn't fit"), '5g opening past wall end rejected (offset+width > length)');
  ok(has(validate(withOpening(o => { o.sill = 2.0; o.height = 1.5; })), 'taller than wall'), '5h opening above wall top rejected');
}

// ---- 6) room guards ------------------------------------------------------------------------
{
  const withRoom = (pts) => { const p = validBase(); p.levels[0].rooms.push(createRoom(pts, { id: 'R1' })); return p; };
  const square = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }];
  ok(validate(withRoom(square)).ok === true, '6a well-formed room validates clean');
  ok(has(validate(withRoom([{ x: 0, z: 0 }, { x: 1, z: 0 }])), 'needs >= 3 points'), '6b room with < 3 points rejected');
  ok(has(validate(withRoom([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: NaN, z: 2 }])), 'point coordinates must be finite'),
    '6c non-finite room vertex rejected');
}

// ---- 7) roof guards ------------------------------------------------------------------------
{
  const withRoof = (roof) => { const p = validBase(); p.levels[0].roof = roof; return p; };
  ok(validate(withRoof(createRoof({ type: 'flat', thickness: 0.2, overhang: 0.3 }))).ok === true, '7a flat roof validates clean');
  ok(has(validate(withRoof({ type: 'bogus' })), 'unknown roof type'), '7b unknown roof type rejected');
  ok(has(validate(withRoof(createRoof({ type: 'gable', pitch: 0 }))), 'roof pitch must be between'), '7c pitched roof: pitch 0 rejected');
  ok(has(validate(withRoof(createRoof({ type: 'gable', pitch: 120 }))), 'roof pitch must be between'), '7d pitched roof: pitch >= 90 rejected');
  ok(has(validate(withRoof({ type: 'flat', ridge: 'sideways' })), 'unknown roof ridge'), '7e unknown ridge mode rejected');
  ok(has(validate(withRoof({ type: 'flat', overhang: -1 })), 'overhang must be a non-negative'), '7f negative overhang rejected');
}

// ---- 8) furniture guards (Phase-4 furnish output) ------------------------------------------
{
  const withFurn = (mut) => {
    const p = validBase();
    const f = createFurniture('chair.glb', { id: 'F1', levelId: 'L1', position: { x: 1, z: 1 }, scale: 1, rotationY: 0 });
    mut(f);
    p.furniture = [f];
    return p;
  };
  ok(validate(withFurn(() => {})).ok === true, '8a well-formed furniture validates clean');
  ok(validate(withFurn(f => f.levelId = null)).ok === true, '8b null levelId (untethered) is valid');
  ok(has(validate({ ...validBase(), furniture: 'nope' }), 'furniture must be an array'), '8c non-array furniture rejected, no throw');
  ok(has(validate(withFurn(f => f.src = '')), 'src must be a non-empty string'), '8d empty furniture src rejected');
  ok(has(validate(withFurn(f => f.position = { x: NaN, z: 0 })), 'position coordinates must be finite'), '8e non-finite position rejected');
  ok(has(validate(withFurn(f => f.scale = Infinity)), 'scale must be a finite'), '8f non-finite scale rejected');
  ok(has(validate(withFurn(f => f.rotationY = NaN)), 'rotationY must be a finite'), '8g non-finite rotationY rejected');
  ok(has(validate(withFurn(f => f.levelId = 'GHOST')), 'unknown levelId'), '8h furniture on missing level rejected');
}

// ---- 9) serialize / deserialize — the lossless save contract -------------------------------
{
  const p = sampleHome();
  const once = serialize(p);
  const round = serialize(deserialize(once));
  ok(round === once, '9a serialize→deserialize→serialize is byte-identical (lossless round-trip)');
  // deserialize accepts an already-parsed object (the forward-compat hook path), not only a string.
  const fromObj = deserialize(JSON.parse(once));
  ok(validate(fromObj).ok === true && serialize(fromObj) === once, '9b deserialize passes through a parsed object losslessly');
  // A deserialized sample home still validates — the save path produces only loadable projects.
  ok(validate(deserialize(once)).ok === true, '9c round-tripped sampleHome re-validates clean');
}

// ---- report --------------------------------------------------------------------------------
console.log(`\nmodel: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); for (const f of fails) console.log('  · ' + f); process.exit(1); }
