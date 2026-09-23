// C1 · precise polar (length + angle) wall entry — engine-independent verification
// (plain Node, no Three.js). Run: node src/test/angle-entry.test.mjs
//
// PHASE-3-PLAN.md Group C (C1 "angled / non-orthogonal wall drawing", Pro angle entry):
// walls already store free a/b points and the C2 mitre view already renders any angle, so
// C1's remaining gap is the *entry* — the classic CAD "direct distance/angle" so a user can
// type an exact length + heading instead of eyeballing a click. This proves:
//   • polarOffset places a point at an exact length/angle in the plan frame (0°=east, 90°=up)
//   • segmentPolar is its exact inverse (round-trips length + angle for arbitrary segments)
//   • normalizeAngleDeg folds any degree value into (−180,180] and is robust to junk
//   • ToolController.polarEntry commits a wall at the typed length/angle, extends the chain
//     for the next segment, is undoable, and refuses bad input (no chain / wrong tool / short)
//   • currentSegmentPolar reports the live rubber-band's length + angle (view-only)
//   • purity: entering segments adds NO save field; the Phase-1 save stays lossless round-trip
import { polarOffset, segmentPolar, normalizeAngleDeg } from '../edit/snapping.js';
import { ToolController } from '../edit/tools.js';
import { History } from '../edit/history.js';
import { TOOL, createAppState } from '../app/state.js';
import {
  createProject, createLevel, createWall, serialize, deserialize, _resetIds, wallLength,
} from '../core/model.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const ptNear = (p, x, z, e = 1e-9) => p && near(p.x, x, e) && near(p.z, z, e);

// Uses the REAL History (engine-independent, no Three.js) so do/undo run against the model
// exactly as in the app — the strongest proof the entry path is undoable and lossless.
function makeController(project) {
  const state = createAppState();
  state.setMode('pro');
  return new ToolController({
    state, history: new History(project), project,
    planView: {}, levelId: project.levels[0].id,
    rebuild: () => {}, onMessage: () => {},
  });
}
function freshProject() {
  _resetIds();
  const level = createLevel({ name: 'L1' });
  return createProject({ levels: [level] });
}

// ── 1. polarOffset — plan-frame placement (0°=east +x, 90°=up −z) ──────────────
{
  const a = { x: 1, z: 2 };
  ok(ptNear(polarOffset(a, 3, 0), 4, 2), '0° points east (+x)');
  ok(ptNear(polarOffset(a, 3, 90), 1, -1), '90° points up on the plan (−z)');
  ok(ptNear(polarOffset(a, 3, 180), -2, 2), '180° points west (−x)');
  ok(ptNear(polarOffset(a, 3, -90), 1, 5), '−90° points down on the plan (+z)');
  const d = polarOffset(a, 5, 36.86989764584402);   // 3-4-5 triangle, atan(3/4)
  ok(ptNear(d, 1 + 4, 2 - 3, 1e-9), '5 m @ 36.87° lands on the 3-4-5 point');
  ok(near(Math.hypot(polarOffset(a, 7.3, 123).x - a.x, polarOffset(a, 7.3, 123).z - a.z), 7.3), 'length is exact for an arbitrary angle');
}

// ── 2. segmentPolar — exact inverse of polarOffset ─────────────────────────────
{
  const from = { x: -2, z: 5 };
  for (const [L, A] of [[3, 0], [4.5, 90], [2, 180], [6, -90], [5, 36.87], [7.25, 123.4], [1.1, -147.9]]) {
    const to = polarOffset(from, L, A);
    const r = segmentPolar(from, to);
    ok(near(r.length, L, 1e-9), `segmentPolar length round-trips (${L}m @ ${A}°)`);
    ok(near(r.angleDeg, normalizeAngleDeg(A), 1e-7), `segmentPolar angle round-trips (${L}m @ ${A}°)`);
  }
  const z = segmentPolar({ x: 3, z: 3 }, { x: 3, z: 3 });
  ok(z.length === 0 && z.angleDeg === 0, 'zero-length segment reports length 0, angle 0 (no direction)');
}

// ── 3. normalizeAngleDeg — fold into (−180,180], robust to junk ─────────────────
{
  ok(normalizeAngleDeg(0) === 0, '0 → 0');
  ok(normalizeAngleDeg(90) === 90, '90 → 90');
  ok(normalizeAngleDeg(270) === -90, '270 → −90');
  ok(normalizeAngleDeg(360) === 0, '360 → 0');
  ok(normalizeAngleDeg(450) === 90, '450 → 90');
  ok(normalizeAngleDeg(-90) === -90, '−90 → −90');
  ok(normalizeAngleDeg(-270) === 90, '−270 → 90');
  ok(normalizeAngleDeg(180) === 180, '180 stays 180 (inclusive upper bound)');
  ok(normalizeAngleDeg(-180) === 180, '−180 folds to 180');
  ok(normalizeAngleDeg(540) === 180, '540 → 180');
  ok(normalizeAngleDeg(NaN) === 0, 'NaN → 0 (robust)');
  ok(normalizeAngleDeg('abc') === 0, 'non-numeric → 0 (robust)');
  ok(normalizeAngleDeg(Infinity) === 0, 'Infinity → 0 (robust)');
}

