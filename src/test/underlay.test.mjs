// D1 — "import a plan" underlay (engine-independent verification).
// Run: node src/test/underlay.test.mjs
//
// The underlay is a raster floor plan a user imports and traces walls over. It is pure
// DISPLAY state — never part of the Phase 1 geometry save — so all its logic is the pure
// screen/world/image mapping + scale-calibration math in core/underlay.js:
//   • defaultMetersPerPixel — a fresh image lands at a sensible ~10 m width before calibration
//   • createUnderlay / underlayWorldRect — the image as an axis-aligned world rectangle
//   • worldToImage / imageToWorld — the round-trippable pixel<->world mapping
//   • calibrateScale — multiply the scale by (known / measured)
//   • rescaleUnderlay — rescale about an anchor, keeping traced content fixed
//   • calibrateUnderlay — the end-to-end "I drew a known dimension" flow
// This file proves that math end-to-end so the DOM harness only confirms the image renders.
// It lives in its own file (pick-protocol §5) so it never collides with in-flight test work.
import {
  DEFAULT_UNDERLAY_WIDTH_M, DEFAULT_UNDERLAY_OPACITY,
  defaultMetersPerPixel, createUnderlay, underlayWorldRect,
  worldToImage, imageToWorld, calibrateScale, rescaleUnderlay, calibrateUnderlay,
  withOpacity, moveUnderlay,
} from '../core/underlay.js';
import { serialize, deserialize, validateProject, _resetIds } from '../core/model.js';
import { STARTERS } from '../templates/starters.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- 1) default scale: a fresh image spans ~10 m wide -----------------------------------------
{
  ok(near(defaultMetersPerPixel(1000), DEFAULT_UNDERLAY_WIDTH_M / 1000), '1a 1000px image -> 10 m/1000px');
  ok(near(defaultMetersPerPixel(500, 5), 0.01), '1b explicit target width honoured');
  let threw = false; try { defaultMetersPerPixel(0); } catch { threw = true; }
  ok(threw, '1c non-positive width throws');
  threw = false; try { defaultMetersPerPixel(100, 0); } catch { threw = true; }
  ok(threw, '1d non-positive target width throws');
}

// ---- 2) createUnderlay: defaults + validation --------------------------------------------------
{
  const u = createUnderlay({ imgWidth: 800, imgHeight: 600 });
  ok(near(u.metersPerPixel, DEFAULT_UNDERLAY_WIDTH_M / 800), '2a default metersPerPixel from width');
  ok(u.opacity === DEFAULT_UNDERLAY_OPACITY, '2b default opacity');
  ok(u.center.x === 0 && u.center.z === 0, '2c default center at origin');
  ok(Object.isFrozen(u) && Object.isFrozen(u.center), '2d descriptor is frozen (immutable view state)');

  const u2 = createUnderlay({ imgWidth: 800, imgHeight: 600, metersPerPixel: 0.02, center: { x: 3, z: -1 }, opacity: 0.9 });
  ok(near(u2.metersPerPixel, 0.02) && u2.center.x === 3 && u2.center.z === -1 && u2.opacity === 0.9, '2e explicit fields kept');
  ok(createUnderlay({ imgWidth: 10, imgHeight: 10, opacity: 5 }).opacity === 1, '2f opacity clamps to 1');
  ok(createUnderlay({ imgWidth: 10, imgHeight: 10, opacity: -3 }).opacity === 0, '2g opacity clamps to 0');

  let threw = false; try { createUnderlay({ imgWidth: 0, imgHeight: 10 }); } catch { threw = true; }
  ok(threw, '2h zero image width throws');
  threw = false; try { createUnderlay({ imgWidth: 10, imgHeight: 10, metersPerPixel: -1 }); } catch { threw = true; }
  ok(threw, '2i negative metersPerPixel throws');
}

// ---- 3) world rectangle: centred, sized by pixels * scale --------------------------------------
{
  const u = createUnderlay({ imgWidth: 400, imgHeight: 200, metersPerPixel: 0.05, center: { x: 2, z: 5 } });
  const r = underlayWorldRect(u);
  ok(near(r.widthM, 20) && near(r.heightM, 10), '3a extent = pixels * metersPerPixel');
  ok(near(r.minX, -8) && near(r.maxX, 12), '3b x bounds centred on center.x');
  ok(near(r.minZ, 0) && near(r.maxZ, 10), '3c z bounds centred on center.z');
}

// ---- 4) worldToImage / imageToWorld round-trip + known anchors ---------------------------------
{
  const u = createUnderlay({ imgWidth: 400, imgHeight: 200, metersPerPixel: 0.05, center: { x: 2, z: 5 } });
  const centrePx = worldToImage(u, u.center);
  ok(near(centrePx.u, 200) && near(centrePx.v, 100), '4a center maps to the image centre pixel');
  const tl = imageToWorld(u, 0, 0);
  ok(near(tl.x, -8) && near(tl.z, 0), '4b pixel (0,0) maps to the top-left world corner');
  // round-trip a scatter of world points
  let rt = true;
  for (const p of [{ x: 0, z: 0 }, { x: 11, z: 9 }, { x: -5, z: 3 }]) {
    const px = worldToImage(u, p); const back = imageToWorld(u, px.u, px.v);
    if (!near(back.x, p.x) || !near(back.z, p.z)) rt = false;
  }
  ok(rt, '4c world->image->world is identity');
}

