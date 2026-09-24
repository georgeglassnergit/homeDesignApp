// E2 · Advisory checks — engine-independent verification (plain Node, no Three.js).
// Run: node src/test/advisory-checks.test.mjs
//
// Proves the pure advisory engine in src/core/advisoryChecks.js:
//   • ceiling below the habitable minimum flags per storey; a tall storey is clean
//   • a small room flags (habitable-area rule of thumb); a full-size room is clean
//   • a narrow / short door flags; a standard door is clean
//   • a tiny window flags egress-area; a high sill flags egress-sill; a normal window is clean
//   • a storey with rooms but no windows / no doors flags; a room-less storey does not
//   • thresholds are overridable; the disclaimer + summary are always present
//   • checks are pure: they mutate NOTHING, add NO save field, and never throw on
//     malformed / partial / empty input
// Lives in its own file so it composes with in-flight work (the roof suite's approach).
import {
  createProject, createLevel, createWall, createOpening, createRoom, createRoof,
  serialize, deserialize, _resetIds, wallLength,
} from '../core/model.js';
import {
  runAdvisoryChecks, advisorySummary, ADVISORY_DISCLAIMER, DEFAULT_THRESHOLDS,
  checkCeilingHeights, checkRoomAreas, checkRoomProportions, checkOpenings, checkStoreyHabitability,
  checkNaturalLight,
} from '../core/advisoryChecks.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const codes = (r) => r.findings.map((f) => f.code);
const has = (r, code) => codes(r).includes(code);
const forCode = (r, code) => r.findings.filter((f) => f.code === code);

// A square room polygon of the given side (m), centred at origin.
const squarePts = (side) => {
  const h = side / 2;
  return [{ x: -h, z: -h }, { x: h, z: -h }, { x: h, z: h }, { x: -h, z: h }];
};

// ── 1. Ceiling height ─────────────────────────────────────────────────────────
{
  _resetIds();
  const low = createProject({ levels: [createLevel({ name: 'Ground', height: 2.1 })] });
  const r = runAdvisoryChecks(low);
  ok(has(r, 'ceiling-height'), 'low ceiling (2.1 m) → ceiling-height advisory');
  const f = forCode(r, 'ceiling-height')[0];
  ok(f && f.measured === 2.1 && f.threshold === DEFAULT_THRESHOLDS.minCeilingHeight, 'ceiling finding carries measured + threshold');
  ok(f && f.ref && f.ref.kind === 'level', 'ceiling finding refs the level');
  ok(f && f.severity === 'advisory', 'ceiling finding severity is advisory');

  const okHeight = createProject({ levels: [createLevel({ height: 2.7 })] });
  ok(!has(runAdvisoryChecks(okHeight), 'ceiling-height'), 'standard 2.7 m ceiling → no ceiling advisory');

  // exactly at the threshold is NOT flagged (>= is fine)
  ok(!has(runAdvisoryChecks(createProject({ levels: [createLevel({ height: DEFAULT_THRESHOLDS.minCeilingHeight })] })), 'ceiling-height'),
    'ceiling exactly at the threshold is clean');
}

// ── 2. Room area ──────────────────────────────────────────────────────────────
{
  _resetIds();
  const small = createProject({ levels: [createLevel({ height: 2.7, rooms: [createRoom(squarePts(2), { name: 'Nook' })] })] }); // 4 m²
  const r = runAdvisoryChecks(small);
  ok(has(r, 'room-area'), 'small room (4 m²) → room-area advisory');
  const f = forCode(r, 'room-area')[0];
  ok(f && f.measured === 4 && f.ref.kind === 'room', 'room-area finding measures 4 m² and refs the room');

  const big = createProject({ levels: [createLevel({ height: 2.7, rooms: [createRoom(squarePts(4), { name: 'Living' })] })] }); // 16 m²
  ok(!has(runAdvisoryChecks(big), 'room-area'), 'full-size room (16 m²) → no room-area advisory');
}

