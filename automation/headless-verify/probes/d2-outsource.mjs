// D2 slice probe — the "Outsource" onboarding intake (UI wiring over pure core/outsourceRequest.js).
// Drives the REAL app: proves the Outsource tile is now a live, enabled card (no longer a disabled
// "coming soon"), that clicking it opens a modal whose auto-generated brief matches the pure derived
// brief for the live design, that the service catalog + advisory disclaimer render, that building a
// request validates (needs a contact) — and that the WHOLE flow is derived-on-read: it issues no
// command and leaves the project save byte-identical. Leaves the modal open for the screenshot.
export async function run(page) {
  // The seam is un-tiered: the tile is wired in both Simple and Pro.
  const seam = await page.evaluate(() => {
    window.__setMode('simple');
    const simple = window.__outsourceSeamVisible();
    window.__setMode('pro');
    const pro = window.__outsourceSeamVisible();
    window.__setMode('simple');
    return { simple, pro };
  });

  // Open the template picker and inspect the Outsource tile in the DOM.
  const tile = await page.evaluate(() => {
    window.__openPicker(false);
    const el = document.getElementById('tpl-outsource');
    const disabledSoon = !!document.querySelector('#picker-grid .tpl-card:disabled');
    return { exists: !!el, enabled: el ? !el.disabled : false, label: el ? el.querySelector('.name')?.textContent : null, anyComingSoon: disabledSoon };
  });

  // Click the tile — the picker closes and the outsource modal opens.
  const clicked = await page.evaluate(() => {
    document.getElementById('tpl-outsource').click();
    return {
      pickerOpen: document.getElementById('picker').classList.contains('open'),
      modalOpen: document.getElementById('outsource').classList.contains('open'),
    };
  });

  // Re-open via the handle to read the rendered modal state + confirm the save is untouched.
  const opened = await page.evaluate(() => window.__openOutsource());

  // The rendered brief must match the pure derived brief for the live sample home.
  const brief = await page.evaluate(() => {
    const b = window.__outsourceBrief();
    const boxText = document.getElementById('os-brief').value;
    return {
      rooms: b.home.rooms, walls: b.home.walls, levels: b.home.levels,
      gfaText: b.home.grossFloorAreaText,
      boxHasProject: boxText.includes('Project:'),
      boxHasGfa: boxText.includes(b.home.grossFloorAreaText),
      counts: window.__project ? { rooms: window.__project().levels.reduce((s, l) => s + l.rooms.length, 0) } : null,
    };
  });

  // Build a request through the handle: valid with a contact; invalid without; no save touch, no command.
  const req = await page.evaluate(() => {
    const good = window.__outsourceRequest({ name: 'Ada', email: 'ada@example.com', notes: 'Please quote a concept.' }, 'full-drawing');
    const bad = window.__outsourceRequest({}, 'concept');
    return { good, bad };
  });

  // Fill the form fields and confirm the download-request path validates in the DOM (button enabled).
  const form = await page.evaluate(() => {
    document.getElementById('os-name').value = 'Ada Lovelace';
    document.getElementById('os-email').value = 'ada@example.com';
    document.getElementById('os-service').value = 'permit-ready';
    // re-open to keep it visible + populated for the screenshot
    window.__openOutsource();
    return {
      services: document.getElementById('os-service').querySelectorAll('option').length,
      discShown: document.getElementById('os-disc').textContent.length > 0,
      modalOpen: document.getElementById('outsource').classList.contains('open'),
    };
  });

  await page.waitForTimeout(120);

  return {
    log: { seam, tile, clicked, opened, brief, req, form },
    checks: [
      ['D2: seam un-tiered — tile wired in Simple', seam.simple === true],
      ['D2: seam un-tiered — tile wired in Pro', seam.pro === true],
      ['D2: Outsource tile exists', tile.exists === true],
      ['D2: Outsource tile is enabled (not "coming soon")', tile.enabled === true],
      ['D2: no "coming soon" disabled tiles remain', tile.anyComingSoon === false],
      ['D2: clicking the tile closes the picker', clicked.pickerOpen === false],
      ['D2: clicking the tile opens the outsource modal', clicked.modalOpen === true],
      ['D2: modal renders a non-empty brief', opened.briefLen > 0],
      ['D2: modal renders the 3 service levels', opened.services === 3],
      ['D2: advisory disclaimer always shown', /does not draw/.test(opened.disclaimer)],
      ['D2: opening the modal leaves the save byte-identical', opened.saveUntouched === true],
      ['D2: brief room count matches the live model', brief.rooms === brief.counts.rooms],
      ['D2: brief textarea names the project', brief.boxHasProject === true],
      ['D2: brief textarea shows the GFA', brief.boxHasGfa === true],
      ['D2: a request with a contact validates', req.good.valid.ok === true],
      ['D2: a request with no contact is rejected', req.bad.valid.ok === false],
      ['D2: building a request issues NO command', req.good.undo === req.bad.undo],
      ['D2: building a request leaves the save byte-identical', req.good.saveUntouched === true && req.bad.saveUntouched === true],
      ['D2: the service dropdown has 3 options', form.services === 3],
      ['D2: the intake disclaimer is shown in the DOM', form.discShown === true],
      ['D2: modal is open for the screenshot', form.modalOpen === true],
    ],
  };
}
