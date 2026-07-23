// Phase 2 S1 core — engine-independent verification against the AUTHORITATIVE src/ model.
// Plain Node, no Three.js, no network, no browser.
// Run: node src/test/edit-core.test.mjs   (or: npm run test:edit)
//
// Proves the interaction foundation (commands + history + starters) reconciled onto
// src/core/model.js: createWall/createOpening (near-edge offset), deterministic ids,
// and the Phase 1 lossless save round-trip surviving every edit.
import {
  createProject, createLevel, createWall, createOpening, createRoom, createRoof, validateProject,
  serialize, deserialize, wallLength, findLevel, findWall, findOpening, findRoom, stackElevations, _resetIds,
} from '../core/model.js';
// Pure room-measurement geometry (floor area / perimeter / centroid) — three-free (the guard).
import { polygonArea, polygonPerimeter, polygonCentroid, describeRoom } from '../core/roomMeasure.js';
import { parseLength, formatLength, formatArea, UNIT } from '../core/units.js';
import { isAvailable, availableTools, createAppState, MODE, TOOL, VIEW } from '../app/state.js';
import { addWall, moveWallVertex, removeWall, addOpening, removeOpening, loadTemplate, composite, setView, resizeWall, resizeOpening, addLevel, removeLevel, renameLevel, setLevelHeight, setLevelRoof, setRoofType } from '../edit/commands.js';
// Pure roof-shape math (gable/hip) — must stay three-free (importing under Node is the guard).
import { ROOF_TYPES, DEFAULT_ROOF_PITCH, isPitched, roofFootprint, roofSolid, pitchRise } from '../core/roofShape.js';
// Pure measure-tool math (the Pro-seam ruler) — three-free (importing under Node is the guard).
import { measureDistance, measureMidpoint, describeMeasure } from '../edit/measure.js';
// Selection inspector — pure descriptor + edit builder (the Simple/Pro exact-dimension seam).
// Must stay three-free / DOM-free; importing under Node is itself the separation guard.
import { describeSelection, buildDimensionEdit } from '../app/inspector.js';
import { History } from '../edit/history.js';
// S5 cutaway decision — pure math, must stay three-free (importing under Node is the guard).
import { cutawayHiddenWalls, wallsCenterXZ } from '../viewer/cutaway.js';
// S6 walk-camera math — pure, must stay three-free (importing under Node is the guard).
import {
  forwardXZ, rightXZ, lookDir, eyeHeight, levelBoundsXZ, clampToBounds, stepWalk, stepLook,
  EYE_HEIGHT, WALK_SPEED, MAX_PITCH,
} from '../viewer/walk.js';
// View-layer interaction logic that must stay engine-independent. Node has no `three`
// installed, so if planView.js or tools.js imported three this file would fail to load —
// importing them here is itself the model/view-separation guard for S2/S3.
import { createPlanView, snap, pointToSegment, nearestVertex, nearestWallHit } from '../edit/planView.js';
// Pro-seam snapping/constraint math — pure, must stay three-free (importing under Node is the guard).
import {
  defaultSnapSettings, normalizeSnapSettings, nearestSnapVertex, constrainAngle, snapPoint,
} from '../edit/snapping.js';
import { ToolController } from '../edit/tools.js';
import { sampleHome } from '../templates/sampleHome.js';
import { blank, studio, STARTERS } from '../templates/starters.js';
// S4 picker helpers — pure, must stay three-free/DOM-free (importing under Node is the guard).
import { createDirtyTracker } from '../app/dirty.js';
import { planThumbnailSVG, wallsBounds } from '../app/thumbnail.js';
// Node fs/path — used only by the static model/view-separation guard at the bottom of
// this file. (The imports above already prove each pure module *loads* without three;
// the guard below proves no pure module *imports* three even along an untaken branch.)
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

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

// ============================================================================
// S2/S3 view-layer interaction logic (engine-independent half).
// planView is pure screen<->world + plan-space geometry; ToolController turns
// gestures into the SAME commands proven above. No Three.js is imported here.
// ============================================================================

// 10) planView screen<->world mapping round-trips
const pv0 = createPlanView({ width: 400, height: 300, pxPerMeter: 40, center: { x: 0, z: 0 } });
const c0 = pv0.screenToWorld(200, 150);
ok(near(c0.x, 0) && near(c0.z, 0), '10a canvas center maps to view center');
const sc = pv0.worldToScreen({ x: 1, z: -0.5 });
ok(near(sc.px, 240) && near(sc.py, 130), '10b worldToScreen matches pxPerMeter');
const rt = pv0.worldToScreen(pv0.screenToWorld(123, 77));
ok(near(rt.px, 123) && near(rt.py, 77), '10c screen->world->screen round-trips');
ok(near(snap({ x: 0.13, z: -0.07 }, 0.1).x, 0.1) && near(snap({ x: 0.13, z: -0.07 }, 0.1).z, -0.1), '10d grid snap');

// 11) plan-space hit-testing is correct
const seg = pointToSegment({ x: 2, z: 1 }, { x: 0, z: 0 }, { x: 4, z: 0 });
ok(near(seg.dist, 1) && near(seg.t, 0.5) && near(seg.point.x, 2), '11a point-to-segment distance/param');
const tw = [createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { id: 'w0' })];
const nv = nearestVertex({ x: 3.95, z: 0.05 }, tw, 0.25);
ok(nv && nv.wallId === 'w0' && nv.end === 'b', '11b nearestVertex finds the near endpoint');
ok(nearestVertex({ x: 2, z: 2 }, tw, 0.25) === null, '11c nearestVertex misses when far');
const nwh = nearestWallHit({ x: 3, z: 0.05 }, tw, 0.3);
ok(nwh && near(nwh.offset, 3, 0.1), '11d nearestWallHit offset = distance from endpoint a');

// 12) ToolController draws a 4-wall room from blank (S2), driving real commands
_resetIds();
const tProj = createProject({ name: 'Draw', levels: [createLevel({ id: 'L' })] });
const tHist = new History(tProj, { limit: 100 });
const tState = createAppState({ mode: MODE.SIMPLE });
const tPV = createPlanView({ width: 400, height: 400, pxPerMeter: 40, center: { x: 2, z: 2 } });
let rebuilds = 0;
const tc = new ToolController({ state: tState, history: tHist, project: tProj, planView: tPV, levelId: 'L', rebuild: () => { rebuilds++; } });

tc.setTool(TOOL.DRAW_WALL);
ok(tState.activeTool === TOOL.DRAW_WALL, '12a controller switched to draw-wall');
for (const p of [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }, { x: 0, z: 0 }]) tc.pointerDown(p);
tc.finishChain();
ok(tProj.levels[0].walls.length === 4, '12b drew a 4-wall room via the tool controller');
ok(validateProject(tProj).ok, '12c drawn room validates');
ok(rebuilds === 4, '12d rebuild fired once per committed wall (not on the first anchor click)');
ok(near(wallLength(tProj.levels[0].walls[0]), 4), '12e first wall is 4 m long');

// duplicate click at the same point must NOT create a zero-length wall
const before12 = tProj.levels[0].walls.length;
tc.setTool(TOOL.DRAW_WALL); tc.pointerDown({ x: 1, z: 1 }); tc.pointerDown({ x: 1, z: 1 });
ok(tProj.levels[0].walls.length === before12, '12f duplicate/near-zero click makes no wall');
tc.finishChain();