// ── 3. Doors ──────────────────────────────────────────────────────────────────
{
  _resetIds();
  const lvl = createLevel({ height: 2.7 });
  const w = createWall({ x: 0, z: 0 }, { x: 5, z: 0 });
  lvl.walls.push(w);
  lvl.openings.push(createOpening(w.id, 'door', { width: 0.6, height: 2.1 }));  // narrow
  lvl.openings.push(createOpening(w.id, 'door', { width: 0.9, height: 1.8 }));  // short
  const r = runAdvisoryChecks(createProject({ levels: [lvl] }));
  ok(has(r, 'door-width'), 'narrow door (0.6 m) → door-width advisory');
  ok(has(r, 'door-height'), 'short door (1.8 m) → door-height advisory');

  _resetIds();
  const lvl2 = createLevel({ height: 2.7 });
  const w2 = createWall({ x: 0, z: 0 }, { x: 5, z: 0 });
  lvl2.walls.push(w2);
  lvl2.openings.push(createOpening(w2.id, 'door'));  // standard 0.9 × 2.1
  const r2 = runAdvisoryChecks(createProject({ levels: [lvl2] }));
  ok(!has(r2, 'door-width') && !has(r2, 'door-height'), 'standard door → no door advisories');
}

// ── 4. Windows / egress ───────────────────────────────────────────────────────
{
  _resetIds();
  const lvl = createLevel({ height: 2.7 });
  const w = createWall({ x: 0, z: 0 }, { x: 5, z: 0 });
  lvl.walls.push(w);
  lvl.openings.push(createOpening(w.id, 'window', { width: 0.5, height: 0.5, sill: 0.9 }));  // 0.25 m² — too small
  const r = runAdvisoryChecks(createProject({ levels: [lvl] }));
  ok(has(r, 'window-egress-area'), 'tiny window (0.25 m²) → window-egress-area advisory');
  const f = forCode(r, 'window-egress-area')[0];
  ok(f && f.measured === 0.25 && f.unit === 'm2', 'window-egress-area finding measures the opening area');

  _resetIds();
  const lvl2 = createLevel({ height: 2.7 });
  const w2 = createWall({ x: 0, z: 0 }, { x: 5, z: 0 });
  lvl2.walls.push(w2);
  lvl2.openings.push(createOpening(w2.id, 'window', { width: 1.4, height: 1.2, sill: 1.6 }));  // big enough, sill too high
  const r2 = runAdvisoryChecks(createProject({ levels: [lvl2] }));
  ok(!has(r2, 'window-egress-area'), 'big window (1.68 m²) → no egress-area advisory');
  ok(has(r2, 'window-egress-sill'), 'high sill (1.6 m) → window-egress-sill advisory');

  _resetIds();
  const lvl3 = createLevel({ height: 2.7 });
  const w3 = createWall({ x: 0, z: 0 }, { x: 5, z: 0 });
  lvl3.walls.push(w3);
  lvl3.openings.push(createOpening(w3.id, 'window'));  // default 1.4 × 1.2, sill 0.9 — all fine
  const r3 = runAdvisoryChecks(createProject({ levels: [lvl3] }));
  ok(!has(r3, 'window-egress-area') && !has(r3, 'window-egress-sill'), 'standard window → no egress advisories');
}

// ── 5. Storey habitability (natural light / access) ───────────────────────────
{
  _resetIds();
  // a storey WITH a room but NO openings at all
  const lvl = createLevel({ height: 2.7, rooms: [createRoom(squarePts(4))] });
  const r = runAdvisoryChecks(createProject({ levels: [lvl] }));
  ok(has(r, 'storey-natural-light'), 'rooms but no windows → storey-natural-light advisory');
  ok(has(r, 'storey-access'), 'rooms but no doors → storey-access advisory');

  _resetIds();
  // a storey with NO rooms yet is not nagged
  const empty = createProject({ levels: [createLevel({ height: 2.7 })] });
  const re = runAdvisoryChecks(empty);
  ok(!has(re, 'storey-natural-light') && !has(re, 'storey-access'), 'room-less storey → no habitability advisories');

  _resetIds();
  // a storey with a room + a door + a window is clean on habitability
  const good = createLevel({ height: 2.7, rooms: [createRoom(squarePts(4))] });
  const gw = createWall({ x: 0, z: 0 }, { x: 5, z: 0 });
  good.walls.push(gw);
  good.openings.push(createOpening(gw.id, 'door'));
  good.openings.push(createOpening(gw.id, 'window'));
  const rg = runAdvisoryChecks(createProject({ levels: [good] }));
  ok(!has(rg, 'storey-natural-light') && !has(rg, 'storey-access'), 'room + door + window storey → clean on habitability');
}

