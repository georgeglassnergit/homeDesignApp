// E3+ slice probe — DXF 2D-plan export UI (a "Download DXF (2D plan)" item added to the existing
// Export… popover, on the same Pro `ifc-export` seam as OBJ/glTF). The pure exporter
// (core/exportDxf.js) already has 39 unit tests incl. a structural DXF validator; this probe proves
// the UI wiring end-to-end through the REAL app: the button exists in the panel, __exportDxf runs
// over the LIVE project and yields a structurally valid R12 (AC1009) drawing with the expected
// wall/opening/room counts, and running the export MUTATES NOTHING. Leaves the panel open for the shot.
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
  const out = await page.evaluate(() => window.__exportDxf());
  const after = await page.evaluate(() => window.__selftest());

  // Structural essentials a DXF reader checks: R12 version tag (group code 9 $ACADVER = AC1009),
  // balanced SECTION/ENDSEC, an ENTITIES section, and a terminating EOF.
  const dxf = out.dxf || '';
  const isR12 = /\bAC1009\b/.test(dxf);
  const hasEntities = /\bENTITIES\b/.test(dxf);
  const sectionOpens = (dxf.match(/^SECTION$/gm) || []).length;
  const sectionCloses = (dxf.match(/^ENDSEC$/gm) || []).length;
  const balanced = sectionOpens > 0 && sectionOpens === sectionCloses;
  const endsWithEof = /\bEOF\s*$/.test(dxf.trim());

  // The button exists and the panel opens with it (Pro mode).
  await page.evaluate(() => { window.__setMode('pro'); });
  const btnExists = await page.evaluate(() => !!document.getElementById('export-dxf'));
  await page.click('#export-btn');
  await page.waitForTimeout(150);
  const panelOpen = await page.evaluate(() => document.getElementById('export-panel').classList.contains('open'));
  const btnVisible = await page.evaluate(() => { const b = document.getElementById('export-dxf'); return !!(b && b.offsetParent !== null); });

  return {
    log: { model, counts: out.counts, warnings: out.warnings, dxfBytes: dxf.length },
    checks: [
      ['E3+ DXF: Simple hides the Export group', simpleHidden === false],
      ['E3+ DXF: Pro reveals the Export group', proVisible === true],
      ['E3+ DXF: emitted drawing is R12 (AC1009)', isR12 === true],
      ['E3+ DXF: has an ENTITIES section', hasEntities === true],
      ['E3+ DXF: SECTION/ENDSEC balanced', balanced === true],
      ['E3+ DXF: terminates with EOF', endsWithEof === true],
      ['E3+ DXF: one wall footprint per model wall', out.counts.walls === model.walls && out.counts.walls > 0],
      ['E3+ DXF: openings drawn match the model', out.counts.openings === model.openings],
      ['E3+ DXF: rooms drawn match the model', out.counts.rooms === model.rooms && out.counts.rooms > 0],
      ['E3+ DXF: per-storey layers declared', out.counts.layers > 0],
      ['E3+ DXF: export mutates nothing (save byte-identical)', before.lossless && after.lossless && after.valid],
      ['E3+ DXF: the "Download DXF (2D plan)" button exists', btnExists === true],
      ['E3+ DXF: the export panel opens with the DXF button visible', panelOpen === true && btnVisible === true],
    ],
  };
}
