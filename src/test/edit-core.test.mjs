// Phase 2 S1 core — engine-independent verification against the AUTHORITATIVE src/ model.
// Plain Node, no Three.js, no network, no browser.
// Run: node src/test/edit-core.test.mjs   (or: npm run test:edit)
//
// Proves the interaction foundation (commands + history + starters) reconciled onto
// src/core/model.js: createWall/createOpening (near-edge offset), deterministic ids,
// and the Phase 1 lossless save round-trip surviving every edit.
import {
  createProject, createLevel, createWall, createOpening, validateProject,
  serialize, deserialize, wallLength, findLevel, findWall, findOpening, _resetIds,
} from '../core/model.js';
import { parseLength, formatLength, UNIT } from '../core/units.js';
import { isAvailable, availableTools, createAppState, MODE, TOOL, VIEW } from '../app/state.js';
import { addWall, moveWallVertex, removeWall, addOpening, removeOpening, loadTemplate } from '../edit/commands.js';
import { History } from '../edit/history.js';
import { sampleHome } from '../templates/sampleHome.js';
import { blank, studio, STARTERS } from '../templates/starters.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
function threw(fn) { try { fn(); return false; } catch { return true; } }
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

// 1) Sample home builds & validates (Phase 1 regression)
_resetIds();
const home = sampleHome();
const v = validateProject(home);
ok(v.ok, '1a sample home validates: ' + v.errors.join('; '));
ok(home.levels[0].walls.length === 5, '1b sample home has 5 walls');
ok(home.levels[0].openings.length === 4, '1c sample home has 4 openings');
ok(home.levels[0].rooms.length === 2, '1d sample home has 2 rooms');

// 2) Lossless serialize round-trip (byte-identical + re-validates) — the Phase 1 guarantee
const s1 = serialize(home);
const p2 = deserialize(s1);
ok(serialize(p2) === s1, '2a serialize->deserialize->serialize is byte-identical');
ok(validateProject(p2).ok, '2b round-tripped project re-validates');

// 3) Units resolve & behave as src defines (storage stays metric)
ok(near(parseLength('3.2m'), 3.2), '3a parse 3.2m');
ok(near(parseLength("10'6\"", UNIT.IMPERIAL), 3.2004), "3b parse 10'6\" imperial");
ok(near(parseLength('250cm'), 2.5), '3c parse 250cm');
ok(formatLength(3.2, UNIT.METRIC) === '3.20 m', '3d format metric');

// 4) Simple/Pro seam (src FEATURE_TIERS + isAvailable)
ok(isAvailable('draw-wall', MODE.SIMPLE) === true, '4a draw-wall in Simple');
ok(isAvailable('ifc-export', MODE.SIMPLE) === false, '4b ifc-export hidden in Simple');
ok(isAvailable('ifc-export', MODE.PRO) === true, '4c ifc-export in Pro');
ok(isAvailable('exact-dimensions', MODE.SIMPLE) === false, '4d exact-dimensions hidden in Simple');
ok(availableTools(MODE.PRO).length > availableTools(MODE.SIMPLE).length, '4e Pro exposes more tools than Simple');

// 4b) App state gains the S1 tool/view fields (additive, defaults sane)
const app = createAppState({ mode: MODE.SIMPLE });
ok(app.activeTool === TOOL.SELECT && app.view === VIEW.EXTERIOR, '4f app state defaults: select tool / exterior view');
app.setTool(TOOL.DRAW_WALL);
ok(app.activeTool === TOOL.DRAW_WALL, '4g setTool switches active tool');

// 5) Commands + history: draw a 4-wall room from blank, edit, undo/redo
_resetIds();
const proj = createProject({ name: 'Test', levels: [createLevel({ id: 'L' })] });
const h = new History(proj, { limit: 50 });
const before = serialize(proj);

h.execute(addWall('L', createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { id: 'a' })));
h.execute(addWall('L', createWall({ x: 4, z: 0 }, { x: 4, z: 4 }, { id: 'b' })));
h.execute(addWall('L', createWall({ x: 4, z: 4 }, { x: 0, z: 4 }, { id: 'c' })));
h.execute(addWall('L', createWall({ x: 0, z: 4 }, { x: 0, z: 0 }, { id: 'd' })));
ok(proj.levels[0].walls.length === 4, '5a drew 4 walls');
ok(validateProject(proj).ok, '5b 4-wall room validates');
ok(near(wallLength(findWall(findLevel(proj, 'L'), 'a')), 4), '5c wall lookup + length');

