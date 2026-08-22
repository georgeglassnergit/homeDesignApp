// E2 slice probe — the advisory-checks panel (UI wiring over the pure core/advisoryChecks.js
// engine). Drives the REAL app: proves the "Checks…" group is Pro-gated, seeds two deterministic
// advisories through the app's OWN edit paths (a low ceiling via the level-height field; a narrow
// door via the inspector width field), opens the panel, and asserts the rendered rows match the
// pure engine one-for-one, the ADVISORY disclaimer is always shown, and clicking a finding SELECTS
// the element it names (an opening → that opening; a storey finding → that storey) WITHOUT issuing
// any command. Leaves the panel open with its findings for the screenshot.
export async function run(page) {
  // Clean baseline: the sample home trips no rules of thumb.
  const baseline = await page.evaluate(() => {
    window.__setMode('simple');
    return {
      seamVisibleSimple: window.__checksSeamVisible(),
      advisories: window.__runChecks().counts.advisory,
    };
  });

  // Enter Pro (the seam gate) and seed two findings through real, undoable edits.
  const seed = await page.evaluate(() => {
    window.__setMode('pro');
    const lvl = window.__project().levels[0];
    // 1) a low ceiling — a whole-storey (level) advisory
    window.__setLevelHeight(lvl.id, 2.0);
    // 2) a narrow door — an opening advisory; edit it through the inspector width field
    const door = (lvl.openings || []).find((o) => o.kind === 'door');
    window.__select({ kind: 'door', id: door.id });
    window.__commitField('width', '0.6');
    const res = window.__runChecks();
    return {
      seamVisiblePro: window.__checksSeamVisible(),
      doorId: door.id,
      levelId: lvl.id,
      advisories: res.counts.advisory,
      byCode: res.byCode,
      codes: res.findings.map((f) => f.code),
      openingWidth: (window.__project().levels[0].openings.find((o) => o.id === door.id) || {}).width,
      levelHeight: window.__project().levels[0].height,
    };
  });

  // Open the panel and read what it rendered.
  const panel = await page.evaluate(() => window.__openChecks());

  // Click the opening (door-width) finding — it should select that door, no command issued.
  const clickOpening = await page.evaluate((doorId) => {
    const codes = window.__runChecks().findings.map((f) => f.code);
    const idx = codes.indexOf('door-width');
    const undoBefore = window.__history.undoStack.length;
    const r = window.__checkSelect(idx);
    return { idx, r, undoBefore, expectDoor: doorId };
  }, seed.doorId);

  // Click the ceiling (whole-storey) finding — it should surface that storey (selection cleared),
  // still no command.
  const clickLevel = await page.evaluate((levelId) => {
    const codes = window.__runChecks().findings.map((f) => f.code);
    const idx = codes.indexOf('ceiling-height');
    const undoBefore = window.__history.undoStack.length;
    const r = window.__checkSelect(idx);
    return { idx, r, undoBefore, expectLevel: levelId };
  }, seed.levelId);

  // Re-open for the screenshot (the two clicks toggled it open; keep it open + populated).
  const shot = await page.evaluate(() => window.__openChecks());

  await page.waitForTimeout(120);

  const rows = panel.rows;
  return {
    log: { baseline, seed, panel, clickOpening, clickLevel, shot },
    checks: [
      ['E2: sample home trips no advisories (clean baseline)', baseline.advisories === 0],
      ['E2: Checks group hidden in Simple (Pro seam)', baseline.seamVisibleSimple === false],
      ['E2: Checks group shown in Pro', seed.seamVisiblePro === true],
      ['E2: the low-ceiling edit applied (2.0 m)', Math.abs(seed.levelHeight - 2.0) < 1e-9],
      ['E2: the narrow-door edit applied (0.6 m)', Math.abs(seed.openingWidth - 0.6) < 1e-9],
      ['E2: engine now reports advisories', seed.advisories >= 2],
      ['E2: a ceiling-height finding is present', seed.codes.includes('ceiling-height')],
      ['E2: a door-width finding is present', seed.codes.includes('door-width')],
      ['E2: panel renders one row per engine finding', rows === seed.advisories],
      ['E2: the advisory disclaimer is always shown', panel.disclaimer === true],
      ['E2: panel opened', panel.open === true],
      ['E2: clicking the door finding selects that door', clickOpening.r && clickOpening.r.selection && clickOpening.r.selection.kind === 'door' && clickOpening.r.selection.id === clickOpening.expectDoor],
      ['E2: selecting a finding issues NO command (view state)', clickOpening.r && clickOpening.r.undo === clickOpening.undoBefore],
      ['E2: clicking the storey finding surfaces that storey', clickLevel.r && clickLevel.r.activeLevel === clickLevel.expectLevel],
      ['E2: the storey finding clears the selection', clickLevel.r && clickLevel.r.selection === null],
      ['E2: storey-finding click also issues no command', clickLevel.r && clickLevel.r.undo === clickLevel.undoBefore],
    ],
  };
}