// 13) select + drag a shared corner moves BOTH adjoining walls as one undoable edit (S2)
tc.setTool(TOOL.SELECT);
tc.pointerDown({ x: 4, z: 0 });          // grab the corner shared by walls 0 and 1
tc.pointerMove({ x: 5, z: 0 });
tc.pointerUp({ x: 5, z: 0 });
const w0 = tProj.levels[0].walls[0], w1 = tProj.levels[0].walls[1];
ok(near(w0.b.x, 5) && near(w1.a.x, 5), '13a corner drag moved both walls sharing it');
ok(tHist.undoStack[tHist.undoStack.length - 1].name === 'Move corner', '13b drag committed as one composite command');
const draggedSer = serialize(tProj);
tc.undo();
ok(near(tProj.levels[0].walls[0].b.x, 4) && near(tProj.levels[0].walls[1].a.x, 4), '13c undo restores the corner');
tc.redo();
ok(serialize(tProj) === draggedSer, '13d redo re-applies the corner move byte-identical');
tc.undo(); // leave the room square

// 14) place a door and a window by clicking a wall (S3), lossless round-trip survives
tc.setTool(TOOL.PLACE_DOOR);
tc.pointerDown({ x: 2, z: 0.05 });        // click near wall 0 (the z=0 wall)
ok(tProj.levels[0].openings.length === 1 && tProj.levels[0].openings[0].kind === 'door', '14a door placed on clicked wall');
tc.setTool(TOOL.PLACE_WINDOW);
tc.pointerDown({ x: 2, z: 3.95 });        // click near the far wall
ok(tProj.levels[0].openings.length === 2 && tProj.levels[0].openings[1].kind === 'window', '14b window placed on clicked wall');
ok(validateProject(tProj).ok, '14c door + window both fit and validate');
const openSer = serialize(tProj);
ok(serialize(deserialize(openSer)) === openSer, '14d lossless round-trip survives placed openings');

// 15) selecting a wall + deleteSelection cascades to its openings and undoes losslessly (S1/S2)
tc.setTool(TOOL.SELECT);
tc.pointerDown({ x: 2, z: 0.02 });        // select wall 0 (carries the door)
ok(tState.selection && tState.selection.kind === 'wall', '15a clicking a wall selects it');
const beforeDel = serialize(tProj);
tc.deleteSelection();
ok(tProj.levels[0].walls.length === 3, '15b wall deleted');
ok(tProj.levels[0].openings.every((o) => o.kind !== 'door'), '15c its door cascaded away');
tc.undo();
ok(serialize(tProj) === beforeDel, '15d undo delete restores wall + door byte-identical');

// 16) the Simple/Pro seam still gates exact tools (unchanged by S2/S3)
ok(isAvailable('exact-dimensions', tState.mode) === false, '16a exact dimensions stay Pro-only in Simple');

// 17) composite command applies/reverts its subcommands in order
_resetIds();
const cp = createProject({ name: 'C', levels: [createLevel({ id: 'L' })] });
const ch = new History(cp);
ch.execute(composite('Two walls', [
  addWall('L', createWall({ x: 0, z: 0 }, { x: 1, z: 0 }, { id: 'p' })),
  addWall('L', createWall({ x: 1, z: 0 }, { x: 1, z: 1 }, { id: 'q' })),
]));
ok(cp.levels[0].walls.length === 2, '17a composite applied both subcommands');
ch.undo();
ok(cp.levels[0].walls.length === 0, '17b composite undo reverted both');

// 18) setView (S5) — undoable, persisted display pref that never touches geometry
_resetIds();
const vp = sampleHome();
const vh = new History(vp);
const wallsBefore = vp.levels[0].walls.length, opsBefore = vp.levels[0].openings.length;
const vBaseline = serialize(vp);
ok((vp.meta && vp.meta.view) === undefined, '18a fresh project has no view pref');
vh.execute(setView(VIEW.CUTAWAY));
ok(vp.meta.view === VIEW.CUTAWAY, '18b setView writes meta.view');
ok(vp.levels[0].walls.length === wallsBefore && vp.levels[0].openings.length === opsBefore, '18c setView leaves geometry untouched');
ok(validateProject(vp).ok, '18d project with a view pref still validates');
const vCutSer = serialize(vp);
ok(serialize(deserialize(vCutSer)) === vCutSer, '18e view pref round-trips losslessly');
vh.execute(setView(VIEW.EXTERIOR));
ok(vp.meta.view === VIEW.EXTERIOR, '18f setView overwrites the pref');
vh.undo();
ok(vp.meta.view === VIEW.CUTAWAY, '18g undo restores the previous view');
vh.undo();
ok(serialize(vp) === vBaseline, '18h undoing the first setView restores the baseline byte-identically (no lingering meta.view)');

// 19) cutawayHiddenWalls (S5) — pure geometry decision for the interior cutaway
_resetIds();
// a 4x4 square room centred at the origin (walls named by the side they sit on)
const sq = [
  createWall({ x: -2, z: -2 }, { x: 2, z: -2 }, { id: 'north' }),  // z = -2
  createWall({ x: 2, z: -2 }, { x: 2, z: 2 }, { id: 'east' }),     // x = +2
  createWall({ x: 2, z: 2 }, { x: -2, z: 2 }, { id: 'south' }),    // z = +2
  createWall({ x: -2, z: 2 }, { x: -2, z: -2 }, { id: 'west' }),   // x = -2
];
const ctr = wallsCenterXZ(sq);
ok(near(ctr.x, 0) && near(ctr.z, 0), '19a centroid of the square is the origin');
const fromSouthEast = cutawayHiddenWalls(sq, { x: 8, z: 8 });   // camera in the +x/+z quadrant
ok(fromSouthEast.has('south') && fromSouthEast.has('east'), '19b near (camera-side) walls are hidden');
ok(!fromSouthEast.has('north') && !fromSouthEast.has('west'), '19c far walls stay visible to frame the interior');
const fromNorth = cutawayHiddenWalls(sq, { x: 0, z: -8 });      // camera on the -z side
ok(fromNorth.has('north') && !fromNorth.has('south'), '19d cutaway follows the camera to the opposite side');
ok(cutawayHiddenWalls(sq, { x: 0, z: 0 }).size === 0, '19e camera over the centre hides nothing (degenerate guard)');
ok(cutawayHiddenWalls([], { x: 5, z: 5 }).size === 0, '19f no walls -> nothing hidden (no throw)');

// ============================================================================
// S6 walk-through camera math (engine-independent half). The controller that maps
// these numbers onto the Three camera lives in viewer/walkCamera.js (three-side);
// the movement/look/clamp logic proven here is pure and node-testable.
// ============================================================================

// 20) heading basis vectors — yaw 0 looks toward -Z; right is +X (right-handed, +Y up)
ok(near(forwardXZ(0).x, 0) && near(forwardXZ(0).z, -1), '20a yaw 0 forward is -Z');
ok(near(rightXZ(0).x, 1) && near(rightXZ(0).z, 0), '20b yaw 0 right is +X');
// yaw +90° (turn left, CCW from above) points forward toward -X
ok(near(forwardXZ(Math.PI / 2).x, -1) && near(forwardXZ(Math.PI / 2).z, 0), '20c yaw +90° forward is -X');
ok(near(Math.hypot(forwardXZ(1.3).x, forwardXZ(1.3).z), 1), '20d forward is a unit vector');
// forward ⟂ right at any yaw
const dotFR = forwardXZ(0.7).x * rightXZ(0.7).x + forwardXZ(0.7).z * rightXZ(0.7).z;
ok(near(dotFR, 0), '20e forward and right are perpendicular');

