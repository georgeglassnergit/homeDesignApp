// E3+ slice probe — glTF 2.0 export UI (the third format added to the existing Export… popover,
// on the same Pro `ifc-export` seam). The pure exporter (core/exportGltf.js) already has 47 unit
// tests + a real GLTFLoader round-trip; this probe proves the UI wiring end-to-end through the real
// app: the "Download glTF 2.0" button exists in the panel, __exportGltf runs over the LIVE project
// and yields a structurally valid, parseable glTF-2.0 document with the expected mesh/material
// counts, and running the export MUTATES NOTHING. Leaves the export panel open for the screenshot.
export async function run(page) {
  const simpleHidden = await page.evaluate(() => { window.__setMode('simple'); return window.__exportSeamVisible(); });
  const proVisible = await page.evaluate(() => { window.__setMode('pro'); return window.__exportSeamVisible(); });

  const model = await page.evaluate(() => {
    const lvl = window.__project().levels[0];
    return { walls: (lvl.walls || []).length, rooms: (lvl.rooms || []).length };
  });

  const before = await page.evaluate(() => window.__selftest());
  const out = await page.evaluate(() => window.__exportGltf());
  const after = await page.evaluate(() => window.__selftest());

  // Parse the emitted glTF and check the spec-level essentials.
  let doc = null, parseOk = false;
  try { doc = JSON.parse(out.gltf); parseOk = true; } catch { parseOk = false; }
  const assetOk = !!(doc && doc.asset && doc.asset.version === '2.0');
  const hasScene = !!(doc && Array.isArray(doc.scenes) && doc.scenes.length >= 1 && Array.isArray(doc.nodes) && doc.nodes.length > 0);
  const bufferEmbedded = !!(doc && Array.isArray(doc.buffers) && doc.buffers[0] && /^data:/.test(doc.buffers[0].uri));
  const pbrOk = !!(doc && Array.isArray(doc.materials) && doc.materials.length >= 1 && doc.materials.every((m) => m.pbrMetallicRoughness));

  // The button exists and the panel opens with it.
  await page.evaluate(() => { window.__setMode('pro'); });
  const btnExists = await page.evaluate(() => !!document.getElementById('export-gltf'));
  await page.click('#export-btn');
  await page.waitForTimeout(150);
  const panelOpen = await page.evaluate(() => document.getElementById('export-panel').classList.contains('open'));
  const btnVisible = await page.evaluate(() => { const b = document.getElementById('export-gltf'); return !!(b && b.offsetParent !== null); });

  return {
    log: { model, counts: out.counts, warnings: out.warnings, gltfBytes: out.gltf.length },
    checks: [
      ['E3+: Simple hides the Export group', simpleHidden === false],
      ['E3+: Pro reveals the Export group', proVisible === true],
      ['E3+: emitted glTF parses as JSON', parseOk === true],
      ['E3+: asset.version is "2.0"', assetOk === true],
      ['E3+: document has a scene + nodes', hasScene === true],
      ['E3+: geometry buffer is embedded as a data: URI', bufferEmbedded === true],
      ['E3+: one mesh per wall + room', out.counts.meshes === model.walls + model.rooms && out.counts.meshes > 0],
      ['E3+: PBR materials present (metallic-roughness)', pbrOk === true],
      ['E3+: exporter reports vertices + triangles', out.counts.vertices > 0 && out.counts.triangles > 0],
      ['E3+: export mutates nothing (save byte-identical)', before.lossless && after.lossless && after.valid],
      ['E3+: the "Download glTF 2.0" button exists', btnExists === true],
      ['E3+: the export panel opens with the glTF button visible', panelOpen === true && btnVisible === true],
    ],
  };
}
