// E1 slice probe — materials library / swatch (Simple-tier `materials-swatch` seam).
// Boots the REAL app and drives the finish palette end-to-end through the actual seam:
// selecting a wall exposes a materials swatch slot (in BOTH tiers, since materials-swatch is a
// Simple row); applying a library finish via __setMaterial repoints the wall's material key AND
// registers the finish in project.materials so the render registry can resolve it; undo restores
// the prior key, removes the added preset, and leaves the save valid + byte-lossless. A floor
// (room) takes a finish through the same seam. Leaves a red-brick wall visible for the screenshot.
export async function run(page) {
  // --- pick a real wall + room from the booted sample home ---
  const ids = await page.evaluate(() => {
    const lvl = window.__project().levels[0];
    return {
      walls: (lvl.walls || []).length,
      rooms: (lvl.rooms || []).length,
      wallId: (lvl.walls || [])[0]?.id || null,
      wallMat: (lvl.walls || [])[0]?.material || null,
      roomId: (lvl.rooms || [])[0]?.id || null,
    };
  });

  // --- the swatch slot appears in BOTH Simple and Pro (materials-swatch is a Simple-tier seam) ---
  const slots = await page.evaluate((wallId) => {
    window.__setMode('simple');
    window.__select({ kind: 'wall', id: wallId });
    const s = window.__inspect();
    window.__setMode('pro');
    window.__select({ kind: 'wall', id: wallId });
    const p = window.__inspect();
    return {
      simpleHas: !!(s && s.materials && s.materials.key === 'material'),
      simpleCurrent: s?.materials?.current,
      simpleOptions: s?.materials?.options?.length || 0,
      proHas: !!(p && p.materials),
      // the swatch row must be present in the rendered DOM too, not just the descriptor
      swatchButtons: document.querySelectorAll('#inspector .ins-swatch').length,
    };
  }, ids.wallId);

  // --- apply a library finish to the wall: model repoints + finish registered in project.materials ---
  const before = await page.evaluate(() => ({ undo: window.__history.undoStack.length, self: window.__selftest() }));
  const applied = await page.evaluate((wallId) => {
    const res = window.__setMaterial('red-brick');
    const w = window.__project().levels[0].walls.find((x) => x.id === wallId);
    return {
      stored: w.material,
      registered: !!window.__project().materials['red-brick'],
      resReg: res.registered,
      undo: window.__history.undoStack.length,
      selCount: document.querySelectorAll('#inspector .ins-swatch.sel').length,
    };
  }, ids.wallId);

  // --- undo: prior key restored, the added preset removed, save valid + byte-lossless ---
  const undone = await page.evaluate((wallMat) => {
    window.__history.undo();
    const w = window.__project().levels[0].walls[0];
    return {
      restored: w.material === wallMat,
      keyRemoved: !('red-brick' in window.__project().materials),
      self: window.__selftest(),
    };
  }, ids.wallMat);

  // --- a floor (room) takes a finish through the same seam ---
  const floor = await page.evaluate((roomId) => {
    window.__select({ kind: 'room', id: roomId });
    window.__setMaterial('oak');
    const r = window.__project().levels[0].rooms.find((x) => x.id === roomId);
    return { stored: r.material, registered: !!window.__project().materials['oak'], self: window.__selftest() };
  }, ids.roomId);

  // --- re-apply a vivid finish to the wall + leave it selected/visible for the screenshot ---
  await page.evaluate((wallId) => {
    window.__select({ kind: 'wall', id: wallId });
    window.__setMaterial('red-brick');
    window.__setExterior && window.__setExterior();
  }, ids.wallId);
  await page.waitForTimeout(150);

  return {
    log: {
      walls: ids.walls, rooms: ids.rooms, wallDefault: ids.wallMat,
      simpleOptions: slots.simpleOptions, swatchButtons: slots.swatchButtons,
      applied: applied.stored, floor: floor.stored,
    },
    checks: [
      ['E1: app booted with walls + rooms', ids.walls > 0 && ids.rooms > 0],
      ['E1: a wall carries a materials swatch slot in Simple', slots.simpleHas],
      ['E1: the swatch slot lists the finish library', slots.simpleOptions >= 10],
      ['E1: the swatch row renders in the DOM', slots.swatchButtons >= 10],
      ['E1: the slot is available in Pro too', slots.proHas],
      ['E1: applying a finish repoints the wall material', applied.stored === 'red-brick'],
      ['E1: the finish is registered in project.materials on first use', applied.registered && applied.resReg],
      ['E1: exactly one swatch reads as selected', applied.selCount === 1],
      ['E1: applying a finish is one undoable command', applied.undo === before.undo + 1],
      ['E1: undo restores the prior material key', undone.restored],
      ['E1: undo removes the added preset (no orphan key)', undone.keyRemoved],
      ['E1: save valid + byte-lossless after undo', undone.self.valid === true && undone.self.lossless === true],
      ['E1: a floor takes a finish through the same seam', floor.stored === 'oak' && floor.registered],
      ['E1: save valid + lossless after a floor finish', floor.self.valid === true && floor.self.lossless === true],
      ['E1: Phase-1 regression intact (save valid + lossless)', before.self.valid === true && before.self.lossless === true],
    ],
  };
}