// 21) lookDir agrees with forwardXZ at pitch 0, and pitch tilts the y component
const ld0 = lookDir(0, 0);
ok(near(ld0.x, 0) && near(ld0.y, 0) && near(ld0.z, -1), '21a lookDir at yaw/pitch 0 is -Z');
ok(lookDir(0, 0.5).y > 0 && lookDir(0, -0.5).y < 0, '21b positive pitch looks up, negative looks down');
ok(near(Math.hypot(lookDir(0.9, 0.4).x, lookDir(0.9, 0.4).y, lookDir(0.9, 0.4).z), 1), '21c lookDir is a unit vector');

// 22) eye height = level elevation + standing eye height
ok(near(eyeHeight(null), EYE_HEIGHT), '22a eye height with no level is the default');
ok(near(eyeHeight({ elevation: 3 }), 3 + EYE_HEIGHT), '22b eye height adds the level elevation');

// 23) levelBoundsXZ + clampToBounds keep the walker inside the (inset) footprint
const room = [
  createWall({ x: 0, z: 0 }, { x: 6, z: 0 }, { id: 'n' }),
  createWall({ x: 6, z: 0 }, { x: 6, z: 4 }, { id: 'e' }),
  createWall({ x: 6, z: 4 }, { x: 0, z: 4 }, { id: 's' }),
  createWall({ x: 0, z: 4 }, { x: 0, z: 0 }, { id: 'w' }),
];
const bnd = levelBoundsXZ(room, 0.5);
ok(near(bnd.minX, 0.5) && near(bnd.maxX, 5.5) && near(bnd.minZ, 0.5) && near(bnd.maxZ, 3.5), '23a bounds inset by pad');
ok(levelBoundsXZ([], 0.5) === null, '23b no walls -> null bounds');
const cl = clampToBounds({ x: 99, z: -99 }, bnd);
ok(near(cl.x, 5.5) && near(cl.z, 0.5), '23c point outside is clamped onto the inset box');
const inside = clampToBounds({ x: 3, z: 2 }, bnd);
ok(near(inside.x, 3) && near(inside.z, 2), '23d point inside is left untouched');
ok(near(clampToBounds({ x: 3, z: 2 }, null).x, 3), '23e null bounds -> unclamped');
// a footprint narrower than 2·pad collapses that axis to its midpoint (no inverted box)
const thin = levelBoundsXZ([createWall({ x: 0, z: 0 }, { x: 0.4, z: 0 }, { id: 't' })], 0.5);
ok(near(thin.minX, 0.2) && near(thin.maxX, 0.2), '23f over-inset axis collapses to its midpoint');

// 24) stepWalk integrates movement; diagonals normalized; no keys -> no move
const noMove = stepWalk({ x: 1, z: 1 }, 0, {}, 0.5);
ok(near(noMove.x, 1) && near(noMove.z, 1), '24a no keys held -> position unchanged');
// forward at yaw 0 for 1 s at WALK_SPEED moves -Z by WALK_SPEED
const fwd1 = stepWalk({ x: 0, z: 0 }, 0, { forward: true }, 1);
ok(near(fwd1.x, 0) && near(fwd1.z, -WALK_SPEED), '24b forward 1s moves -Z by walk speed');
// strafing right at yaw 0 moves +X
const right1 = stepWalk({ x: 0, z: 0 }, 0, { right: true }, 1);
ok(near(right1.x, WALK_SPEED) && near(right1.z, 0), '24c strafe right moves +X');
// forward+back cancel
const cancel = stepWalk({ x: 5, z: 5 }, 1.1, { forward: true, back: true }, 1);
ok(near(cancel.x, 5) && near(cancel.z, 5), '24d opposing keys cancel out');
// diagonal (forward+right) is normalized: total distance still speed·dt, not √2·that
const diag = stepWalk({ x: 0, z: 0 }, 0, { forward: true, right: true }, 1);
ok(near(Math.hypot(diag.x, diag.z), WALK_SPEED), '24e diagonal move is normalized to walk speed');

// 25) stepLook turns/tilts and clamps pitch just shy of vertical
const l1 = stepLook({ yaw: 0, pitch: 0 }, 100, 0);
ok(l1.yaw < 0, '25a dragging right turns the view (yaw decreases)');
const l2 = stepLook({ yaw: 0, pitch: 0 }, 0, -100);
ok(l2.pitch > 0, '25b dragging up looks up (pitch increases)');
const l3 = stepLook({ yaw: 0, pitch: 0 }, 0, -1e6);   // yank far past vertical
ok(near(l3.pitch, MAX_PITCH) && l3.pitch < Math.PI / 2, '25c pitch is clamped just shy of straight up');
const l4 = stepLook({ yaw: 0, pitch: 0 }, 0, 1e6);
ok(near(l4.pitch, -MAX_PITCH), '25d pitch is clamped just shy of straight down');

// 26) S4 dirty tracker — pure model identity: current serialize vs. the clean baseline.
//     This is what gates confirm-on-unsaved in the picker; a real edit flips it dirty and
//     an undo-all flips it clean again, riding the Phase 1 lossless round-trip for free.
_resetIds();
const dh = studio();
const dLevelId = dh.levels[0].id;
const tracker = createDirtyTracker(serialize(dh));
ok(tracker.isDirty(serialize(dh)) === false, '26a freshly-tracked project is clean');
const dHist = new History(dh, { limit: 50 });
dHist.execute(addWall(dLevelId, createWall({ x: 0, z: 0 }, { x: 1, z: 0 }, { id: 'dw' })));
ok(tracker.isDirty(serialize(dh)) === true, '26b an edit makes it dirty');
dHist.undo();
ok(tracker.isDirty(serialize(dh)) === false, '26c undoing the edit makes it clean again (lossless)');
dHist.execute(addWall(dLevelId, createWall({ x: 0, z: 0 }, { x: 2, z: 0 }, { id: 'dw2' })));
ok(tracker.isDirty(serialize(dh)) === true, '26d dirty again after a new edit');
tracker.markClean(serialize(dh));   // simulate loading/saving at this state
ok(tracker.isDirty(serialize(dh)) === false, '26e markClean rebases the baseline to now');