// ── 6. Overridable thresholds ─────────────────────────────────────────────────
{
  _resetIds();
  const p = createProject({ levels: [createLevel({ height: 2.5 })] });
  ok(!has(runAdvisoryChecks(p), 'ceiling-height'), '2.5 m ceiling clean under default 2.3 m');
  ok(has(runAdvisoryChecks(p, { thresholds: { minCeilingHeight: 2.6 } }), 'ceiling-height'),
    'raising minCeilingHeight to 2.6 m flags the 2.5 m ceiling');
  const rr = runAdvisoryChecks(p, { thresholds: { minCeilingHeight: 2.6 } });
  ok(rr.thresholds.minCeilingHeight === 2.6, 'result echoes the effective (merged) thresholds');
  ok(rr.thresholds.minRoomArea === DEFAULT_THRESHOLDS.minRoomArea, 'unspecified thresholds keep their defaults');
}

// ── 7. Summary + counts + disclaimer ──────────────────────────────────────────
{
  _resetIds();
  const clean = createProject({ levels: [createLevel({ height: 2.7 })] });
  const rc = runAdvisoryChecks(clean);
  ok(rc.counts.total === 0 && rc.counts.advisory === 0, 'empty-but-valid storey → zero findings');
  ok(advisorySummary(rc) === 'No advisories', 'summary of a clean project reads "No advisories"');
  ok(rc.disclaimer === ADVISORY_DISCLAIMER && /advisory/i.test(rc.disclaimer), 'result carries the advisory disclaimer');

  _resetIds();
  const low = createProject({ levels: [createLevel({ name: 'Ground', height: 2.0, rooms: [createRoom(squarePts(2))] })] });
  const rl = runAdvisoryChecks(low);
  ok(rl.counts.advisory >= 2, 'a bad storey accrues multiple advisories');
  ok(rl.counts.total === rl.findings.length, 'counts.total matches the findings length');
  ok(advisorySummary(rl) === `${rl.counts.advisory} advisories`, 'summary pluralises the advisory count');
  ok(advisorySummary(runAdvisoryChecks(createProject({ levels: [createLevel({ height: 2.0 })] }))) === '1 advisory',
    'a single advisory is singular in the summary');
  ok(Object.values(rl.byCode).reduce((s, n) => s + n, 0) === rl.findings.length, 'byCode tallies to the total');
}

// ── 8. Multi-level model order is deterministic ───────────────────────────────
{
  _resetIds();
  const l1 = createLevel({ name: 'Ground', height: 2.0 });   // low ceiling
  const l2 = createLevel({ name: 'Upper', height: 2.1 });    // low ceiling
  const r = runAdvisoryChecks(createProject({ levels: [l1, l2] }));
  const ceil = forCode(r, 'ceiling-height');
  ok(ceil.length === 2, 'both low storeys flag');
  ok(ceil[0].ref.where === 'Ground' && ceil[1].ref.where === 'Upper', 'findings follow model (level) order');
}

