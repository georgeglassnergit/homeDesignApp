// A3 slice probe — label a wall/opening from the inspector (Pro element-label seam).
// Boots the REAL app, selects a real wall/opening from the sample home, and proves the seam
// end-to-end through the actual DOM: Simple shows no label field (clean card); Pro exposes an
// editable label slot; committing __labelElement writes the model's OPTIONAL `label`, the
// inspector title follows, undo removes the key and the save stays valid — i.e. the Phase 1
// lossless contract holds. Leaves a labelled wall in the inspector for the screenshot.
export async function run(page) {
  // --- pick a real wall + opening from the booted sample home ---
  const ids = await page.evaluate(() => {
    const lvl = window.__project().levels[0];
    return {
      walls: (lvl.walls || []).length,
      openings: (lvl.openings || []).length,
      wallId: (lvl.walls || [])[0]?.id || null,
      openId: (lvl.openings || [])[0]?.id || null,
    };
  });

  // --- Simple: selecting a wall shows NO label field (novice keeps a clean read-only card) ---
  const simple = await page.evaluate((wallId) => {
    window.__setMode('simple');
    window.__select({ kind: 'wall', id: wallId });
    const d = window.__inspect();
    return { rename: d ? d.rename : 'no-desc', title: d ? d.title : null };
  }, ids.wallId);

  // --- Pro: the same selection now carries an editable label slot keyed to `label` ---
  const pro = await page.evaluate((wallId) => {
    window.__setMode('pro');
    window.__select({ kind: 'wall', id: wallId });
    const d = window.__inspect();
    return { key: d.rename?.key || null, value: d.rename?.value, placeholder: d.rename?.placeholder || '', title: d.title };
  }, ids.wallId);

  // --- commit a wall label; the model updates + the inspector title follows ---
  const before = await page.evaluate(() => ({ undo: window.__history.undoStack.length, self: window.__selftest() }));
  const labelled = await page.evaluate((wallId) => {
    const res = window.__labelElement('Party wall');
    const w = window.__project().levels[0].walls.find((x) => x.id === wallId);
    return { title: res.title, stored: w.label ?? null, undo: window.__history.undoStack.length, insText: window.__inspectorText() };
  }, ids.wallId);

  // --- undo removes the OPTIONAL key entirely; the save stays valid + lossless ---
  const undone = await page.evaluate((wallId) => {
    window.__history.undo();
    const w = window.__project().levels[0].walls.find((x) => x.id === wallId);
    return { hasKey: Object.prototype.hasOwnProperty.call(w, 'label'), self: window.__selftest() };
  }, ids.wallId);

  // --- an opening labels through the same seam (title becomes the label) ---
  const openLabelled = await page.evaluate((openId) => {
    window.__select({ kind: 'opening', id: openId });
    const res = window.__labelElement('Front door');
    const o = window.__project().levels[0].openings.find((x) => x.id === openId);
    return { title: res.title, stored: o.label ?? null };
  }, ids.openId);

  // --- re-label the wall + leave it selected/visible for the screenshot ---
  await page.evaluate((wallId) => {
    window.__select({ kind: 'wall', id: wallId });
    window.__labelElement('Party wall');
  }, ids.wallId);
  await page.waitForTimeout(120);

  return {
    log: { walls: ids.walls, openings: ids.openings, proSlot: pro.key, labelled: labelled.title, opening: openLabelled.title },
    checks: [
      ['A3: app booted with walls + openings', ids.walls > 0 && ids.openings > 0],
      ['A3: Simple shows NO label field on a wall (clean card)', !simple.rename],
      ['A3: Simple wall titles as "Wall" when unlabelled', simple.title === 'Wall'],
      ['A3: Pro exposes an editable label slot keyed to `label`', pro.key === 'label'],
      ['A3: the Pro slot starts empty with a placeholder', pro.value === '' && /optional/i.test(pro.placeholder)],
      ['A3: committing a label writes the model field', labelled.stored === 'Party wall'],
      ['A3: the inspector title follows the label', labelled.title === 'Party wall'],
      ['A3: the label edit is one undoable command', labelled.undo === before.undo + 1],
      ['A3: undo DELETES the optional key (no leaked field)', undone.hasKey === false],
      ['A3: save stays valid + lossless after undo', undone.self.valid === true && undone.self.lossless === true],
      ['A3: an opening labels through the same seam', openLabelled.stored === 'Front door' && openLabelled.title === 'Front door'],
      ['A3: Phase-1 regression intact (save valid + lossless)', before.self.valid === true && before.self.lossless === true],
    ],
  };
}