// 27) S4 plan thumbnail — pure SVG from wall centerlines (no Three.js, no DOM).
_resetIds();
const th = studio();
const tb = wallsBounds(th);
ok(tb && near(tb.minX, 0) && near(tb.maxX, 4) && near(tb.minZ, 0) && near(tb.maxZ, 3.5), '27a wallsBounds spans the studio footprint');
ok(wallsBounds(blank()) === null, '27b blank project has no wall bounds');
const svg = planThumbnailSVG(th);
ok(svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'), '27c thumbnail is a complete SVG');
ok((svg.match(/<line/g) || []).length === th.levels[0].walls.length, '27d one line per wall (4)');
const blankSvg = planThumbnailSVG(blank());
ok(blankSvg.startsWith('<svg') && blankSvg.includes('<line'), '27e blank thumbnail renders an empty grid, not a crash');
// every starter yields a valid, non-empty thumbnail with a one-line description
for (const s of STARTERS) {
  ok(typeof s.desc === 'string' && s.desc.length > 0, `27f starter ${s.id} has a description`);
  ok(planThumbnailSVG(s.build()).startsWith('<svg'), `27g starter ${s.id} renders a thumbnail`);
}

// 28) Pro-seam exact-dimension editing — resize commands (lossless) + inspector descriptor.
_resetIds();
const rp = sampleHome();
const rLevel = rp.levels[0];
const rWall = rLevel.walls[0];
const rBaseline = serialize(rp);
const rHist = new History(rp, { limit: 50 });

// resizeWall: length moves endpoint b along the a→b axis, keeping a fixed; thickness/height set.
const wLen0 = wallLength(rWall);
rHist.execute(resizeWall(rLevel.id, rWall.id, { length: wLen0 + 1, thickness: 0.2, height: 3.0 }));
ok(near(wallLength(rWall), wLen0 + 1), '28a resizeWall length moves endpoint b to the new length');
ok(near(rWall.a.x, rLevel.walls[0].a.x) && near(rWall.thickness, 0.2) && near(rWall.height, 3.0), '28b resizeWall sets thickness+height, keeps endpoint a');
ok(validateProject(rp).ok, '28c project still valid after resizeWall');
rHist.undo();
ok(serialize(rp) === rBaseline, '28d resizeWall undo is byte-identical (lossless)');

// resizeOpening: width/sill/offset set; captured+restored losslessly.
const rOpening = rLevel.openings[0];
const rBaseline2 = serialize(rp);
rHist.execute(resizeOpening(rLevel.id, rOpening.id, { width: 1.0, sill: 0.1 }));
ok(near(rOpening.width, 1.0) && near(rOpening.sill, 0.1), '28e resizeOpening sets width+sill');
rHist.undo();
ok(serialize(rp) === rBaseline2, '28f resizeOpening undo is byte-identical (lossless)');

// degenerate guard + missing-id error paths
ok(threw(() => resizeWall(rLevel.id, 'nope').do(rp)), '28g resizeWall throws on unknown wall id');
ok(threw(() => resizeOpening(rLevel.id, 'nope').do(rp)), '28h resizeOpening throws on unknown opening id');

// describeSelection — Simple mode is read-only, Pro is editable; formats per display units.
const selWall = { kind: 'wall', id: rWall.id };
const dSimple = describeSelection(rp, selWall, { mode: MODE.SIMPLE, units: UNIT.METRIC });
ok(dSimple && dSimple.editable === false && dSimple.title === 'Wall', '28i wall describes read-only in Simple');
ok(dSimple.fields.map(f => f.key).join(',') === 'length,thickness,height', '28j wall exposes length/thickness/height');
const dPro = describeSelection(rp, selWall, { mode: MODE.PRO, units: UNIT.METRIC });
ok(dPro.editable === true, '28k wall describes editable in Pro');
const dImp = describeSelection(rp, selWall, { mode: MODE.PRO, units: UNIT.IMPERIAL });
ok(dImp.fields[0].text.includes('′'), '28l imperial units render feet-and-inches text');
const dOpen = describeSelection(rp, { kind: 'opening', id: rOpening.id }, { mode: MODE.PRO });
ok(dOpen && ['Door', 'Window'].includes(dOpen.title) && dOpen.fields.some(f => f.key === 'sill'), '28m opening describes width/height/sill/offset');
ok(describeSelection(rp, null) === null && describeSelection(rp, { kind: 'room', id: 'x' }) === null, '28n empty/room selection describes as null');

// buildDimensionEdit — parses input, guards range, returns an undoable command.
const eGood = buildDimensionEdit(rp, selWall, 'thickness', '0.15', { units: UNIT.METRIC });
ok(eGood.command && near(eGood.meters, 0.15), '28o buildDimensionEdit parses metric input into a command');
const eImp = buildDimensionEdit(rp, selWall, 'height', `8'0"`, { units: UNIT.IMPERIAL });
ok(eImp.command && near(eImp.meters, 8 * 12 * 0.0254), `28p buildDimensionEdit parses 8'0" to 2.4384 m`);
ok(buildDimensionEdit(rp, selWall, 'thickness', 'wat').error, '28q unparseable input returns an error');
ok(buildDimensionEdit(rp, selWall, 'thickness', '0').error, '28r zero thickness (positive field) is rejected');
ok(buildDimensionEdit(rp, { kind: 'opening', id: rOpening.id }, 'sill', '-1', {}).error, '28s negative sill (non-negative field) is rejected');
// applying a good edit through history keeps the project valid + lossless-undoable
const rBaseline3 = serialize(rp);
rHist.execute(buildDimensionEdit(rp, selWall, 'thickness', '0.18').command);
ok(near(rWall.thickness, 0.18) && validateProject(rp).ok, '28t applied dimension edit mutates the model and validates');
rHist.undo();
ok(serialize(rp) === rBaseline3, '28u dimension edit undo is byte-identical (lossless)');
// an out-of-range edit (opening wider than its wall) fails validation, so the UI rolls it back
const wallLenForOpening = wallLength(rLevel.walls.find(w => w.id === rOpening.wallId));
const eTooWide = buildDimensionEdit(rp, { kind: 'opening', id: rOpening.id }, 'width', String(wallLenForOpening + 2), {});
eTooWide.command.do(rp);
ok(!validateProject(rp).ok, '28v over-wide opening is caught by validateProject (UI rolls back)');
eTooWide.command.undo(rp);
ok(validateProject(rp).ok, '28w rolling the bad edit back restores a valid project');

// 29) Pro-seam snapping/constraint math (snapping.js) — pure grid/vertex/angle composition.
// ---- defaults + normalization ----
const sd = defaultSnapSettings();
ok(sd.grid.on && near(sd.grid.step, 0.1) && sd.vertex.on && !sd.angle.on, '29a defaults: grid+vertex on, angle off');
ok(defaultSnapSettings() !== sd && defaultSnapSettings().grid !== sd.grid, '29b defaults return a fresh object (no shared mutable state)');
const norm = normalizeSnapSettings({ grid: { on: true, step: -5 }, vertex: { on: true, tol: 0 }, angle: { on: true, stepDeg: 999 } });
ok(near(norm.grid.step, 0.1) && near(norm.vertex.tol, 0.2) && near(norm.angle.stepDeg, 45), '29c bad (non-positive / out-of-range) steps fall back to safe defaults');
ok(normalizeSnapSettings(null).grid.on === true, '29d null settings normalize to defaults');
ok(normalizeSnapSettings({ grid: { on: false }, vertex: { on: false }, angle: { on: false } }).grid.on === false, '29e explicit off is preserved');

// ---- nearestSnapVertex ----
const snWalls = [
  createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { id: 'w1' }),
  createWall({ x: 4, z: 0 }, { x: 4, z: 3 }, { id: 'w2' }),
];
const snNV = nearestSnapVertex({ x: 4.05, z: 0.05 }, snWalls, 0.2);
ok(snNV && near(snNV.x, 4) && near(snNV.z, 0), '29f nearestSnapVertex snaps onto the closest existing corner');
ok(nearestSnapVertex({ x: 2, z: 2 }, snWalls, 0.2) === null, '29g no corner within tolerance returns null');
const snNVKey = nearestSnapVertex({ x: 4.05, z: 0.05 }, snWalls, 0.2, new Set(['w1:b', 'w2:a']));
ok(snNVKey === null, '29h excluded endpoints are skipped (a dragged corner never snaps to itself)');