// ── 9. Individual check functions are independently callable ──────────────────
{
  _resetIds();
  const t = DEFAULT_THRESHOLDS;
  const low = createProject({ levels: [createLevel({ height: 2.0 })] });
  ok(checkCeilingHeights(low, t).length === 1, 'checkCeilingHeights callable standalone');
  ok(checkRoomAreas(createProject({ levels: [createLevel({ rooms: [createRoom(squarePts(2))] })] }), t).length === 1, 'checkRoomAreas callable standalone');
  const lvl = createLevel({});
  const w = createWall({ x: 0, z: 0 }, { x: 5, z: 0 }); lvl.walls.push(w);
  lvl.openings.push(createOpening(w.id, 'door', { width: 0.5 }));
  ok(checkOpenings(createProject({ levels: [lvl] }), t).length >= 1, 'checkOpenings callable standalone');
  ok(checkStoreyHabitability(createProject({ levels: [createLevel({ rooms: [createRoom(squarePts(4))] })] })).length === 2, 'checkStoreyHabitability callable standalone');
}

// ── 10. Malformed / partial / empty input never throws ────────────────────────
{
  const bad = [undefined, null, {}, { levels: null }, { levels: [null, {}] },
    { levels: [{ height: 2.0, rooms: [null, { points: [] }, { points: [{ x: 0, z: 0 }] }], openings: [null, {}] }] }];
  let threw = false;
  for (const b of bad) { try { const r = runAdvisoryChecks(b); if (!Array.isArray(r.findings)) threw = true; } catch { threw = true; } }
  ok(!threw, 'malformed/partial/empty projects never throw and always return findings[]');
  // a degenerate (zero-area) room does not produce a room-area finding (0 is not "small")
  const degen = runAdvisoryChecks({ levels: [{ id: 'l', height: 2.7, rooms: [{ id: 'r', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }] }], openings: [] }] });
  ok(!has(degen, 'room-area'), 'a zero-area (collinear) room is not flagged as small');
}

// ── 11. Purity: checks mutate nothing and add no save field ───────────────────
{
  _resetIds();
  const p = createProject({
    name: 'Sample', levels: [(() => {
      const lvl = createLevel({ name: 'Ground', height: 2.0, rooms: [createRoom(squarePts(2), { name: 'Nook' })] });
      const w = createWall({ x: 0, z: 0 }, { x: 5, z: 0 }); lvl.walls.push(w);
      lvl.openings.push(createOpening(w.id, 'door', { width: 0.6 }));
      lvl.openings.push(createOpening(w.id, 'window', { width: 0.5, height: 0.5 }));
      lvl.roof = createRoof({ type: 'gable' });
      return lvl;
    })()],
  });
  const before = serialize(p);
  const r = runAdvisoryChecks(p);
  ok(r.findings.length > 0, 'the sample project surfaces advisories (engine actually ran)');
  const after = serialize(p);
  ok(before === after, 'runAdvisoryChecks mutates NOTHING — project serializes byte-identically');
  const rt = serialize(deserialize(after));
  ok(rt === before, 'serialize→deserialize→serialize stays byte-identical (lossless preserved)');
  ok(!/advisor|finding|codeCheck/i.test(after), 'no advisory field leaks into the saved project');
}

// ── 12. Wall length helper import sanity (guards the model dependency) ─────────
{
  // (advisoryChecks imports wallLength/polygonArea from model.js; a quick sanity that
  //  those are the same pure helpers keeps the dependency honest.)
  ok(typeof wallLength === 'function', 'wallLength is importable from the model (dependency intact)');
}

