// E3 slice probe — export the design to OBJ / JSON (Pro `ifc-export` seam).
// Boots the REAL app and proves the seam end-to-end through the actual DOM: Simple hides the
// Export group; Pro reveals it. Runs the pure exporter over the LIVE sample home via the
// __exportObj / __exportJson handles and asserts the OBJ is structurally valid (mtllib + per-
// element `o`/`usemtl` groups, 1-indexed faces in range), the counts line up with the model
// (one object per wall + room), the JSON export equals the lossless save and re-validates, and
// the export MUTATES NOTHING (save byte-identical). Leaves the export panel open for the shot.
export async function run(page) {
  // --- Simple: the Export group is hidden (novice-clean toolbar) ---
  const simpleHidden = await page.evaluate(() => { window.__setMode('simple'); return window.__exportSeamVisible(); });

  // --- Pro: the Export group appears ---
  const proVisible = await page.evaluate(() => { window.__setMode('pro'); return window.__exportSeamVisible(); });

  // --- model shape for the count cross-check ---
  const model = await page.evaluate(() => {
    const lvl = window.__project().levels[0];
    return { walls: (lvl.walls || []).length, rooms: (lvl.rooms || []).length, openings: (lvl.openings || []).length };
  });

  // --- run the pure OBJ exporter over the live project ---
  const before = await page.evaluate(() => window.__selftest());
  const objOut = await page.evaluate(() => window.__exportObj());
  const L = objOut.obj.split('\n');
  const vLines = L.filter((l) => l.startsWith('v '));
  const fLines = L.filter((l) => l.startsWith('f '));
  const oLines = L.filter((l) => l.startsWith('o '));
  const useLines = L.filter((l) => l.startsWith('usemtl '));
  const hasMtllib = L.some((l) => l.startsWith('mtllib '));
  const newmtls = objOut.mtl.split('\n').filter((l) => l.startsWith('newmtl ')).length;
  let facesInRange = fLines.length > 0;
  for (const f of fLines) {
    const idxs = f.slice(2).trim().split(/\s+/).map(Number);
    if (idxs.some((i) => !(i >= 1 && i <= objOut.counts.vertices))) facesInRange = false;
  }

  // --- JSON export == lossless save, and it re-validates ---
  const jsonOut = await page.evaluate(() => {
    const j = window.__exportJson();
    // exportProjectJson must return the canonical serialization of the live project
    const canonical = JSON.stringify(window.__project(), null, 2);
    let valid = false; try { valid = JSON.parse(j) && JSON.parse(j).schemaVersion === 1; } catch { valid = false; }
    return { equalsSave: j === canonical, parseValid: valid };
  });

  // --- the export touched nothing (save still byte-identical + valid) ---
  const after = await page.evaluate(() => window.__selftest());

  // --- open the export panel for the screenshot (click the toolbar button) ---
  await page.evaluate(() => { window.__setMode('pro'); });
  await page.click('#export-btn');
  await page.waitForTimeout(150);
  const panelOpen = await page.evaluate(() => document.getElementById('export-panel').classList.contains('open'));

  return {
    log: {
      model, objects: objOut.counts.objects, vertices: objOut.counts.vertices, faces: objOut.counts.faces,
      materials: objOut.counts.materials, warnings: objOut.warnings,
    },
    checks: [
      ['E3: Simple hides the Export group', simpleHidden === false],
      ['E3: Pro reveals the Export group', proVisible === true],
      ['E3: OBJ references a companion MTL (mtllib)', hasMtllib],
      ['E3: one `o` object per wall + room', oLines.length === model.walls + model.rooms && objOut.counts.objects === model.walls + model.rooms],
      ['E3: every object carries a usemtl', useLines.length === oLines.length && oLines.length > 0],
      ['E3: vertex/face line counts match reported counts', vLines.length === objOut.counts.vertices && fLines.length === objOut.counts.faces],
      ['E3: all faces are 1-indexed and in range', facesInRange],
      ['E3: MTL defines every used material', newmtls === objOut.counts.materials && newmtls > 0],
      ['E3: OBJ warns openings are uncut (honest massing)', objOut.counts.openings === model.openings && objOut.warnings.some((w) => /opening/.test(w))],
      ['E3: JSON export == lossless save', jsonOut.equalsSave === true],
      ['E3: exported JSON parses as a schema-v1 project', jsonOut.parseValid === true],
      ['E3: export mutates nothing (save byte-identical)', before.lossless && after.lossless && after.valid && before.valid],
      ['E3: export panel opens for the user', panelOpen === true],
      ['E3: Phase-1 regression intact (valid + lossless)', after.valid === true && after.lossless === true],
    ],
  };
}