// ---- constrainAngle ----
const ca = constrainAngle({ x: 0, z: 0 }, { x: 3, z: 0.4 }, 45);   // ~7.6° -> snaps to 0°
ok(near(ca.z, 0) && near(ca.x, Math.hypot(3, 0.4)), '29i angle snap constrains a near-horizontal drag to 0° (ortho), preserving length');
const ca90 = constrainAngle({ x: 0, z: 0 }, { x: 0.3, z: 5 }, 90);  // -> 90° (straight +z)
ok(near(ca90.x, 0) && near(ca90.z, Math.hypot(0.3, 5)), '29j 90° step constrains a near-vertical drag to the +z axis');
const caLen = constrainAngle({ x: 0, z: 0 }, { x: 3.17, z: 0.02 }, 45, 0.1); // length quantized to 0.1
ok(near(caLen.z, 0) && near(caLen.x, 3.2), '29k length is quantized to the grid step when provided');
ok(constrainAngle({ x: 1, z: 1 }, { x: 1, z: 1 }, 45).x === 1, '29l zero-length input returns the anchor unchanged');

// ---- snapPoint composition + priority ----
const gridOnly = snapPoint({ x: 0.13, z: -0.07 }, { settings: { grid: { on: true, step: 0.1 }, vertex: { on: false }, angle: { on: false } } });
ok(near(gridOnly.x, 0.1) && near(gridOnly.z, -0.1) && gridOnly.snapped === 'grid', '29m grid-only snap rounds to the grid');
const vtxWins = snapPoint({ x: 4.06, z: 0.04 }, { settings: { grid: { on: true, step: 0.5 }, vertex: { on: true, tol: 0.2 }, angle: { on: false } }, walls: snWalls });
ok(near(vtxWins.x, 4) && near(vtxWins.z, 0) && vtxWins.snapped === 'vertex', '29n vertex snap wins over grid when a corner is in reach');
const angleWins = snapPoint({ x: 3, z: 0.3 }, { settings: { grid: { on: false }, vertex: { on: false }, angle: { on: true, stepDeg: 90 } }, anchor: { x: 0, z: 0 } });
ok(near(angleWins.z, 0) && angleWins.snapped === 'angle', '29o angle snap fires (with an anchor) when vertex misses');
const angleNoAnchor = snapPoint({ x: 3, z: 0.3 }, { settings: { grid: { on: true, step: 0.1 }, vertex: { on: false }, angle: { on: true, stepDeg: 90 } } });
ok(angleNoAnchor.snapped === 'grid', '29p angle snap needs an anchor; without one it falls through to grid');
const noSnap = snapPoint({ x: 3.14159, z: 2.71828 }, { settings: { grid: { on: false }, vertex: { on: false }, angle: { on: false } } });
ok(near(noSnap.x, 3.14159) && noSnap.snapped === null, '29q all constraints off returns the raw point (Pro freeform)');

// ---- integration: the controller honors Pro snapping settings (angle-locked wall draw) ----
_resetIds();
const spProj = createProject({ name: 'Snap', levels: [createLevel({ id: 'L' })] });
const spState = createAppState({ mode: MODE.PRO });
spState.setSnap({ grid: { on: false }, vertex: { on: false }, angle: { on: true, stepDeg: 90 } });
const spTC = new ToolController({ state: spState, history: new History(spProj), project: spProj, planView: createPlanView({ width: 400, height: 400 }), levelId: 'L', rebuild: () => {} });
spTC.setTool(TOOL.DRAW_WALL);
spTC.pointerDown({ x: 0, z: 0 });                 // anchor
spTC.pointerDown({ x: 4, z: 0.35 });              // ~5° off horizontal -> angle-locked to z=0
const spWall = spProj.levels[0].walls[0];
ok(spProj.levels[0].walls.length === 1 && near(spWall.b.z, 0), '29r Pro angle-lock: an off-axis draw click snaps the wall to ortho');
ok(validateProject(spProj).ok, '29s the angle-locked wall validates');
// setSnap deep-merge leaves untouched groups intact
spState.setSnap({ vertex: { on: true } });
ok(spState.snap.angle.on === true && spState.snap.vertex.on === true, '29t setSnap deep-merges without clobbering other groups');

// ---- 30) model/view-separation guard (static tree scan) -------------------------------
// The Phase 0/1 architecture and the Phase 2 plan make model/view separation *sacred*:
// core/ (data + rules), templates/ (pure starters), app/ (state, no render), and the
// interaction logic in edit/ + the pure viewer math must never import the Three.js engine.
// Every prior run asserted this by *loading* those modules under Node (they'd throw if they
// imported the absent `three`). That misses a leak hidden behind an untaken branch or a
// lazily-evaluated path. This guard scans the source text of the whole tree instead, so a
// stray `import ... from 'three'` in a module that's meant to be pure fails the suite even
// if that line never executes — the invariant the DEV-LOG hand-checked every run, automated.
const SRC = dirname(dirname(fileURLToPath(import.meta.url))); // .../src
// The ONLY modules permitted to depend on the Three.js engine (the render/build/pick layer).
const THREE_ALLOWED = new Set([
  'build/furniture.js', 'build/geometry.js', 'build/materials.js', 'build/sceneBuilder.js',
  'viewer/viewer.js', 'viewer/walkCamera.js', 'edit/picking.js',
]);
// A three-ecosystem import: `three`, `three/...`, `three-bvh-csg`, or `three-mesh-bvh`,
// whether static (`from 'three'`) or dynamic (`import('three')`).
const importsThree = (text) =>
  /\b(?:from|import)\s*\(?\s*['"](?:three(?:\/[^'"]*)?|three-bvh-csg|three-mesh-bvh)['"]/.test(text);
function collectJs(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'test' || ent.name === 'node_modules') continue; // skip this harness + deps
    const full = join(dir, ent.name);
    if (ent.isDirectory()) collectJs(full, acc);
    else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) acc.push(full);
  }
  return acc;
}
const jsFiles = collectJs(SRC);
ok(jsFiles.length >= 20, `30a source scan found the tree (${jsFiles.length} js files under src/)`);
const threeImporters = new Set();
for (const file of jsFiles) {
  const rel = relative(SRC, file).split(sep).join('/');
  if (importsThree(readFileSync(file, 'utf8'))) threeImporters.add(rel);
}
// Every module that touches three must be on the allowlist — no engine leak into pure code.
const leaks = [...threeImporters].filter((f) => !THREE_ALLOWED.has(f)).sort();
ok(leaks.length === 0, `30b no Three.js import leaks into pure model/view code (offenders: ${leaks.join(', ') || 'none'})`);
// The allowlist must not rot: every file we *permit* to import three must actually still
// do so (a renamed/retired view file should be removed from the list, not left dangling).
const staleAllow = [...THREE_ALLOWED].filter((f) => !threeImporters.has(f)).sort();
ok(staleAllow.length === 0, `30c the three-allowlist has no stale entries (dangling: ${staleAllow.join(', ') || 'none'})`);
// Spot-check the invariant's teeth from both sides.
ok(importsThree("import * as THREE from 'three';"), '30d guard detects a bare three import');
ok(importsThree("import { Brush } from 'three-bvh-csg';"), '30e guard detects a three-bvh-csg import');
ok(importsThree("const T = await import('three');"), '30f guard detects a dynamic three import');
ok(!importsThree("import { addWall } from '../edit/commands.js';"), '30g guard ignores non-three imports');
ok(!importsThree("// three is great but this is a comment, not an import"), '30h guard ignores the word three in prose');
// The four load-bearing pure directories must be entirely three-free.
for (const pureFile of ['core/model.js', 'core/units.js', 'app/state.js', 'templates/starters.js', 'edit/tools.js', 'edit/snapping.js', 'viewer/cutaway.js', 'viewer/walk.js']) {
  ok(!threeImporters.has(pureFile), `30i pure module stays engine-free: ${pureFile}`);
}