// ── 13. Natural light — glazing-to-floor-area ratio (E) ───────────────────────
{
  // helper: a level with a room of `side` m and one window of w×h on a wall.
  const glazedLevel = (side, w, h) => {
    const lvl = createLevel({ height: 2.7, rooms: [createRoom(squarePts(side))] });
    const wall = createWall({ x: 0, z: 0 }, { x: 5, z: 0 });
    lvl.walls.push(wall);
    lvl.openings.push(createOpening(wall.id, 'window', { width: w, height: h }));
    return lvl;
  };

  _resetIds();
  // 36 m² floor, a single standard 1.68 m² window → 4.7%, under the 8% rule of thumb.
  // Window is big-enough / low-silled, so ONLY the glazing-ratio check should fire here.
  const under = runAdvisoryChecks(createProject({ levels: [glazedLevel(6, 1.4, 1.2)] }));
  ok(has(under, 'storey-glazing-ratio'), 'windowed storey below 8% glazing → storey-glazing-ratio advisory');
  ok(!has(under, 'window-egress-area') && !has(under, 'window-egress-sill'), 'the glazing case is isolated (no egress advisories on a standard window)');
  ok(!has(under, 'storey-natural-light'), 'a storey WITH windows does not also trip the no-windows advisory');
  const gf = forCode(under, 'storey-glazing-ratio')[0];
  ok(gf && gf.measured === 1.68 && gf.threshold === 2.88 && gf.unit === 'm2',
    'glazing finding carries measured glazing (1.68) + required area (8% of 36 = 2.88)');
  ok(gf && gf.ref && gf.ref.kind === 'level' && gf.severity === 'advisory', 'glazing finding refs the storey, severity advisory');

  _resetIds();
  // 16 m² floor, same 1.68 m² window → 10.5%, comfortably over 8% → clean.
  const okLight = runAdvisoryChecks(createProject({ levels: [glazedLevel(4, 1.4, 1.2)] }));
  ok(!has(okLight, 'storey-glazing-ratio'), 'adequate glazing (>8% of floor) → no glazing advisory');

  _resetIds();
  // exactly at the ratio is NOT flagged (16 m² × 8% = 1.28 m² = a 1.6×0.8 window).
  const exact = runAdvisoryChecks(createProject({ levels: [glazedLevel(4, 1.6, 0.8)] }));
  ok(!has(exact, 'storey-glazing-ratio'), 'glazing exactly at the 8% ratio is clean');

  _resetIds();
  // no windows at all → storey-natural-light owns it; glazing-ratio must stay silent (no overlap).
  const noWin = runAdvisoryChecks(createProject({ levels: [createLevel({ height: 2.7, rooms: [createRoom(squarePts(4))] })] }));
  ok(has(noWin, 'storey-natural-light') && !has(noWin, 'storey-glazing-ratio'),
    'no windows → storey-natural-light, never storey-glazing-ratio (checks do not overlap)');

  _resetIds();
  // a room-less storey with a window has no floor to light → no glazing finding, never throws.
  const roomless = createLevel({ height: 2.7 });
  const rw = createWall({ x: 0, z: 0 }, { x: 5, z: 0 }); roomless.walls.push(rw);
  roomless.openings.push(createOpening(rw.id, 'window', { width: 0.4, height: 0.4 }));
  ok(!has(runAdvisoryChecks(createProject({ levels: [roomless] })), 'storey-glazing-ratio'),
    'a window with no enclosed floor → no glazing advisory');

  _resetIds();
  // threshold overridable: a 10.5% storey is clean by default but flags under a stricter 15%.
  const p = createProject({ levels: [glazedLevel(4, 1.4, 1.2)] });
  ok(!has(runAdvisoryChecks(p), 'storey-glazing-ratio'), '10.5% glazing clean under the default 8%');
  ok(has(runAdvisoryChecks(p, { thresholds: { minGlazingRatio: 0.15 } }), 'storey-glazing-ratio'),
    'raising minGlazingRatio to 15% flags the 10.5% storey');

  _resetIds();
  // standalone-callable, like the other check functions.
  ok(checkNaturalLight(createProject({ levels: [glazedLevel(6, 1.4, 1.2)] }), DEFAULT_THRESHOLDS).length === 1,
    'checkNaturalLight callable standalone');

  // default threshold is present and sane.
  ok(DEFAULT_THRESHOLDS.minGlazingRatio === 0.08, 'default minGlazingRatio is 8%');
}