// move a vertex, undo restores exactly, redo re-applies (drag coalescing model)
const afterWalls = serialize(proj);
h.execute(moveWallVertex('L', 'b', 'b', { x: 5, z: 5 }));
ok(near(proj.levels[0].walls[1].b.x, 5), '5d vertex moved');
h.undo();
ok(serialize(proj) === afterWalls, '5e undo move restores exact state');
h.redo();
ok(near(proj.levels[0].walls[1].b.x, 5), '5f redo re-applies move');
h.undo(); // back to clean 4-wall room

// opening fit detection: near-edge offset; a door that fits vs one that overflows
h.execute(addOpening('L', createOpening('a', 'door', { id: 'door1', offset: 1.0 }))); // 1.0+0.9=1.9 < 4 -> fits
ok(validateProject(proj).ok, '5g fitting door validates');
ok(findOpening(findLevel(proj, 'L'), 'door1') !== null, '5h opening lookup finds it');
proj.levels[0].openings.push(createOpening('a', 'window', { id: 'bad', offset: 3.9, width: 1.4 })); // 3.9+1.4=5.3 > 4
const vBad = validateProject(proj);
ok(!vBad.ok && vBad.errors.some(e => e.includes("doesn't fit")), '5i overflow opening flagged by validate');
proj.levels[0].openings = proj.levels[0].openings.filter(o => o.id !== 'bad');

// removeWall cascades to its openings; undo restores both (lossless)
const beforeRemove = serialize(proj);
h.execute(removeWall('L', 'a'));
ok(proj.levels[0].walls.length === 3, '5j wall removed');
ok(proj.levels[0].openings.every(o => o.wallId !== 'a'), '5k openings on removed wall gone');
h.undo();
ok(serialize(proj) === beforeRemove, '5l undo removeWall restores wall + openings byte-identical');

// removeOpening + undo (lossless)
const beforeOpRemove = serialize(proj);
h.execute(removeOpening('L', 'door1'));
ok(findOpening(findLevel(proj, 'L'), 'door1') === null, '5m opening removed');
h.undo();
ok(serialize(proj) === beforeOpRemove, '5n undo removeOpening restores byte-identical');

// 6) Full undo-all returns to the very beginning, byte-identical
while (h.canUndo()) h.undo();
ok(serialize(proj) === before, '6a undo-all returns to initial serialized state');
ok(!h.canUndo() && h.canRedo(), '6b stacks: nothing to undo, redo available');

// 6c) a new command after undo clears the redo stack (standard editor semantics)
h.execute(addWall('L', createWall({ x: 0, z: 0 }, { x: 1, z: 0 }, { id: 'z' })));
ok(!h.canRedo(), '6c new command clears redo stack');

// 6d) history limit trims the oldest entries
_resetIds();
const lp = createProject({ name: 'Lim', levels: [createLevel({ id: 'L' })] });
const lh = new History(lp, { limit: 3 });
for (let i = 0; i < 5; i++) lh.execute(addWall('L', createWall({ x: i, z: 0 }, { x: i + 1, z: 0 }, { id: 'w' + i })));
ok(lh.undoStack.length === 3, '6d history respects limit (kept 3 of 5)');
ok(lp.levels[0].walls.length === 5, '6e all executed commands still applied to the model');

// 7) loadTemplate swaps contents in place (container identity preserved) and is undoable
_resetIds();
const p = blank();
const containerRef = p;
const hp = new History(p);
const blankSer = serialize(p);
hp.execute(loadTemplate(studio()));
ok(p === containerRef, '7a loadTemplate mutates in place (same object reference)');
ok(p.name === 'Studio' && p.levels[0].walls.length === 4, '7b loadTemplate applied studio');
ok(validateProject(p).ok, '7c template result validates');
hp.undo();
ok(serialize(p) === blankSer, '7d undo loadTemplate restores blank byte-identical');

// 8) all starters build & validate
for (const s of STARTERS) {
  _resetIds();
  const built = s.build();
  const vs = validateProject(built);
  ok(vs.ok, `8 starter "${s.id}" validates: ` + vs.errors.join('; '));
}

// 9) command error paths surface bad ids loudly (fail-in-dev, per Phase 2 constraints)
ok(threw(() => addWall('NOPE', createWall({ x: 0, z: 0 }, { x: 1, z: 0 })).do(proj)), '9a addWall throws on missing level');
ok(threw(() => removeWall('L', 'ghost').do(proj)), '9b removeWall throws on missing wall');
ok(threw(() => addOpening('L', createOpening('ghost', 'door', { offset: 0.5 })).do(proj)), '9c addOpening throws on missing wall');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
