// F-slice probe — "Furnish from a photo" view-layer wiring (Simple seam 'furnish-photo-3d').
//
// Proves the UI slice that makes the whole Phase-4 furnish stack (pure pipeline → application
// controller → same-origin proxy) reachable, END TO END through the REAL production path:
//   • the Simple-tier "Furnish photo…" button is present,
//   • picking a photo via the real <input type=file> (driven with setInputFiles) → FileReader →
//     the production same-origin fetch transport → GLB verify-load → commit → the model lands in
//     the live 3D scene as an undoable furniture object,
//   • furniture is a PURE FUNCTION of the model: Undo drops the record AND its mesh; Redo restores
//     both (reconcileFurniture),
//   • a bad image fails fast and local with the invalid-image code and commits nothing.
//
// The only test doubles are the two the F1 CI constraint demands: window.fetch is stubbed for the
// app's OWN /api/furnish proxy (so NO live provider call — real for every other URL), and the
// synthetic job points glbUrl at the harness-served local /sample.glb. Everything else — the
// button, file input, FileReader, the fetch adapter, GLTFLoader, the scene — is the real app.
//
// A file dialog can't open headlessly, so setInputFiles feeds the real input element a synthetic
// 1×1 PNG buffer; the rest of the flow is exactly what a user's pick runs.
const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function run(page) {
  // 1) the Simple-tier seam is present on boot
  const seam = await page.evaluate(() => ({
    visible: window.__furnishSeamVisible(),
    label: window.__furnishBtnLabel(),
    busy: window.__furnishBusy(),
    scene: window.__furnishSceneCount(),
    model: window.__project().furniture.length,
    undo: window.__history.undoStack.length,
  }));

  // 2) a bad image fails fast + local (no network, no commit). Run this BEFORE the success flow so
  //    the screenshot's final hint reads the "Added …" confirmation, not this error.
  const bad = await page.evaluate(async () => {
    const beforeScene = window.__furnishSceneCount(), beforeUndo = window.__history.undoStack.length;
    const res = await window.__furnishFromPhoto('data:text/plain;base64,QUJD', {});   // 'ABC' — wrong type
    return { res, sceneUnchanged: window.__furnishSceneCount() === beforeScene, undoUnchanged: window.__history.undoStack.length === beforeUndo, busy: window.__furnishBusy() };
  });

  // 3) stub window.fetch for the OWN same-origin proxy only (pass-through for every other URL).
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.__realFetch = real;
    window.fetch = async (url, init) => {
      const u = typeof url === 'string' ? url : (url && url.url) || '';
      if (u.includes('/api/furnish')) {
        const method = (init && init.method) || 'GET';
        const body = method === 'POST'
          ? { jobId: 'probe-job-1' }                                                   // submit
          : { status: 'succeeded', progress: 1, glbUrl: '/sample.glb', name: 'Test Chair' }; // poll
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return real(url, init);
    };
  });

  // 4) drive the REAL file input with a synthetic PNG; the change handler runs the production flow.
  await page.setInputFiles('#furnish-file', {
    name: 'chair.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG_B64, 'base64'),
  });
  // wait for the job to commit + the mesh to land (and the busy state to clear)
  await page.waitForFunction((base) => !window.__furnishBusy() && window.__furnishSceneCount() > base, seam.scene, { timeout: 20000 });
  await page.waitForTimeout(150);

  const afterAdd = await page.evaluate(() => {
    const furn = window.__project().furniture;
    const added = furn[furn.length - 1] || {};   // the newly-committed record is appended last
    return {
      scene: window.__furnishSceneCount(), model: furn.length,
      modelSrc: added.src, modelName: added.name,
      undo: window.__history.undoStack.length, label: window.__furnishBtnLabel(),
      lossless: window.__selftest().lossless,
    };
  });

  // 5) furniture is a pure function of the model — Undo drops record + mesh; Redo restores both.
  //    Drive the real toolbar Undo/Redo buttons (history.undo/redo + refresh → reconcileFurniture).
  await page.click('#undo');
  await page.waitForFunction((base) => window.__furnishSceneCount() === base, seam.scene, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(120);
  const afterUndo = await page.evaluate(() => ({
    scene: window.__furnishSceneCount(), model: window.__project().furniture.length, lossless: window.__selftest().lossless,
  }));

  await page.click('#redo');
  await page.waitForFunction((base) => window.__furnishSceneCount() > base, seam.scene, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(120);
  const afterRedo = await page.evaluate(() => ({
    scene: window.__furnishSceneCount(), model: window.__project().furniture.length, lossless: window.__selftest().lossless,
  }));

  await page.waitForTimeout(200);   // settle the furnished scene for the screenshot

  return {
    log: {
      seam, afterAdd, afterUndo, afterRedo,
      badCode: bad.res && bad.res.code, badOk: bad.res && bad.res.ok,
    },
    checks: [
      ['F: "Furnish photo…" seam present in Simple', seam.visible === true],
      ['F: button starts idle (label "Furnish photo…", not busy)', /Furnish/.test(seam.label || '') && seam.busy === false],
      ['F: the scene mirrors the model at boot (furniture is a pure fn of it)', seam.scene === seam.model],
      ['F: picking a photo commits ONE furniture record to the model', afterAdd.model === seam.model + 1],
      ['F: the generated GLB lands in the live 3D scene', afterAdd.scene === seam.scene + 1],
      ['F: the committed record carries the proxy GLB src', afterAdd.modelSrc === '/sample.glb'],
      ['F: the committed record carries the job-reported name', afterAdd.modelName === 'Test Chair'],
      ['F: the furnish is a single undoable command (undo depth +1)', afterAdd.undo === seam.undo + 1],
      ['F: save stays lossless after the furnish', afterAdd.lossless === true],
      ['F: button returns to idle after the job', /Furnish/.test(afterAdd.label || '')],
      ['F: Undo removes the record from the model', afterUndo.model === seam.model],
      ['F: Undo removes the mesh from the scene (pure fn of model)', afterUndo.scene === seam.scene],
      ['F: Redo restores the record to the model', afterRedo.model === seam.model + 1],
      ['F: Redo restores the mesh to the scene', afterRedo.scene === seam.scene + 1],
      ['F: save lossless across undo/redo of a furnish', afterUndo.lossless === true && afterRedo.lossless === true],
      ['F: a bad image fails with the invalid-image code', bad.res && bad.res.ok === false && bad.res.code === 'invalid-image'],
      ['F: a bad image commits nothing (scene + undo unchanged)', bad.sceneUnchanged === true && bad.undoUnchanged === true],
      ['F: not left busy after the error', bad.busy === false],
    ],
  };
}