// ── 14. Room proportions — narrow-but-large "sliver" rooms (B2) ───────────────
{
  // a rect room `w` × `d` (m) on one level; area = w*d, min width = min(w,d).
  const rectRoom = (w, d, name) => {
    const pts = [{ x: 0, z: 0 }, { x: w, z: 0 }, { x: w, z: d }, { x: 0, z: d }];
    return createLevel({ height: 2.7, rooms: [createRoom(pts, { name })] });
  };

  _resetIds();
  // 1.4 m × 9 m = 12.6 m² — big enough to READ habitable (area check stays silent), but only
  // 1.4 m across, under the 2.1 m least width → room-width fires, and ONLY room-width.
  const slim = runAdvisoryChecks(createProject({ levels: [rectRoom(1.4, 9, 'Sun corridor')] }));
  ok(has(slim, 'room-width'), 'a large-area but 1.4 m-narrow room → room-width advisory');
  ok(!has(slim, 'room-area'), 'the sliver is NOT also flagged small (area 12.6 m² ≥ 6.5)');
  const rw = forCode(slim, 'room-width')[0];
  ok(rw && rw.measured === 1.4 && rw.threshold === 2.1 && rw.unit === 'm', 'room-width finding carries measured width (1.4) + threshold (2.1)');
  ok(rw && rw.ref && rw.ref.kind === 'room' && rw.severity === 'advisory', 'room-width refs the room, severity advisory');
  ok(rw && /Sun corridor/.test(rw.message), 'the message names the room');

  _resetIds();
  // a comfortable 4 m × 4 m room (16 m², 4 m wide) is clean on both area and width.
  const roomy = runAdvisoryChecks(createProject({ levels: [rectRoom(4, 4, 'Living')] }));
  ok(!has(roomy, 'room-width') && !has(roomy, 'room-area'), 'a 4×4 m room trips neither area nor width');

  _resetIds();
  // a small closet (1.2 m × 1.2 m = 1.44 m², under minRoomArea) is the AREA check's business,
  // never double-flagged for being narrow — room-width must stay silent below minRoomArea.
  const closet = runAdvisoryChecks(createProject({ levels: [rectRoom(1.2, 1.2, 'Closet')] }));
  ok(has(closet, 'room-area') && !has(closet, 'room-width'), 'a small closet flags area only, not width (no double-flag)');

  _resetIds();
  // exactly at the 2.1 m width is NOT flagged (2.1 m × 4 m = 8.4 m²).
  const exact = runAdvisoryChecks(createProject({ levels: [rectRoom(2.1, 4, 'Galley')] }));
  ok(!has(exact, 'room-width'), 'a room exactly at the 2.1 m least width is clean');

  _resetIds();
  // threshold overridable: the 2.1 m-wide galley is clean by default but flags under a 2.4 m rule.
  const galley = createProject({ levels: [rectRoom(2.1, 4, 'Galley')] });
  ok(!has(runAdvisoryChecks(galley), 'room-width'), '2.1 m galley clean under the default 2.1 m');
  ok(has(runAdvisoryChecks(galley, { thresholds: { minRoomWidth: 2.4 } }), 'room-width'),
    'raising minRoomWidth to 2.4 m flags the 2.1 m galley');

  _resetIds();
  // standalone-callable, like the other check functions; and never throws on junk input.
  ok(checkRoomProportions(createProject({ levels: [rectRoom(1.4, 9, 'X')] }), DEFAULT_THRESHOLDS).length === 1,
    'checkRoomProportions callable standalone');
  let threw = false;
  for (const b of [undefined, null, {}, { levels: [null, { rooms: [null, { points: [{ x: 0, z: 0 }] }] }] }]) {
    try { if (!Array.isArray(checkRoomProportions(b, DEFAULT_THRESHOLDS))) threw = true; } catch { threw = true; }
  }
  ok(!threw, 'checkRoomProportions never throws on malformed/partial input');

  ok(DEFAULT_THRESHOLDS.minRoomWidth === 2.1, 'default minRoomWidth is 2.1 m');
}

// ── summary ───────────────────────────────────────────────────────────────────
if (fail === 0) console.log(`\nALL PASS — ${pass} passed, 0 failed`);
else { console.log(`\nFAILED — ${pass} passed, ${fail} failed`); for (const f of fails) console.log('  · ' + f); process.exit(1); }
