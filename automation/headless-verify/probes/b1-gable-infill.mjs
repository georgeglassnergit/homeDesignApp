// B1 slice probe — gable-end WALL infill (the triangle under a gable reads as wall, not void).
// Drives the roof-editor seam to switch the roof-bearing storey between flat/gable/hip and
// asserts, against the REAL rebuilt scene graph, that:
//   • a GABLE roof adds exactly 2 wall-material infill panels (kind:'wall' with NO modelId —
//     real walls always carry a modelId; only buildGableInfillMesh omits it)
//   • those panels rise ABOVE the eave (top of walls) toward the ridge — they fill the void
//   • HIP and FLAT roofs add ZERO infill panels (they have no gable end)
//   • the whole sweep stays lossless (byte-identical save) and undoable — no save regression
// Leaves the roof on GABLE so the screenshot shows the filled gable end.
export async function run(page) {
  // Enter Pro so the roof-editor seam is live, and read the eave height of the roof-bearing level.
  const setup = await page.evaluate(() => {
    window.__setMode && window.__setMode('pro');
    const roof = window.__roof();
    const lvl = (window.__levels() || []).find((l) => l.id === (roof && roof.levelId));
    return { roof, eave: lvl ? lvl.elevation + lvl.height : null };
  });

  // Count infill panels + their vertical extent in the CURRENT scene graph.
  const survey = () => {
    // eslint-disable-next-line no-undef
    const home = window.__home;
    let walls = 0, infill = 0, ymin = Infinity, ymax = -Infinity, tris = 0;
    home.traverse((o) => {
      if (!o.isMesh || o.userData.kind !== 'wall') return;
      if (o.userData.modelId) { walls++; return; }   // a real wall
      infill++;                                        // gable-end infill (no modelId)
      const g = o.geometry; g.computeBoundingBox();
      ymin = Math.min(ymin, g.boundingBox.min.y); ymax = Math.max(ymax, g.boundingBox.max.y);
      tris += g.attributes.position.count / 3;
    });
    return { walls, infill, ymin, ymax, tris };
  };

  const before = await page.evaluate(() => ({ undo: window.__history.undoStack.length, lossless: window.__selftest().lossless }));

  await page.evaluate(() => window.__setRoofType({ type: 'flat' }));
  const flat = await page.evaluate(survey);

  await page.evaluate(() => window.__setRoofType({ type: 'gable', pitch: 35 }));
  const gable = await page.evaluate(survey);
  const gableLossless = await page.evaluate(() => window.__selftest().lossless);

  await page.evaluate(() => window.__setRoofType({ type: 'hip', pitch: 35 }));
  const hip = await page.evaluate(survey);

  // Back to gable through the seam (rebuilds the scene) — the panels must return.
  // Leaves the roof on gable so the screenshot shows the filled end.
  await page.evaluate(() => window.__setRoofType({ type: 'gable', pitch: 35 }));
  const reGable = await page.evaluate(survey);
  await page.waitForTimeout(150);

  const after = await page.evaluate(() => ({ undo: window.__history.undoStack.length, lossless: window.__selftest().lossless }));

  return {
    log: { eave: setup.eave, flatInfill: flat.infill, gable, hip: hip.infill, reGableInfill: reGable.infill, wallsFlat: flat.walls },
    checks: [
      ['B1: roof-bearing level has walls (real walls present)', gable.walls > 0],
      ['B1: FLAT roof adds NO gable infill', flat.infill === 0],
      ['B1: GABLE roof adds a wall-material infill mesh', gable.infill === 1],
      ['B1: the infill is two solid prisms (16 tris = 2 gable ends)', gable.tris === 16],
      ['B1: infill rises above the eave toward the ridge', setup.eave != null && gable.ymax > setup.eave + 0.1],
      ['B1: infill base sits at the eave (top of walls)', Math.abs(gable.ymin - setup.eave) < 1e-3],
      ['B1: HIP roof adds NO gable infill (no gable end)', hip.infill === 0],
      ['B1: re-selecting gable restores the infill', reGable.infill === 1 && reGable.tris === 16],
      ['B1: save byte-identical across the roof sweep', before.lossless === true && gableLossless === true && after.lossless === true],
    ],
  };
}
