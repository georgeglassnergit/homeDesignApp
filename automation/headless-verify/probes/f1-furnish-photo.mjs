// F1 slice probe — the `furnish-photo-3d` view-layer UI (the Phase-4 flagship).
//
// Drives the REAL furnish wiring in the booted app via window.__furnish*, which runs the pure
// controller (submit→poll→verify→commit) with a SYNTHETIC transport (a canned SUCCEEDED job
// pointing at the real /sample.glb) but the REAL strict GLB verifier and the REAL syncFurniture.
// So this proves the whole wire end-to-end in a real browser: a "photo" furnish commits an
// UNDOABLE furniture record AND loads its GLB into the 3D scene; undo removes it from both the
// model and the scene (and the save stays byte-identical); redo restores both; and a FAILED job
// commits nothing (no phantom record) while surfacing a novice-friendly message. The furnished
// object is left in the scene for the screenshot.
export async function run(page) {
  const seam = await page.evaluate(() => ({
    visible: window.__furnishSeamVisible(),
    scene0: window.__furnishSceneCount(),
    model0: window.__project().furniture.length,
    undo0: window.__history.undoStack.length,
    lossless0: window.__selftest().lossless,
  }));

  // 1) a successful furnish from a photo
  const furnish = await page.evaluate(() => window.__furnish());
  // 2) undo it — model + scene must both drop the object, save byte-identical
  const undo = await page.evaluate(() => window.__furnishUndo());
  // 3) redo it — model + scene must both restore the object
  const redo = await page.evaluate(() => window.__furnishRedo());
  // 4) a failed job must commit nothing and show a friendly message
  const failed = await page.evaluate(() => window.__furnish({ fail: true }));

  // leave one furnished object in the scene for the screenshot, framed from orbit
  await page.evaluate(() => { window.__furnish(); });
  await page.waitForTimeout(400);
  const end = await page.evaluate(() => ({ scene: window.__furnishSceneCount(), model: window.__project().furniture.length, lossless: window.__selftest().lossless }));

  return {
    log: { seam, furnish, undo, redo, failed, end },
    checks: [
      ['F1: furnish seam visible (Simple-tier)', seam.visible === true],
      ['F1: boot scene already renders the sample furniture GLB', seam.scene0 >= 1],
      ['F1: a photo furnish commits (controller resolved)', furnish.committed === true],
      ['F1: commit adds exactly one furniture record', furnish.modelFurnitureDelta === 1],
      ['F1: committed record carries the generated GLB src', furnish.src === '/sample.glb'],
      ['F1: the GLB actually loaded into the 3D scene', furnish.sceneFurniture === seam.scene0 + 1],
      ['F1: the commit is a single undoable step', furnish.undoDelta === 1],
      ['F1: save stays lossless after the commit', furnish.lossless === true],
      ['F1: undo drops the record from the model', undo.modelFurniture === seam.model0],
      ['F1: undo drops the GLB from the scene', undo.sceneFurniture === seam.scene0],
      ['F1: undo restores a byte-identical save', undo.lossless === true],
      ['F1: redo restores the record to the model', redo.modelFurniture === seam.model0 + 1],
      ['F1: redo restores the GLB to the scene', redo.sceneFurniture === seam.scene0 + 1],
      ['F1: a failed job commits NO record (no phantom)', failed.committed === false && failed.modelFurnitureDelta === 0],
      ['F1: a failed job surfaces a friendly message', typeof failed.msg === 'string' && failed.msg.length > 0 && !!failed.error],
      ['F1: scene furniture count never drifts from the model', end.scene === end.model],
      ['F1: save still lossless at the end', end.lossless === true],
    ],
  };
}