// ---- 31) multi-level (storey) editing — the Pro-seam "multi-level" feature ------------
// The model has always carried Levels[]; these commands let a Pro user stack storeys and
// the scene builder already renders each by elevation. Every command is lossless (undo is
// byte-identical) and keeps the storeys contiguous (each floor sits on the one below).

// 31a-b) stackElevations is a pure, contiguous, bottom-to-top stack.
const st = [createLevel({ height: 2.7, elevation: 0 }), createLevel({ height: 3.0 }), createLevel({ height: 2.5 })];
stackElevations(st);
ok(st[0].elevation === 0 && near(st[1].elevation, 2.7) && near(st[2].elevation, 5.7), '31a stackElevations stacks storeys contiguously bottom-to-top');
const st2 = [createLevel({ height: 2.7, elevation: 1.0 }), createLevel({ height: 2.4 })];  // ground re-anchors to 0
stackElevations(st2);
ok(st2[0].elevation === 0 && near(st2[1].elevation, 2.7), '31b stackElevations anchors the ground storey at 0 and stacks up');

// build a controlled single-storey project with a roof
_resetIds();
const mlProj = createProject({ levels: [createLevel({
  id: 'G', name: 'Ground floor', height: 2.7, roof: createRoof({ type: 'flat' }),
  walls: [createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { id: 'w1' }), createWall({ x: 4, z: 0 }, { x: 4, z: 3 }, { id: 'w2' })],
})] });
ok(validateProject(mlProj).ok, '31c base single-storey project validates');
const mlHist = new History(mlProj);

// 31d-i) addLevel: appends on top, stacks, moves the roof up; do/undo/redo lossless.
const beforeAdd = serialize(mlProj);
const up = createLevel({ id: 'U', name: 'Upper', height: 2.7, roof: createRoof({ type: 'flat' }) });
mlHist.execute(composite('Add storey', [addLevel(up), setLevelRoof('G', null)]));
ok(mlProj.levels.length === 2, '31d addLevel appended a second storey');
ok(near(findLevel(mlProj, 'U').elevation, 2.7), '31e new storey stacks on the ground floor (elevation 2.7)');
ok(findLevel(mlProj, 'G').roof === null && !!findLevel(mlProj, 'U').roof, '31f roof moved up to the new top storey');
ok(validateProject(mlProj).ok, '31g two-storey project validates');
const addSer = serialize(mlProj);
ok(serialize(deserialize(addSer)) === addSer, '31h two-storey project round-trips lossless');
mlHist.undo();
ok(serialize(mlProj) === beforeAdd, '31i undo add-storey restores byte-identical (roof back on ground)');
mlHist.redo();
ok(serialize(mlProj) === addSer, '31j redo add-storey re-applies byte-identical');

// 31k-l) setLevelHeight: raising a lower storey pushes everything above it up; lossless undo.
const beforeH = serialize(mlProj);
mlHist.execute(setLevelHeight('G', 3.2));
ok(near(findLevel(mlProj, 'G').height, 3.2) && near(findLevel(mlProj, 'U').elevation, 3.2), '31k raising the ground storey height pushes the upper storey up');
mlHist.undo();
ok(serialize(mlProj) === beforeH, '31l undo setLevelHeight restores byte-identical (heights + elevations)');

// 31m-n) renameLevel is a label-only, lossless edit.
const beforeN = serialize(mlProj);
mlHist.execute(renameLevel('U', 'Bedrooms'));
ok(findLevel(mlProj, 'U').name === 'Bedrooms', '31m renameLevel set the storey name');
mlHist.undo();
ok(serialize(mlProj) === beforeN, '31n undo rename restores byte-identical');

// 31o-q) removeLevel restacks the survivors; lossless undo restores level + elevations.
const beforeR = serialize(mlProj);
mlHist.execute(removeLevel('G'));
ok(mlProj.levels.length === 1 && findLevel(mlProj, 'U'), '31o removeLevel removed the named storey');
ok(near(findLevel(mlProj, 'U').elevation, 0), '31p the remaining storey restacks down to elevation 0');
mlHist.undo();
ok(serialize(mlProj) === beforeR, '31q undo removeLevel restores the storey + all elevations byte-identical');

// 31r-s) removeLevel refuses to remove the last storey (a home needs a floor).
const solo = createProject({ levels: [createLevel({ id: 'S', height: 2.7 })] });
ok(threw(() => removeLevel('S').do(solo)), '31r removeLevel refuses to remove the last storey');
ok(solo.levels.length === 1, '31s the last storey survives the refused removal');

// 31t-u) setLevelRoof clears/sets a roof losslessly.
const mlRp = createProject({ levels: [createLevel({ id: 'R', height: 2.7, roof: createRoof({ type: 'flat' }) })] });
const mlRBefore = serialize(mlRp);
const mlRc = setLevelRoof('R', null);
mlRc.do(mlRp);
ok(findLevel(mlRp, 'R').roof === null, '31t setLevelRoof(null) clears the roof');
mlRc.undo(mlRp);
ok(serialize(mlRp) === mlRBefore, '31u undo setLevelRoof restores the roof byte-identical');

// 31v) validateProject now rejects a non-positive storey height.
ok(!validateProject(createProject({ levels: [createLevel({ id: 'B', height: 0 })] })).ok, '31v validateProject rejects a non-positive storey height');

// 31w-z) active-level integration: drawing targets the active storey, not the ground floor.
_resetIds();
const swProj = createProject({ levels: [
  createLevel({ id: 'G2', name: 'Ground', height: 2.7 }),
  createLevel({ id: 'U2', name: 'Upper', height: 2.7, elevation: 2.7 }),
] });
const swState = createAppState({ activeLevelId: 'U2' });
ok(swState.activeLevelId === 'U2', '31w createAppState carries the active-level id');
swState.setActiveLevel('G2'); ok(swState.activeLevelId === 'G2', '31x setActiveLevel switches the active storey');
swState.setActiveLevel('U2');
const swTC = new ToolController({ state: swState, history: new History(swProj), project: swProj, planView: createPlanView({ width: 400, height: 400 }), levelId: swState.activeLevelId, rebuild: () => {} });
swTC.setTool(TOOL.DRAW_WALL);
swTC.pointerDown({ x: 0, z: 0 });
swTC.pointerDown({ x: 3, z: 0 });
ok(findLevel(swProj, 'U2').walls.length === 1 && findLevel(swProj, 'G2').walls.length === 0, '31y drawing lands on the active storey (upper), not the ground floor');
ok(serialize(deserialize(serialize(swProj))) === serialize(swProj), '31z multi-storey edits stay lossless');

// ---- 32) roof types beyond flat (gable/hip) — the Pro-seam "roof-editor" feature ------
_resetIds();
// 32a-c) type set + pitch helper.
ok(ROOF_TYPES.includes('flat') && ROOF_TYPES.includes('gable') && ROOF_TYPES.includes('hip'), '32a ROOF_TYPES lists flat/gable/hip');
ok(!isPitched('flat') && isPitched('gable') && isPitched('hip'), '32b isPitched: flat no, gable/hip yes');
ok(near(pitchRise(2, 30), 2 * Math.tan(Math.PI / 6)) && pitchRise(2, 0) === 0 && pitchRise(-5, 30) === 0, '32c pitchRise = run·tan(pitch), clamps 0/negative run');

