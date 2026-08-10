// D1 slice probe — import a plan (trace an uploaded floor-plan underlay).
// A file dialog can't open headlessly, so we synthesise a floor-plan image on an offscreen
// canvas (toDataURL) and load it through the SAME code path the file-input change handler runs
// (window.__importUnderlay). Then we assert:
//   • the underlay imports at the default ~10 m width and the "Plan image…" group appears
//   • opacity is a live display tweak
//   • calibration is Pro-gated (button hidden in Simple, shown in Pro)
//   • calibrating by two clicks over a known dimension rescales the plan so that feature now
//     measures the real length — anchored so the traced content stays put — and it is VIEW-ONLY
//     (no command pushed, selection untouched, the geometry save byte-identical)
//   • remove clears the underlay and hides the group
// Leaves a calibrated underlay on the plan for the screenshot.
export async function run(page) {
  // 1) synthesise a 1000x800 floor-plan image and import it
  const imp = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1000; c.height = 800;
    const g = c.getContext('2d');
    g.fillStyle = '#f7f4ee'; g.fillRect(0, 0, 1000, 800);
    g.strokeStyle = '#333'; g.lineWidth = 8;
    g.strokeRect(120, 120, 760, 560);                 // outer wall
    g.beginPath(); g.moveTo(500, 120); g.lineTo(500, 680); g.stroke();  // interior partition
    g.fillStyle = '#f7f4ee'; g.fillRect(470, 380, 60, 8);              // a doorway gap
    const dataUrl = c.toDataURL('image/png');
    const desc = await window.__importUnderlay(dataUrl);
    return { desc, group: window.__underlayGroupVisible(), lossless: window.__selftest().lossless };
  });

  // 2) opacity is a live display-only tweak
  const op = await page.evaluate(() => ({ opacity: window.__setUnderlayOpacity(25), lossless: window.__selftest().lossless }));

  // 3) calibration seam: hidden in Simple, shown in Pro
  const simpleCal = await page.evaluate(() => { window.__setMode('simple'); return window.__underlayCalibrateVisible(); });
  const proCal = await page.evaluate(() => { window.__setMode('pro'); return window.__underlayCalibrateVisible(); });

  // 4) calibrate over a known dimension. Two image pixels 500 px apart read 5 m at the default
  //    0.01 m/px; tell the app that span is really 2 m and re-measure the same pixels afterwards.
  const cal = await page.evaluate(() => {
    const u = window.__underlay();
    const toW = (px, pv) => ({ x: u.center.x + (px - u.imgWidth / 2) * u.metersPerPixel, z: u.center.z + (pv - u.imgHeight / 2) * u.metersPerPixel });
    const a = toW(250, 400), b = toW(750, 400);
    const spanBefore = window.__calibrateWorldSpan(250, 400, 750, 400);
    const undoBefore = window.__history.undoStack.length;
    const res = window.__calibrateUnderlay(a.x, a.z, b.x, b.z, 2);
    const spanAfter = window.__calibrateWorldSpan(250, 400, 750, 400);
    const uAfter = window.__underlay();
    // the anchor pixel (250,400) should still sit at the same world point
    const anchorAfter = { x: uAfter.center.x + (250 - uAfter.imgWidth / 2) * uAfter.metersPerPixel, z: uAfter.center.z + (400 - uAfter.imgHeight / 2) * uAfter.metersPerPixel };
    return { spanBefore, spanAfter, mppBefore: u.metersPerPixel, mppAfter: uAfter.metersPerPixel,
      undoBefore, undoAfter: res.undo, selection: res.selection, captured: res.captured,
      anchorBefore: a, anchorAfter, lossless: window.__selftest().lossless };
  });

  // 5) remove clears the underlay + hides the group, then re-import for the screenshot
  const rem = await page.evaluate(async () => {
    const r = window.__removeUnderlay();
    // re-import a fresh underlay + calibrate it so the screenshot shows a scaled trace-over plan
    const c = document.createElement('canvas'); c.width = 1000; c.height = 800;
    const g = c.getContext('2d');
    g.fillStyle = '#f7f4ee'; g.fillRect(0, 0, 1000, 800);
    g.strokeStyle = '#333'; g.lineWidth = 8; g.strokeRect(120, 120, 760, 560);
    g.beginPath(); g.moveTo(500, 120); g.lineTo(500, 680); g.stroke();
    await window.__importUnderlay(c.toDataURL('image/png'));
    window.__setUnderlayOpacity(55);
    return { hasUnderlay: r.hasUnderlay, groupVisible: r.groupVisible, reimported: window.__underlayGroupVisible() };
  });
  await page.waitForTimeout(120);

  const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

  return {
    log: {
      imgWidth: imp.desc && imp.desc.imgWidth, defaultWidthM: imp.desc && imp.desc.widthM,
      mppBefore: cal.mppBefore, mppAfter: cal.mppAfter, spanBefore: cal.spanBefore, spanAfter: cal.spanAfter,
    },
    checks: [
      ['D1: underlay imports with the image dimensions', !!imp.desc && imp.desc.imgWidth === 1000 && imp.desc.imgHeight === 800],
      ['D1: fresh underlay defaults to ~10 m wide', !!imp.desc && near(imp.desc.widthM, 10, 1e-6)],
      ['D1: "Plan image…" group appears once imported', imp.group === true],
      ['D1: opacity is a live display tweak (0.25)', near(op.opacity, 0.25, 1e-9)],
      ['D1: calibrate hidden in Simple (Pro seam)', simpleCal === false],
      ['D1: calibrate shown in Pro', proCal === true],
      ['D1: feature reads 5 m before calibration', near(cal.spanBefore, 5, 1e-6)],
      ['D1: same feature reads the known 2 m after calibration', near(cal.spanAfter, 2, 1e-6)],
      ['D1: scale multiplied by known/measured (2/5)', near(cal.mppAfter, cal.mppBefore * 2 / 5, 1e-9)],
      ['D1: anchor content point stays fixed in world', near(cal.anchorAfter.x, cal.anchorBefore.x, 1e-6) && near(cal.anchorAfter.z, cal.anchorBefore.z, 1e-6)],
      ['D1: two-click capture completed', cal.captured === true],
      ['D1: calibration issues NO command (undo depth unchanged)', cal.undoAfter === cal.undoBefore],
      ['D1: calibration leaves selection untouched', cal.selection == null],
      ['D1: geometry save byte-identical through import/opacity/calibrate', imp.lossless && op.lossless && cal.lossless],
      ['D1: remove clears the underlay + hides the group', rem.hasUnderlay === false && rem.groupVisible === false],
      ['D1: a plan can be re-imported after removal', rem.reimported === true],
    ],
  };
}
