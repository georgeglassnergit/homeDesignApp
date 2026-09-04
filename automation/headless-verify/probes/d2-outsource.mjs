// D2 slice probe — "Outsource" design brief (the second onboarding tile, now LIVE).
// Boots the REAL app and proves the path end-to-end through the actual DOM:
//   • the Outsource start-screen tile is enabled (no longer "coming soon")
//   • opening the modal renders a live brief built from the sample home (header + overview + the
//     always-present advisory footer per guardrail #6)
//   • the sample home's counts (5 walls / 4 openings) surface in the brief
//   • typed intake fields flow into the brief text; a malformed e-mail is dropped AND flagged
//   • composing the brief MUTATES NOTHING (the geometry save stays byte-identical + valid)
//   • the modal is really open + visible for the screenshot
// Leaves the filled modal open for the shot.
export async function run(page) {
  // 1) the tile is live
  const tileEnabled = await page.evaluate(() => window.__outsourceTileEnabled());

  // 2) open the modal — the preview should carry the brief from the live sample home
  const before = await page.evaluate(() => window.__selftest());
  const opened = await page.evaluate(() => window.__openOutsource());
  const domOpen1 = await page.evaluate(() => document.getElementById('outsource').classList.contains('open'));

  // 3) fill the intake (with a deliberately bad e-mail) and read back the brief
  const filled = await page.evaluate(() => window.__outsourceFill({
    name: 'Jane Homeowner',
    email: 'not-an-email',
    phone: '555-1234',
    style: 'Modern farmhouse',
    timeline: 'Spring 2027',
    notes: 'Please finish the kitchen layout.\nRedraw everything to scale.',
  }));

  // 4) fix the e-mail — the warning should clear and the address should appear
  const fixed = await page.evaluate(() => window.__outsourceFill({ email: 'jane@example.com' }));

  const after = await page.evaluate(() => window.__selftest());

  // 5) the modal is open + the download/copy controls are present for the screenshot
  const controls = await page.evaluate(() => ({
    open: document.getElementById('outsource').classList.contains('open'),
    hasDownload: !!document.getElementById('out-download'),
    hasCopy: !!document.getElementById('out-copy'),
    previewLen: (document.getElementById('out-preview').textContent || '').length,
  }));
  await page.waitForTimeout(120);

  const t = filled.text || '';
  const ft = fixed.text || '';

  return {
    log: {
      tileEnabled, filename: filled.filename,
      walls: before.counts.walls, openings: before.counts.openings,
      previewLen: controls.previewLen,
    },
    checks: [
      ['D2: Outsource start tile is enabled (not "coming soon")', tileEnabled === true],
      ['D2: opening the modal renders a brief preview', domOpen1 === true && typeof opened.text === 'string' && opened.text.includes('HOME DESIGN BRIEF')],
      ['D2: brief reports the sample home walls', new RegExp(`Walls:\\s+${before.counts.walls}\\b`).test(t)],
      ['D2: brief reports the sample home openings', new RegExp(`Doors & windows:\\s+${before.counts.openings}\\b`).test(t)],
      ['D2: advisory footer present (not a construction spec)', /FOR THE DESIGNER/.test(t) && /not a surveyed/i.test(t)],
      ['D2: typed name flows into the brief', t.includes('Jane Homeowner')],
      ['D2: notes carry through (multi-line)', t.includes('Please finish the kitchen layout.') && t.includes('Redraw everything to scale.')],
      ['D2: style + timeline render', t.includes('Modern farmhouse') && t.includes('Spring 2027')],
      ['D2: malformed e-mail is dropped from the brief', !t.includes('not-an-email')],
      ['D2: malformed e-mail is flagged in the UI', filled.emailRejected === true && filled.emailWarn === true],
      ['D2: a valid e-mail clears the warning and appears', fixed.emailRejected === false && fixed.emailWarn === false && ft.includes('jane@example.com')],
      ['D2: filename is slugged .txt', typeof filled.filename === 'string' && filled.filename.endsWith('-design-brief.txt')],
      ['D2: composing the brief mutates nothing (save byte-identical)', before.lossless && after.lossless && after.valid],
      ['D2: modal open with download + copy controls for the user', controls.open && controls.hasDownload && controls.hasCopy && controls.previewLen > 100],
      ['D2: Phase-1 regression intact (valid + lossless)', after.valid === true && after.lossless === true],
    ],
  };
}
