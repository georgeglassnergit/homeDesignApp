// Phase 2 S1 core — engine-independent verification (plain Node, no Three.js, no network).
// Run: node test/phase2-core.test.mjs   (or: npm test)
import { createProject, createLevel, makeWall, makeOpening, validateProject,
         serialize, deserialize, wallLength, _resetSeq } from '../src/core/model.js';
import { parseLength, formatLength } from '../src/core/units.js';
import { isAvailable, MODES } from '../src/app/state.js';
import { addWall, moveWallVertex, removeWall, addOpening, removeOpening, loadTemplate } from '../src/edit/commands.js';
import { History } from '../src/edit/history.js';
import { sampleHome } from '../src/templates/sampleHome.js';
import { studio, blank, STARTERS } from '../src/templates/starters.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

// 1) Sample home builds & validates
_resetSeq(0);
const home = sampleHome();
const v = validateProject(home);
ok(v.ok, '1a sample home validates: ' + v.errors.join('; '));
ok(home.levels[0].walls.length === 5, '1b sample home has 5 walls');
ok(home.levels[0].openings.length === 4, '1c sample home has 4 openings');
ok(home.levels[0].rooms.length === 2, '1d sample home has 2 rooms');

// 2) Lossless serialize round-trip (byte-identical + re-validates)
const s1 = serialize(home);
const p2 = deserialize(s1);
const s2 = serialize(p2);
ok(s1 === s2, '2a serialize->deserialize->serialize is byte-identical');
ok(validateProject(p2).ok, '2b round-tripped project re-validates');

// 3) Units
ok(near(parseLength('3.2m'), 3.2), '3a parse 3.2m');
ok(near(parseLength("10'6\"", 'imperial'), 3.2004), "3b parse 10'6\" imperial");
ok(near(parseLength('120', 'imperial'), 3.048), '3c bare 120 in imperial = inches');
ok(near(parseLength('250cm'), 2.5), '3d parse 250cm');
ok(formatLength(3.2, 'metric') === '3.2m', '3e format metric');
ok(near(parseLength(formatLength(2.7134, 'imperial'), 'imperial'), 2.7134, 0.03), '3f imperial format/parse round-trip');

// 4) Simple/Pro seam
ok(isAvailable('drawWall', MODES.SIMPLE) === true, '4a drawWall in Simple');
ok(isAvailable('ifcExport', MODES.SIMPLE) === false, '4b ifcExport hidden in Simple');
ok(isAvailable('ifcExport', MODES.PRO) === true, '4c ifcExport in Pro');
ok(isAvailable('exactDims', MODES.SIMPLE) === false, '4d exactDims hidden in Simple');

// 5) Commands + history: draw a room from blank, edit, undo/redo
_resetSeq(1000);
const proj = createProject({ name: 'Test', levels: [createLevel({ id: 'L', roof: {} })] });
const h = new History(proj, { limit: 50 });
const before = serialize(proj);

h.execute(addWall('L', makeWall({x:0,z:0},{x:4,z:0},{id:'a'})));
h.execute(addWall('L', makeWall({x:4,z:0},{x:4,z:4},{id:'b'})));
h.execute(addWall('L', makeWall({x:4,z:4},{x:0,z:4},{id:'c'})));
h.execute(addWall('L', makeWall({x:0,z:4},{x:0,z:0},{id:'d'})));
ok(proj.levels[0].walls.length === 4, '5a drew 4 walls');
ok(validateProject(proj).ok, '5b 4-wall room validates');

// move a vertex, then undo restores exactly
const afterWalls = serialize(proj);
h.execute(moveWallVertex('L', 'b', 'b', {x:5, z:5}));
ok(near(proj.levels[0].walls[1].b.x, 5), '5c vertex moved');
h.undo();
ok(serialize(proj) === afterWalls, '5d undo move restores exact state');
h.redo();
ok(near(proj.levels[0].walls[1].b.x, 5), '5e redo re-applies move');
h.undo(); // back to clean 4-wall room

// opening fit detection: a door that fits vs one that overflows the wall
h.execute(addOpening('L', makeOpening('a', 'door', 1.0, {id:'door1'}))); // wall 'a' len 4, door w0.9 at 1.0 -> fits
ok(validateProject(proj).ok, '5f fitting door validates');
proj.levels[0].openings.push(makeOpening('a', 'window', 3.9, {id:'bad', width:1.4})); // 3.9+0.7=4.6 > 4
const vBad = validateProject(proj);
ok(!vBad.ok && vBad.errors.some(e => e.includes('does not fit')), '5g overflow opening flagged by validate');
proj.levels[0].openings = proj.levels[0].openings.filter(o => o.id !== 'bad');