// ── 4. polarEntry — commit a wall at the typed length/angle, chain extends ──────
{
  const project = freshProject();
  const c = makeController(project);
  const walls = project.levels[0].walls;

  // No chain yet → polarEntry is a no-op with a helpful message (needs a start click).
  ok(c.polarEntry(3, 90) === false, 'polarEntry with no chain does nothing');
  ok(walls.length === 0, 'no wall added before a start point exists');

  c.setTool(TOOL.DRAW_WALL);
  c.pointerDown({ x: 0, z: 0 });            // first click sets the chain anchor (no wall yet)
  ok(walls.length === 0, 'first click only anchors the chain (no wall)');

  ok(c.polarEntry(4, 0) === true, 'polarEntry commits the first segment');
  ok(walls.length === 1, 'one wall after first polar segment');
  ok(ptNear(walls[0].a, 0, 0) && ptNear(walls[0].b, 4, 0), 'segment goes 4 m east from the anchor');
  ok(near(wallLength(walls[0]), 4), 'wall length matches the typed length');

  // Next segment continues from the previous endpoint (chain extends) at a non-ortho angle.
  ok(c.polarEntry(5, 90) === true, 'polarEntry commits a second, chained segment');
  ok(walls.length === 2, 'two walls after the second segment');
  ok(ptNear(walls[1].a, 4, 0) && ptNear(walls[1].b, 4, -5), 'second segment chains from the first endpoint, going up');

  // A genuinely non-orthogonal segment lands precisely (30-60-90-ish check via round-trip).
  ok(c.polarEntry(6, 210) === true, 'polarEntry commits a non-orthogonal segment');
  const seg = segmentPolar(walls[2].a, walls[2].b);
  ok(near(seg.length, 6, 1e-9) && near(seg.angleDeg, normalizeAngleDeg(210), 1e-7), 'non-orthogonal segment has the exact typed length + angle');
}

// ── 5. polarEntry — input guards ───────────────────────────────────────────────
{
  const project = freshProject();
  const c = makeController(project);
  const walls = project.levels[0].walls;
  c.setTool(TOOL.DRAW_WALL);
  c.pointerDown({ x: 1, z: 1 });
  ok(c.polarEntry(0.01, 45) === false, 'a length below the min-wall threshold is refused');
  ok(c.polarEntry(NaN, 45) === false, 'a non-numeric length is refused');
  ok(c.polarEntry(3, NaN) === false, 'a non-numeric angle is refused');
  ok(walls.length === 0, 'no wall was added by any refused entry');
  // Wrong tool → refused even with a would-be chain.
  const c2 = makeController(project);
  c2.setTool(TOOL.SELECT);
  ok(c2.polarEntry(3, 45) === false, 'polarEntry is refused when the wall tool is not active');
}

// ── 6. polarEntry is undoable (same command path as click-drawing) ─────────────
{
  const project = freshProject();
  const c = makeController(project);
  const nWalls = () => project.levels[0].walls.length;   // re-read: undo reassigns lvl.walls
  c.setTool(TOOL.DRAW_WALL);
  c.pointerDown({ x: 0, z: 0 });
  c.polarEntry(4, 0);
  c.polarEntry(4, 90);
  ok(nWalls() === 2, 'two walls entered');
  ok(!!c.history.undo() && nWalls() === 1, 'undo removes the last entered segment');
  ok(!!c.history.undo() && nWalls() === 0, 'undo removes the first entered segment');
}

// ── 7. currentSegmentPolar — live rubber-band readout (view-only) ──────────────
{
  const project = freshProject();
  const c = makeController(project);
  c.setTool(TOOL.DRAW_WALL);
  ok(c.currentSegmentPolar() === null, 'no readout before a chain starts');
  c.pointerDown({ x: 0, z: 0 });
  c.pointerMove({ x: 3, z: 0 });            // preview 3 m east
  const r = c.currentSegmentPolar();
  ok(r && near(r.length, 3) && near(r.angleDeg, 0), 'readout reflects the live preview (3 m @ 0°)');
  c.pointerMove({ x: 0, z: -2 });           // preview 2 m up
  const r2 = c.currentSegmentPolar();
  ok(r2 && near(r2.length, 2) && near(r2.angleDeg, 90), 'readout tracks the moving preview (2 m @ 90°)');
}

// ── 8. purity — entering segments adds no save field; save stays lossless ───────
{
  const project = freshProject();
  const before = serialize(project);
  const c = makeController(project);
  c.setTool(TOOL.DRAW_WALL);
  c.pointerDown({ x: 0, z: 0 });
  c.polarEntry(4, 0);
  c.polarEntry(4, 90);
  const after = serialize(project);
  // The walls we added are real model data; prove the round-trip is byte-identical (lossless)
  // and that no derived polar/entry field leaked onto the wall objects.
  const rt = serialize(deserialize(after));
  ok(rt === after, 'serialize→deserialize→serialize stays byte-identical (Phase 1 lossless preserved)');
  const w = project.levels[0].walls[0];
  ok(!('angle' in w) && !('length' in w) && !('polar' in w), 'no derived polar field leaks onto the wall model');
  ok(before !== after, 'sanity: the entered walls did change the saved project');
}

// ── summary ───────────────────────────────────────────────────────────────────
if (fail === 0) console.log(`\nALL PASS — ${pass} passed, 0 failed`);
else { console.log(`\nFAILED — ${pass} passed, ${fail} failed`); for (const f of fails) console.log('  · ' + f); process.exit(1); }