// ---- 5) calibrateScale: multiply by (known / measured) ----------------------------------------
{
  ok(near(calibrateScale(5, 3, 0.02), 0.02 * 3 / 5), '5a scale corrected by known/measured');
  ok(near(calibrateScale(4, 4, 0.02), 0.02), '5b measured == known leaves scale unchanged');
  for (const bad of [[0, 3, 0.02], [5, 0, 0.02], [5, 3, 0]]) {
    let threw = false; try { calibrateScale(...bad); } catch { threw = true; }
    ok(threw, `5c non-positive input throws (${bad.join(',')})`);
  }
}

// ---- 6) rescaleUnderlay: anchor stays over the same image content ------------------------------
{
  const u = createUnderlay({ imgWidth: 400, imgHeight: 200, metersPerPixel: 0.05, center: { x: 0, z: 0 } });
  // pick a world anchor and remember which image pixel sits under it
  const anchor = { x: 4, z: -2 };
  const pxBefore = worldToImage(u, anchor);
  const u2 = rescaleUnderlay(u, 0.10, { anchor });      // double the scale
  ok(near(u2.metersPerPixel, 0.10), '6a new scale applied');
  const pxAfter = worldToImage(u2, anchor);
  ok(near(pxAfter.u, pxBefore.u) && near(pxAfter.v, pxBefore.v), '6b anchor still over the same image pixel after rescale');
  // no anchor => rescale about the centre (centre pixel unchanged, center unmoved)
  const u3 = rescaleUnderlay(u, 0.10);
  ok(u3.center.x === u.center.x && u3.center.z === u.center.z, '6c no-anchor rescale keeps center');
  let threw = false; try { rescaleUnderlay(u, 0); } catch { threw = true; }
  ok(threw, '6d non-positive new scale throws');
}

// ---- 7) calibrateUnderlay: the "I drew a known dimension" flow end-to-end ----------------------
{
  // A 1000x800 image defaulting to 10 m wide (metersPerPixel = 0.01). The user draws over a
  // doorway between two image pixels; under the current scale that reads 2.5 m, but it's really 0.9 m.
  const u = createUnderlay({ imgWidth: 1000, imgHeight: 800, center: { x: 0, z: 0 } });
  // two image-content points 250 px apart horizontally -> 2.5 m at 0.01 m/px
  const contentA = imageToWorld(u, 375, 400);
  const contentB = imageToWorld(u, 625, 400);
  ok(near(Math.hypot(contentB.x - contentA.x, contentB.z - contentA.z), 2.5), '7a feature reads 2.5 m before calibration');
  const u2 = calibrateUnderlay(u, contentA, contentB, 0.9);
  // the SAME two image pixels should now be 0.9 m apart in the world
  const a2 = imageToWorld(u2, 375, 400), b2 = imageToWorld(u2, 625, 400);
  ok(near(Math.hypot(b2.x - a2.x, b2.z - a2.z), 0.9), '7b same feature reads 0.9 m after calibration');
  // the anchor pixel (contentA's pixel) stays put in the world (traced content doesn't jump)
  ok(near(a2.x, contentA.x) && near(a2.z, contentA.z), '7c anchor content point stays fixed in world');
  // and the scale scaled by known/measured
  ok(near(u2.metersPerPixel, u.metersPerPixel * 0.9 / 2.5), '7d scale multiplied by known/measured');
}

// ---- 8) opacity / move helpers are pure copies -------------------------------------------------
{
  const u = createUnderlay({ imgWidth: 100, imgHeight: 100, center: { x: 1, z: 1 } });
  const uo = withOpacity(u, 0.25);
  ok(uo.opacity === 0.25 && uo !== u && u.opacity === DEFAULT_UNDERLAY_OPACITY, '8a withOpacity returns a copy, original unchanged');
  const um = moveUnderlay(u, { x: 9, z: -4 });
  ok(um.center.x === 9 && um.center.z === -4 && u.center.x === 1, '8b moveUnderlay returns a copy, original unchanged');
  ok(um.metersPerPixel === u.metersPerPixel && um.imgWidth === u.imgWidth, '8c move keeps scale + dimensions');
}

// ---- 9) the underlay NEVER touches the geometry save (Phase 1 contract inviolate) -------------
{
  _resetIds();
  const project = STARTERS.find((s) => s.id === 'two').build();
  const before = serialize(project);
  // importing / calibrating an underlay is a pure side computation — it must not reach the model
  let u = createUnderlay({ imgWidth: 1200, imgHeight: 900 });
  u = calibrateUnderlay(u, { x: 0, z: 0 }, { x: 3, z: 0 }, 4.2);
  u = withOpacity(moveUnderlay(u, { x: 1, z: 1 }), 0.3);
  const after = serialize(project);
  ok(after === before, '9a building/calibrating an underlay leaves the project save byte-identical');
  ok(validateProject(deserialize(after)).ok, '9b the untouched save still validates');
  ok(!('underlay' in project) && !(project.meta && 'underlay' in project.meta), '9c no underlay field leaks into the model/meta');
}

console.log(`\nunderlay.test: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n- ' + fails.join('\n- ')); process.exit(1); }