// A predictable 6 (X) × 4 (Z) rectangular level, overhang 0 for exact footprint math.
const roofLevel = (roof) => createLevel({
  id: 'RF', height: 2.7, roof,
  walls: [
    createWall({ x: 0, z: 0 }, { x: 6, z: 0 }),
    createWall({ x: 6, z: 0 }, { x: 6, z: 4 }),
    createWall({ x: 6, z: 4 }, { x: 0, z: 4 }),
    createWall({ x: 0, z: 4 }, { x: 0, z: 0 }),
  ],
});

// 32d-e) roofFootprint: null with no walls; bbox expanded by overhang.
ok(roofFootprint({ walls: [] }) === null, '32d roofFootprint is null for a wall-less level');
const fpO = roofFootprint(roofLevel(createRoof({ type: 'gable', overhang: 0.5 })));
ok(near(fpO.x0, -0.5) && near(fpO.x1, 6.5) && near(fpO.z0, -0.5) && near(fpO.z1, 4.5), '32e roofFootprint expands the wall bbox by the overhang');

// 32f-j) gable shell over the 6×4 footprint (overhang 0).
const fp = { x0: 0, x1: 6, z0: 0, z1: 4 };
const baseY = 2.7, pitch = 30;
const rise = pitchRise(2, pitch); // short half-span = D/2 = 2
const gable = roofSolid('gable', fp, { baseY, pitch });
ok(gable.triangleCount === 8 && gable.positions.length === 8 * 9, '32f gable = 8 closed triangles (2 slopes + 2 gable ends + bottom cap)');
ok(near(gable.ridgeY, baseY + rise), '32g gable ridge height = eave + run·tan(pitch)');
const gY = gable.positions.filter((_, i) => i % 3 === 1);
ok(Math.min(...gY) >= baseY - 1e-9 && Math.max(...gY) <= gable.ridgeY + 1e-9, '32h no gable vertex dips below the eave or rises above the ridge');
const gX = gable.positions.filter((_, i) => i % 3 === 0), gZ = gable.positions.filter((_, i) => i % 3 === 2);
ok(Math.min(...gX) >= -1e-9 && Math.max(...gX) <= 6 + 1e-9 && Math.min(...gZ) >= -1e-9 && Math.max(...gZ) <= 4 + 1e-9, '32i every gable vertex stays inside the footprint');
ok(gable.apex === null, '32j a gable has a ridge, not an apex');

// 32k-m) hip shell: rectangle keeps a ridge; square degenerates to a pyramid apex.
const hip = roofSolid('hip', fp, { baseY, pitch });
ok(hip.triangleCount === 8 && hip.apex === null, '32k hip over a rectangle = 8 triangles (2 trapezoids + 2 hip ends + bottom), no apex');
const hipSq = roofSolid('hip', { x0: 0, x1: 4, z0: 0, z1: 4 }, { baseY, pitch });
ok(hipSq.apex !== null && near(hipSq.apex[0], 2) && near(hipSq.apex[2], 2), '32l a square hip is a pyramid — apex over the footprint centre');
ok(hipSq.triangleCount === 6, '32m the pyramid drops its zero-area faces down to 6 triangles (4 sides + bottom)');

// 32n-r) setRoofType command: do/undo/redo byte-lossless; guards.
_resetIds();
const rtProj = createProject({ levels: [roofLevel(createRoof({ type: 'flat' }))] });
const rtBefore = serialize(rtProj);
const rtHist = new History(rtProj);
rtHist.execute(setRoofType('RF', { type: 'gable', pitch: 35 }));
ok(findLevel(rtProj, 'RF').roof.type === 'gable' && findLevel(rtProj, 'RF').roof.pitch === 35, '32n setRoofType switches to gable and sets the pitch');
ok(findLevel(rtProj, 'RF').roof.thickness === 0.15 && findLevel(rtProj, 'RF').roof.overhang === 0.3, '32o setRoofType leaves thickness/overhang/material untouched');
ok(serialize(deserialize(serialize(rtProj))) === serialize(rtProj), '32p a gable roof round-trips losslessly');
rtHist.undo();
ok(serialize(rtProj) === rtBefore, '32q undo setRoofType restores the flat roof byte-identical');
rtHist.redo();
ok(findLevel(rtProj, 'RF').roof.type === 'gable' && findLevel(rtProj, 'RF').roof.pitch === 35, '32r redo re-applies the gable');
// backfill: a roof with no pitch field gets the default when switched to a pitched type.
const noPitch = createProject({ levels: [roofLevel({ type: 'flat', thickness: 0.15, overhang: 0.3, material: 'roof' })] });
setRoofType('RF', { type: 'hip' }).do(noPitch);
ok(findLevel(noPitch, 'RF').roof.pitch === DEFAULT_ROOF_PITCH, '32s switching a pitch-less roof to hip backfills the default pitch');
ok(threw(() => setRoofType('RF', { type: 'gable' }).do(createProject({ levels: [createLevel({ id: 'RF', height: 2.7 })] }))), '32t setRoofType throws on a level with no roof');

// 32u-w) validation rejects a bad roof type or an out-of-range pitch.
ok(validateProject(createProject({ levels: [roofLevel(createRoof({ type: 'gable', pitch: 35 }))] })).ok, '32u a valid gable roof passes validation');
ok(!validateProject(createProject({ levels: [roofLevel(createRoof({ type: 'mansard' }))] })).ok, '32v validateProject rejects an unknown roof type');
ok(!validateProject(createProject({ levels: [roofLevel(createRoof({ type: 'hip', pitch: 95 }))] })).ok, '32w validateProject rejects an out-of-range roof pitch');

// 32x) the roof-editor seam is Pro-only (dormant in Simple).
ok(!isAvailable('roof-editor', MODE.SIMPLE) && isAvailable('roof-editor', MODE.PRO), '32x roof-editor is a Pro-seam feature');

// ---- 33) measure tool (Pro-seam ruler) — pure distance math + tool state machine ------
_resetIds();
// 33a-c) pure math.
ok(near(measureDistance({ x: 0, z: 0 }, { x: 3, z: 4 }), 5), '33a measureDistance = straight-line plan distance');
ok(measureMidpoint({ x: 0, z: 0 }, { x: 4, z: 2 }).x === 2 && measureMidpoint({ x: 0, z: 0 }, { x: 4, z: 2 }).z === 1, '33b measureMidpoint is the segment centre');
ok(describeMeasure(null) === null && describeMeasure({ from: { x: 0, z: 0 }, to: null }) === null, '33c describeMeasure needs both endpoints');
const md = describeMeasure({ from: { x: 0, z: 0 }, to: { x: 0, z: 2.5 }, complete: true }, UNIT.METRIC);
ok(near(md.meters, 2.5) && md.label === formatLength(2.5, UNIT.METRIC) && md.complete === true, '33d describeMeasure carries meters + units label + complete');
const mdImp = describeMeasure({ from: { x: 0, z: 0 }, to: { x: 0, z: 3.048 } }, UNIT.IMPERIAL);
ok(mdImp.label === formatLength(3.048, UNIT.IMPERIAL) && mdImp.complete === false, '33e describeMeasure formats imperial + defaults complete=false');

