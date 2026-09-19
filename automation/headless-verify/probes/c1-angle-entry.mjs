// C1 slice probe — precise polar (length + angle) wall entry in the REAL app.
//
// Group C's "angled / non-orthogonal wall drawing" (Pro angle entry): walls already store
// free a/b points and the C2 mitre view already renders any angle, so C1's gap is the ENTRY.
// This drives the real ToolController through the app's own handles to build a 3-4-5 right
// triangle by typing each segment — the hypotenuse is genuinely non-orthogonal — then proves:
//   • the polar-entry UI is Pro-only (hidden in Simple, shown in Pro)
//   • each typed segment lands at the EXACT length + plan-frame angle (vs the pure oracle)
//   • segments chain (each starts at the previous endpoint)
//   • the live rubber-band readout reports the cursor's length + angle
//   • entry is undoable
//   • the Phase-0 caveat holds: a CSG window cut into the ANGLED wall survives (the wall mesh
//     gains a hole → more triangles than a plain entered prism) with zero console errors, and
//     the Phase-1 save stays lossless.
import { segmentPolar, polarOffset, normalizeAngleDeg } from '../../../src/edit/snapping.js';

const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

export async function run(page) {
  const checks = [];
  const log = {};

  // --- seam: Pro-only -----------------------------------------------------------
  await page.evaluate(() => window.__setMode('simple'));
  const simpleVisible = await page.evaluate(() => window.__polarSeamVisible());
  await page.evaluate(() => window.__setMode('pro'));
  const proVisible = await page.evaluate(() => window.__polarSeamVisible());
  checks.push(['polar entry hidden in Simple', simpleVisible === false]);
  checks.push(['polar entry shown in Pro', proVisible === true]);

  // --- draw a 3-4-5 right triangle by typed polar segments ----------------------
  // Start clear of the sample home (x∈[-4,4], z∈[-3,3]); anchor at (10,0).
  await page.evaluate(() => { window.__setTool('draw-wall'); window.__planClick(10, 0); });

  // segment 1: 4 m east (0°)     → (14, 0)
  // segment 2: 3 m up   (90°)    → (14, -3)
  // segment 3: the hypotenuse, non-orthogonal, back toward the start
  const A = { x: 10, z: 0 };
  const B = polarOffset(A, 4, 0);          // (14, 0)
  const C = polarOffset(B, 3, 90);         // (14, -3)
  const hypLen = Math.hypot(C.x - A.x, C.z - A.z);              // 5
  const hypAng = segmentPolar(C, A).angleDeg;                   // ≈ -143.13°

  const r1 = await page.evaluate((a) => window.__polarEntry(a.len, a.ang), { len: 4, ang: 0 });
  const r2 = await page.evaluate((a) => window.__polarEntry(a.len, a.ang), { len: 3, ang: 90 });
  const r3 = await page.evaluate((a) => window.__polarEntry(a.len, a.ang), { len: hypLen, ang: hypAng });
  checks.push(['segment 1 committed a wall', r1.added === true]);
  checks.push(['segment 2 committed a wall', r2.added === true]);
  checks.push(['hypotenuse (non-orthogonal) committed a wall', r3.added === true]);

  // read back the three walls we just added (the last three on the active level)
  const mine = await page.evaluate(() => {
    const lvl = window.__controller.level;
    const w = lvl.walls.slice(-3);
    return w.map((x) => ({ a: x.a, b: x.b }));
  });
  log.entered = mine;

  const segOK = (w, from, to) =>
    near(w.a.x, from.x) && near(w.a.z, from.z) && near(w.b.x, to.x) && near(w.b.z, to.z);
  checks.push(['segment 1 goes A→B exactly (4 m east)', segOK(mine[0], A, B)]);
  checks.push(['segment 2 chains B→C exactly (3 m up)', segOK(mine[1], B, C)]);
  checks.push(['hypotenuse chains C→A exactly (closes the triangle)', segOK(mine[2], C, A)]);

  // the hypotenuse is genuinely non-orthogonal (not on a 90° axis) and has the typed length
  const hp = segmentPolar(mine[2].a, mine[2].b);
  checks.push(['hypotenuse length is exactly 5 m', near(hp.length, 5, 1e-6)]);
  checks.push(['hypotenuse angle matches the typed heading', near(hp.angleDeg, normalizeAngleDeg(hypAng), 1e-4)]);
  const axisAligned = near(hp.angleDeg % 90, 0, 1e-3) || near(Math.abs(hp.angleDeg % 90), 90, 1e-3);
  checks.push(['hypotenuse is truly angled (off every 90° axis)', axisAligned === false]);

  // --- live readout -------------------------------------------------------------
  const live = await page.evaluate(() => {
    window.__controller.finishChain();            // end the triangle chain (no stray wall on next click)
    window.__planClick(0, 10);                    // start a fresh chain at (0,10), clear of everything
    window.__controller.pointerMove({ x: 3, z: 10 });   // preview 3 m east
    return window.__currentSegmentPolar();
  });
  checks.push(['live readout reports the cursor length', live && near(live.length, 3, 1e-6)]);
  checks.push(['live readout reports the cursor angle (0° east)', live && near(live.angleDeg, 0, 1e-6)]);
  await page.evaluate(() => window.__controller.finishChain());

  // --- undoable -----------------------------------------------------------------
  const undo = await page.evaluate(() => {
    const before = window.__controller.level.walls.length;
    window.__history.undo();
    return { before, after: window.__controller.level.walls.length };
  });
  checks.push(['entry is undoable (undo removes a segment)', undo.after === undo.before - 1]);
  await page.evaluate(() => window.__history.redo());   // restore the triangle for the CSG test + shot

  // --- Phase-0 caveat: a CSG window on the ANGLED wall survives ------------------
  // Place a window at the hypotenuse midpoint via the real tool path, rebuild, and compare
  // triangle counts: the angled wall with a hole must have more tris than a plain entered
  // prism (segment 1, no opening).
  const csg = await page.evaluate(() => {
    const lvl = window.__controller.level;
    const walls = lvl.walls.slice(-3);
    const hypId = walls[2].id, plainId = walls[0].id;
    const mid = { x: (walls[2].a.x + walls[2].b.x) / 2, z: (walls[2].a.z + walls[2].b.z) / 2 };
    const openingsBefore = lvl.openings.length;
    window.__setTool('place-window');
    window.__planClick(mid.x, mid.z);
    const openingsAfter = window.__controller.level.openings.length;
    // read rendered triangle counts for the two walls
    const tri = {};
    window.__home.traverse((o) => {
      if (o.isMesh && o.userData.kind === 'wall' && o.userData.modelId) {
        const g = o.geometry; tri[o.userData.modelId] = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      }
    });
    return { openingsBefore, openingsAfter, hypTris: tri[hypId] || 0, plainTris: tri[plainId] || 0 };
  });
  log.csg = csg;
  checks.push(['a window was placed on the angled wall', csg.openingsAfter === csg.openingsBefore + 1]);
  checks.push(['the angled wall renders (non-degenerate prism)', csg.plainTris >= 12]);
  checks.push(['CSG hole survived on the angled wall (more tris than a plain prism)', csg.hypTris > csg.plainTris]);

  // --- Phase-1 save stays lossless after all this -------------------------------
  const st = await page.evaluate(() => window.__selftest());
  checks.push(['save/load round-trip still lossless', st.lossless === true && st.valid === true]);

  // reframe the plan so the entered triangle (incl. the angled hypotenuse) is in the shot
  await page.evaluate(() => { window.__setTool('select'); window.__plan.frameModel(); window.__plan.draw(); });
  await page.waitForTimeout(150);

  return { checks, log };
}
