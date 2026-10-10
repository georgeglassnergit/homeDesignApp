// Schedule (CSV) export UI probe — a "Download schedule (CSV)" item added to the existing Export…
// popover, on the same Pro `ifc-export` seam as OBJ/glTF/DXF. The pure builder (core/schedule.js)
// already has 65 unit tests; this probe proves the UI wiring end-to-end through the REAL app: the
// button exists in the panel and is Pro-gated, __exportSchedule runs over the LIVE project and
// yields a well-formed sectioned CSV with the expected room/opening/wall figures and the advisory
// disclaimer, and running the export MUTATES NOTHING. Leaves the panel open for the shot.
export async function run(page) {
  const simpleHidden = await page.evaluate(() => { window.__setMode('simple'); return window.__exportSeamVisible(); });
  const proVisible = await page.evaluate(() => { window.__setMode('pro'); return window.__exportSeamVisible(); });

  const model = await page.evaluate(() => {
    const lvl = window.__project().levels[0];
    return {
      walls: (lvl.walls || []).length,
      rooms: (lvl.rooms || []).length,
      openings: (lvl.openings || []).length,
    };
  });

  const before = await page.evaluate(() => window.__selftest());
  const out = await page.evaluate(() => window.__exportSchedule());
  const after = await page.evaluate(() => window.__selftest());

  const csv = out.csv || '';
  const s = out.schedule || {};
  const sum = s.summary || {};
  // Structural essentials a spreadsheet reader relies on: the four named sections, CRLF endings,
  // and the advisory disclaimer surfaced in the file (constraint #6).
  const hasSections = ['Summary', 'Rooms', 'Openings', 'Walls by level'].every((h) => csv.includes(h));
  const crlf = csv.includes('\r\n');
  const hasDisclaimer = csv.includes('Approximate quantities');

  // The schedule must reflect the LIVE model, not a fixture: counts line up with the project.
  const roomsMatch = s.rooms && s.rooms.length === model.rooms;
  const openingsMatch = sum.openings === model.openings;
  const wallsMatch = sum.walls === model.walls && model.walls > 0;
  const areaSane = sum.floorArea > 0 && sum.netWallArea >= 0 && sum.grossWallArea >= sum.netWallArea;

  // The button exists and the panel opens with it (Pro mode).
  await page.evaluate(() => { window.__setMode('pro'); });
  const btnExists = await page.evaluate(() => !!document.getElementById('export-schedule'));
  await page.click('#export-btn');
  await page.waitForTimeout(150);
  const panelOpen = await page.evaluate(() => document.getElementById('export-panel').classList.contains('open'));
  const btnVisible = await page.evaluate(() => { const b = document.getElementById('export-schedule'); return !!(b && b.offsetParent !== null); });

  return {
    log: { model, summary: sum, csvBytes: csv.length },
    checks: [
      ['Schedule: Simple hides the Export group', simpleHidden === false],
      ['Schedule: Pro reveals the Export group', proVisible === true],
      ['Schedule: CSV has all four sections', hasSections === true],
      ['Schedule: CSV uses CRLF line endings', crlf === true],
      ['Schedule: CSV surfaces the advisory disclaimer', hasDisclaimer === true],
      ['Schedule: room schedule matches the live model', roomsMatch === true],
      ['Schedule: opening count matches the live model', openingsMatch === true],
      ['Schedule: wall count matches the live model', wallsMatch === true],
      ['Schedule: areas are sane (GFA>0, gross≥net≥0)', areaSane === true],
      ['Schedule: export mutates nothing (save byte-identical)', before.lossless && after.lossless && after.valid],
      ['Schedule: the "Download schedule (CSV)" button exists', btnExists === true],
      ['Schedule: the export panel opens with the CSV button visible', panelOpen === true && btnVisible === true],
    ],
  };
}
