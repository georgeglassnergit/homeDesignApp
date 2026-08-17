// B2 slice probe — per-slope roof overhang (eaves vs. rake).
// Drives the roof-editor seam on the REAL rebuilt scene graph and proves the per-slope
// distinction that B2 adds:
//   • a larger EAVE overhang (sloped sides, perpendicular to the ridge) RAISES the ridge
//     (wider perpendicular span → higher peak) and lifts the gable-infill apex with it
//   • a larger RAKE overhang (gable ends, along the ridge) EXTENDS the ends but does NOT
//     change ridge height — the defining difference between the two knobs
//   • eave and rake grow the roof footprint on PERPENDICULAR axes (never the same one)
//   • the per-slope fields actually reach the model (__roof reflects them)
//   • the whole sweep stays lossless (byte-identical save) — no Phase-1 regression
// Leaves the roof on a customised gable so the screenshot shows the oversailing eaves.
export async function run(page) {
  await page.evaluate(() => window.__setMode && window.__setMode('pro'));

  // Roof shell bounding box (world == geometry-local for the pitched shell, which is built
  // from world-space positions on a mesh at the origin) + the gable-infill apex height.
  const survey = () => {
    // eslint-disable-next-line no-undef
    const home = window.__home;
    let roof = null, infillYmax = -Infinity, infill = 0;
    home.traverse((o) => {
      if (!o.isMesh) return;
      if (o.userData.kind === 'roof') { roof = o; return; }
      if (o.userData.kind === 'wall' && !o.userData.modelId) {  // gable-end infill (no modelId)
        infill++;
        const g = o.geometry; g.computeBoundingBox();
        infillYmax = Math.max(infillYmax, g.boundingBox.max.y);
      }
    });
    if (!roof) return null;
    const g = roof.geometry; g.computeBoundingBox(); const b = g.boundingBox;
    return {
      spanX: b.max.x - b.min.x, spanZ: b.max.z - b.min.z, ymax: b.max.y,
      infill, infillYmax,
    };
  };

  const lossless = () => window.__selftest().lossless;
  const before = await page.evaluate(lossless);

  // Baseline gable with equal, explicit overhangs.
  await page.evaluate(() => window.__setRoofType({ type: 'gable', pitch: 35, overhang: 0.3, eaveOverhang: 0.3, rakeOverhang: 0.3 }));
  const base = await page.evaluate(survey);

  // Bigger EAVE (+1.2 m each side), rake unchanged.
  await page.evaluate(() => window.__setRoofType({ eaveOverhang: 1.5 }));
  const bigEave = await page.evaluate(survey);
  const eaveRoof = await page.evaluate(() => window.__roof());
  const eaveLossless = await page.evaluate(lossless);

  // Back to baseline eave, bigger RAKE (+1.2 m each end).
  await page.evaluate(() => window.__setRoofType({ eaveOverhang: 0.3, rakeOverhang: 1.5 }));
  const bigRake = await page.evaluate(survey);
  const rakeRoof = await page.evaluate(() => window.__roof());

  // Leave a photogenic customised gable: generous eaves, tight rake.
  await page.evaluate(() => window.__setRoofType({ eaveOverhang: 0.9, rakeOverhang: 0.2 }));
  await page.waitForTimeout(150);
  const after = await page.evaluate(lossless);

  // Which axis each knob grew (perpendicular axes; ~0.1 m tolerance).
  const dEaveX = bigEave.spanX - base.spanX, dEaveZ = bigEave.spanZ - base.spanZ;
  const dRakeX = bigRake.spanX - base.spanX, dRakeZ = bigRake.spanZ - base.spanZ;
  const eaveGrewX = dEaveX > 0.1, eaveGrewZ = dEaveZ > 0.1;
  const rakeGrewX = dRakeX > 0.1, rakeGrewZ = dRakeZ > 0.1;

  return {
    log: {
      base: { spanX: +base.spanX.toFixed(3), spanZ: +base.spanZ.toFixed(3), ymax: +base.ymax.toFixed(3) },
      bigEave: { spanX: +bigEave.spanX.toFixed(3), spanZ: +bigEave.spanZ.toFixed(3), ymax: +bigEave.ymax.toFixed(3) },
      bigRake: { spanX: +bigRake.spanX.toFixed(3), spanZ: +bigRake.spanZ.toFixed(3), ymax: +bigRake.ymax.toFixed(3) },
      eaveRoof, rakeRoof,
    },
    checks: [
      ['B2: baseline gable renders one infill mesh', base.infill === 1],
      ['B2: a bigger EAVE raises the roof ridge', bigEave.ymax > base.ymax + 0.1],
      ['B2: a bigger EAVE lifts the gable-infill apex with the ridge', bigEave.infillYmax > base.infillYmax + 0.1],
      ['B2: a bigger RAKE does NOT change ridge height', Math.abs(bigRake.ymax - base.ymax) < 1e-3],
      ['B2: eave grew exactly one footprint axis', eaveGrewX !== eaveGrewZ],
      ['B2: rake grew exactly one footprint axis', rakeGrewX !== rakeGrewZ],
      ['B2: eave and rake act on PERPENDICULAR axes', (eaveGrewX !== rakeGrewX) && (eaveGrewZ !== rakeGrewZ)],
      ['B2: eave overhang growth is ~2.4 m across the perpendicular span', Math.abs((eaveGrewX ? dEaveX : dEaveZ) - 2.4) < 0.05],
      ['B2: rake overhang growth is ~2.4 m across its span', Math.abs((rakeGrewX ? dRakeX : dRakeZ) - 2.4) < 0.05],
      ['B2: the per-slope fields reach the model', eaveRoof.eaveOverhang === 1.5 && rakeRoof.rakeOverhang === 1.5],
      ['B2: save byte-identical across the overhang sweep', before === true && eaveLossless === true && after === true],
    ],
  };
}