// 33f-l) the tool state machine: two clicks measure, a third restarts, no model mutation.
const mProj = createProject({ levels: [createLevel({ id: 'M', name: 'G', height: 2.7, walls: [
  createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { id: 'mw' }),
] })] });
const mBefore = serialize(mProj);
const mState = createAppState({ mode: MODE.PRO, activeLevelId: 'M' });
const mHist = new History(mProj);
const mTC = new ToolController({ state: mState, history: mHist, project: mProj, planView: createPlanView({ width: 400, height: 400 }), levelId: 'M', rebuild: () => {} });
mTC.setTool(TOOL.MEASURE);
ok(mState.activeTool === TOOL.MEASURE, '33f the measure tool activates');
ok(mTC.measureSegment() === null, '33g no ruler before the first click');
mTC.pointerDown({ x: 0, z: 0 });
ok(mTC.measureSegment() === null, '33h one click sets the anchor but is not yet a segment');
mTC.pointerDown({ x: 3, z: 0 });
let mseg = mTC.measureSegment();
ok(mseg && mseg.complete && near(measureDistance(mseg.from, mseg.to), 3), '33i the second click completes a 3 m measurement');
ok(serialize(mProj) === mBefore && mHist.undoStack.length === 0, '33j measuring mutates NOTHING — no model change, no command on the stack');
// a third click starts a fresh measurement (anchor only, no segment yet)
mTC.pointerDown({ x: 1, z: 1 });
ok(mTC.measureSegment() === null, '33k a third click restarts the ruler from a new anchor');
// switching tools clears the ruler
mTC.pointerDown({ x: 2, z: 2 });
ok(mTC.measureSegment() !== null, '33l a completed ruler survives until the tool changes');
mTC.setTool(TOOL.SELECT);
ok(mTC.measureSegment() === null, '33m switching tools drops the ruler');

// 33n) live preview: after one click, pointerMove yields a previewable segment (dashed, not complete).
mTC.setTool(TOOL.MEASURE);
mTC.pointerDown({ x: 0, z: 0 });
mTC.pointerMove({ x: 0, z: 2 });
const mprev = mTC.measureSegment();
ok(mprev && mprev.complete === false && near(measureDistance(mprev.from, mprev.to), 2), '33n live preview tracks the pointer before the second click');

// 33o) the measure tool is a Pro-seam feature (dormant in Simple).
ok(!isAvailable('measure-tool', MODE.SIMPLE) && isAvailable('measure-tool', MODE.PRO), '33o measure-tool is Pro-only');
ok(availableTools(MODE.PRO).includes('measure-tool') && !availableTools(MODE.SIMPLE).includes('measure-tool'), '33p measure-tool appears in the Pro tool set only');

// ---- 34) room measurements (floor area / perimeter / centroid) — the measure follow-up ----
// Pure geometry derived from a room's polygon, surfaced read-only in the inspector when a
// room floor is selected. Adds NO model fields — measurements are computed on demand, so the
// Phase 1 lossless save round-trip is untouched (asserted below).
_resetIds();
// 34a-c) a 4x3 rectangle: area 12 m², perimeter 14 m, centre at the middle.
const rectPts = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }];
ok(near(polygonArea(rectPts), 12), '34a polygonArea = shoelace floor area (4x3 = 12 m²)');
ok(near(polygonPerimeter(rectPts), 14), '34b polygonPerimeter sums every edge incl. the closing one');
const rc = polygonCentroid(rectPts);
ok(near(rc.x, 2) && near(rc.z, 1.5), '34c polygonCentroid is the area-weighted centre');
// 34d) winding-independent: reversing the point order gives the same (positive) area.
ok(near(polygonArea([...rectPts].reverse()), 12), '34d area is winding-independent (abs shoelace)');
// 34e) a right triangle (legs 6 and 8, hypotenuse 10): area 24, perimeter 24.
const triPts = [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 0, z: 8 }];
ok(near(polygonArea(triPts), 24) && near(polygonPerimeter(triPts), 24), '34e triangle area + perimeter');
// 34f) degenerate polygons never NaN/throw: <3 points → 0 area/perimeter, finite centroid.
ok(polygonArea([{ x: 1, z: 1 }]) === 0 && polygonPerimeter([]) === 0, '34f degenerate polygon = 0 area/perimeter');
const dc = polygonCentroid([{ x: 2, z: 4 }, { x: 4, z: 8 }]);
ok(isFinite(dc.x) && isFinite(dc.z) && near(dc.x, 3) && near(dc.z, 6), '34g degenerate centroid falls back to vertex average (finite)');
// 34h) collinear points (zero area) → centroid still finite (no divide-by-zero).
const cc = polygonCentroid([{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 4, z: 0 }]);
ok(isFinite(cc.x) && isFinite(cc.z), '34h collinear (zero-area) centroid is finite');
// 34i-j) describeRoom carries SI + display labels, following the units toggle.
const dr = describeRoom(createRoom(rectPts, { name: 'Kitchen' }), UNIT.METRIC);
ok(dr.name === 'Kitchen' && near(dr.area, 12) && dr.areaLabel === formatArea(12, UNIT.METRIC) && dr.perimeterLabel === formatLength(14, UNIT.METRIC), '34i describeRoom = name + area/perimeter + metric labels');
const drImp = describeRoom(createRoom(rectPts), UNIT.IMPERIAL);
ok(drImp.areaLabel === formatArea(12, UNIT.IMPERIAL) && drImp.perimeterLabel === formatLength(14, UNIT.IMPERIAL), '34j describeRoom labels follow the imperial units toggle');
ok(describeRoom(null) === null && describeRoom({ points: [{ x: 0, z: 0 }] }) === null, '34k describeRoom returns null for a room with no usable polygon');

// 34l-p) the inspector surfaces a selected ROOM as a read-only measurement (the gap this fills:
// before, selecting a room showed nothing). No command, no model mutation, lossless.
_resetIds();
const rmLevel = createLevel({ id: 'RL', name: 'G', height: 2.7, rooms: [createRoom(rectPts, { id: 'room-k', name: 'Kitchen' })] });
const rmProj = createProject({ levels: [rmLevel] });
const rmBefore = serialize(rmProj);
ok(findRoom(rmLevel, 'room-k') && findRoom(rmLevel, 'nope') === null, '34l findRoom locates a room by id on its level');
const roomDesc = describeSelection(rmProj, { kind: 'room', id: 'room-k' }, { mode: MODE.SIMPLE, units: UNIT.METRIC });
ok(roomDesc && roomDesc.type === 'room' && roomDesc.title === 'Kitchen', '34m selecting a room describes it (was: null / "nothing")');
ok(roomDesc.editable === false && roomDesc.measurement === true, '34n a room is a read-only measurement, not an editable seam (Simple OR Pro)');
ok(roomDesc.fields.length === 2 && roomDesc.fields[0].key === 'area' && roomDesc.fields[1].key === 'perimeter', '34o room fields are floor area + perimeter');
// even in Pro, a room stays a read-only measurement (no exact-entry — there is nothing to type).
const roomDescPro = describeSelection(rmProj, { kind: 'room', id: 'room-k' }, { mode: MODE.PRO, units: UNIT.METRIC });
ok(roomDescPro.editable === false && roomDescPro.measurement === true, '34p a room is read-only in Pro too (Simple/Pro seam does not apply)');
ok(serialize(rmProj) === rmBefore, '34q describing a room mutates NOTHING — the save round-trip is byte-identical');
ok(describeSelection(rmProj, { kind: 'room', id: 'ghost' }) === null, '34r a room id that does not exist yields no descriptor');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
