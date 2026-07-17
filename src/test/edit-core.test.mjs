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
import { addWall, moveWallVertex, removeWall, addOpening, removeOpening, loadTemplate, composite, setView, resizeWall, resizeOpening } from '../edit/commands.js';
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
import { ToolController } from '../edit/tools.js';
import { sampleHome } from '../templates/sampleHome.js';
import { blank, studio, STARTERS } from '../templates/starters.js';
// S4 picker helpers — pure, must stay three-free/DOM-free (importing under Node is the guard).
import { createDirtyTracker } from '../app/dirty.js';
import { planThumbnailSVG, wallsBounds } from '../app/thumbnail.js';

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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