// removeWall also removes its openings; undo restores both
const beforeRemove = serialize(proj);
h.execute(removeWall('L', 'a'));
ok(proj.levels[0].walls.length === 3, '5h wall removed');
ok(proj.levels[0].openings.every(o => o.wallId !== 'a'), '5i openings on removed wall gone');
h.undo();
ok(serialize(proj) === beforeRemove, '5j undo removeWall restores wall + openings');

// 6) Full undo-all returns to the very beginning
while (h.canUndo()) h.undo();
ok(serialize(proj) === before, '6a undo-all returns to initial serialized state');

// 7) loadTemplate swaps contents and is undoable
_resetSeq(2000);
const p = blank();
const hp = new History(p);
const blankSer = serialize(p);
hp.execute(loadTemplate(studio()));
ok(p.name === 'Studio' && p.levels[0].walls.length === 4, '7a loadTemplate applied studio');
ok(validateProject(p).ok, '7b template result validates');
hp.undo();
ok(serialize(p) === blankSer, '7c undo loadTemplate restores blank');

// 8) all starters build & validate
for (const s of STARTERS) {
  const built = s.build();
  ok(validateProject(built).ok, `8 starter "${s.id}" validates`);
}

// 9) Finiteness guards — parity with the shipped src/core/model.js (closes the
//    silent-drift holes where NaN/∞/missing coords slip past the fit/length checks
//    and carve a non-watertight CSG hole). Each case mutates a FRESH clone so the
//    shared fixtures stay intact; errors only ADD for already-corrupt data.
const freshRoom = () => {
  _resetSeq(9000);
  const p = createProject({ name: 'Fin', levels: [createLevel({ id: 'L', roof: {} })] });
  const hh = new History(p, { limit: 50 });
  hh.execute(addWall('L', makeWall({x:0,z:0},{x:4,z:0},{id:'a'})));
  hh.execute(addWall('L', makeWall({x:4,z:0},{x:4,z:4},{id:'b'})));
  hh.execute(addWall('L', makeWall({x:4,z:4},{x:0,z:4},{id:'c'})));
  hh.execute(addWall('L', makeWall({x:0,z:4},{x:0,z:0},{id:'d'})));
  hh.execute(addOpening('L', makeOpening('a', 'door', 1.0, {id:'door1'})));
  return p;
};
// 9a positive control: the fresh fixture is valid before any corruption
ok(validateProject(freshRoom()).ok, '9a fresh finiteness fixture validates');

// wall endpoints
let fp = freshRoom(); fp.levels[0].walls[0].b.x = NaN;
ok(validateProject(fp).errors.some(e => e.includes('endpoint coordinates must be finite')), '9b NaN wall endpoint rejected');
fp = freshRoom(); fp.levels[0].walls[1].a.z = Infinity;
ok(validateProject(fp).errors.some(e => e.includes('endpoint coordinates must be finite')), '9c ∞ wall endpoint rejected');
fp = freshRoom(); delete fp.levels[0].walls[2].b;
ok(validateProject(fp).errors.some(e => e.includes('endpoint coordinates must be finite')), '9d missing wall endpoint rejected');

// opening offset / sill
fp = freshRoom(); fp.levels[0].openings[0].offset = NaN;
ok(validateProject(fp).errors.some(e => e.includes('offset must be finite')), '9e NaN opening offset rejected (slips the fit check)');
fp = freshRoom(); fp.levels[0].openings[0].sill = NaN;
ok(validateProject(fp).errors.some(e => e.includes('sill must be finite')), '9f NaN opening sill rejected (slips the sill+height check)');
fp = freshRoom(); fp.levels[0].openings[0].sill = Infinity;
ok(validateProject(fp).errors.some(e => e.includes('sill must be finite')), '9g ∞ opening sill rejected');
// a MISSING sill still defaults to 0 (finite) → valid, so it is NOT flagged for finiteness
fp = freshRoom(); delete fp.levels[0].openings[0].sill;
ok(!validateProject(fp).errors.some(e => e.includes('sill must be finite')), '9h missing sill is valid (defaults to 0), not flagged');

// room vertices
fp = freshRoom();
fp.levels[0].rooms.push({ id: 'r1', points: [{x:0,z:0},{x:4,z:0},{x:NaN,z:4}] });
ok(validateProject(fp).errors.some(e => e.includes('point coordinates must be finite')), '9i NaN room vertex rejected');
// positive control: a room with all-finite vertices is NOT flagged
fp = freshRoom();
fp.levels[0].rooms.push({ id: 'r2', points: [{x:0,z:0},{x:4,z:0},{x:4,z:4}] });
ok(!validateProject(fp).errors.some(e => e.includes('point coordinates must be finite')), '9j all-finite room vertices accepted');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
