// E3+ slice probe — SVG 2D-plan-image export UI (a "Download SVG (2D plan image)" item added to the
// existing Export… popover, on the same Pro `ifc-export` seam as OBJ/glTF/DXF). The pure exporter
// (core/exportSvg.js) already has 43 unit tests incl. a structural SVG validator; this probe proves
// the UI wiring end-to-end through the REAL app: the button exists in the panel, __exportSvg runs
// over the LIVE project and yields a well-formed SVG image with the expected wall/opening/room
// counts, and running the export MUTATES NOTHING. Leaves the panel open for the shot.
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
  const out = await page.evaluate(() => window.__exportSvg());
  const after = await page.evaluate(() => window.__selftest());

  // Structural essentials a renderer checks: XML declaration, exactly one <svg> root with a
  // 4-number viewBox, balanced <g> containers, and no NaN/Infinity token in any coordinate.
  const svg = out.svg || '';
  const hasXmlDecl = /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(svg);
  const oneRoot = (svg.match(/<svg\b/g) || []).length === 1 && (svg.match(/<\/svg>/g) || []).length === 1;
  const vb = svg.match(/viewBox="([^"]*)"/);
  const viewBoxOk = !!vb && vb[1].trim().split(/\s+/).length === 4 && vb[1].trim().split(/\s+/).every((n) => Number.isFinite(Number(n)));
  const gOpen = (svg.match(/<g\b/g) || []).length, gClose = (svg.match(/<\/g>/g) || []).length;
  const gBalanced = gOpen === gClose;
  const noNonFinite = !/\b(NaN|Infinity|-Infinity|undefined)\b/.test(svg);
  // Poché per wall + gap per opening + polygon per room = one <polygon> each.
  const polys = (svg.match(/<polygon\b/g) || []).length;

  // The button exists and the panel opens with it (Pro mode).
  await page.evaluate(() => { window.__setMode('pro'); });
  const btnExists = await page.evaluate(() => !!document.getElementById('export-svg'));
  await page.click('#export-btn');
  await page.waitForTimeout(150);
  const panelOpen = await page.evaluate(() => document.getElementById('export-panel').classList.contains('open'));
  const btnVisible = await page.evaluate(() => { const b = document.getElementById('export-svg'); return !!(b && b.offsetParent !== null); });

  return {
    log: { model, counts: out.counts, warnings: out.warnings, svgBytes: svg.length },
    checks: [
      ['E3+ SVG: Simple hides the Export group', simpleHidden === false],
      ['E3+ SVG: Pro reveals the Export group', proVisible === true],
      ['E3+ SVG: emitted image has an XML declaration', hasXmlDecl === true],
      ['E3+ SVG: exactly one <svg> root', oneRoot === true],
      ['E3+ SVG: viewBox is 4 finite numbers', viewBoxOk === true],
      ['E3+ SVG: <g> containers balanced', gBalanced === true],
      ['E3+ SVG: no NaN/Infinity token in any coordinate', noNonFinite === true],
      ['E3+ SVG: one polygon per wall+opening+room', polys === model.walls + model.openings + model.rooms && polys > 0],
      ['E3+ SVG: one wall footprint per model wall', out.counts.walls === model.walls && out.counts.walls > 0],
      ['E3+ SVG: openings drawn match the model', out.counts.openings === model.openings],
      ['E3+ SVG: rooms drawn match the model', out.counts.rooms === model.rooms && out.counts.rooms > 0],
      ['E3+ SVG: at least one storey panel', out.counts.levels > 0],
      ['E3+ SVG: export mutates nothing (save byte-identical)', before.lossless && after.lossless && after.valid],
      ['E3+ SVG: the "Download SVG (2D plan image)" button exists', btnExists === true],
      ['E3+ SVG: the export panel opens with the SVG button visible', panelOpen === true && btnVisible === true],
    ],
  };
}
