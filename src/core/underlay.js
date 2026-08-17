// core/underlay.js — D1 "import a plan": the pure math for a raster floor-plan UNDERLAY.
//
// A user imports a picture of a floor plan and traces walls over it. The underlay is a
// display/session preference — it is NEVER part of the geometry save (the Phase 1 model
// contract stays untouched, old saves byte-identical). All that lives here is the pure
// mapping between the image's pixels and world meters, plus the scale-calibration math.
// ZERO Three.js, ZERO DOM: the plan surface (app/planCanvas.js) turns the descriptor this
// module produces into a drawImage() call; every number it needs is computed here so the
// calibration is fully node-testable.
//
// The descriptor places the image as an axis-aligned rectangle on the top-down XZ plane:
//   • imgWidth / imgHeight — the image's natural pixel size (> 0)
//   • metersPerPixel       — world meters spanned by one image pixel (> 0); this is the scale
//                            calibration tunes
//   • center               — the world point { x, z } under the image's centre
//   • opacity              — 0..1 draw opacity (default 0.5 so walls read on top)
// Screen +y maps to world +z (the plan's convention), so image pixel-row +v maps to world +z.

export const DEFAULT_UNDERLAY_WIDTH_M = 10;   // a freshly imported image spans ~10 m before calibration
export const DEFAULT_UNDERLAY_OPACITY = 0.5;

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// The scale a freshly imported image gets so it lands at a sensible on-screen size before the
// user calibrates: make it `targetWidthMeters` wide.
export function defaultMetersPerPixel(imgWidth, targetWidthMeters = DEFAULT_UNDERLAY_WIDTH_M) {
  if (!(imgWidth > 0)) throw new Error('imgWidth must be > 0');
  if (!(targetWidthMeters > 0)) throw new Error('targetWidthMeters must be > 0');
  return targetWidthMeters / imgWidth;
}

// Build a normalized (frozen) underlay descriptor, filling defaults and validating dimensions.
export function createUnderlay({ imgWidth, imgHeight, metersPerPixel, center, opacity } = {}) {
  if (!(imgWidth > 0) || !(imgHeight > 0)) throw new Error('underlay needs positive image dimensions');
  const mpp = metersPerPixel != null ? metersPerPixel : defaultMetersPerPixel(imgWidth);
  if (!(mpp > 0)) throw new Error('metersPerPixel must be > 0');
  const c = center || { x: 0, z: 0 };
  return Object.freeze({
    imgWidth, imgHeight,
    metersPerPixel: mpp,
    center: Object.freeze({ x: c.x, z: c.z }),
    opacity: opacity != null ? clamp01(opacity) : DEFAULT_UNDERLAY_OPACITY,
  });
}

// The world-space rectangle the image occupies (centred at `center`).
export function underlayWorldRect(u) {
  const widthM = u.imgWidth * u.metersPerPixel;
  const heightM = u.imgHeight * u.metersPerPixel;
  return {
    widthM, heightM,
    minX: u.center.x - widthM / 2, maxX: u.center.x + widthM / 2,
    minZ: u.center.z - heightM / 2, maxZ: u.center.z + heightM / 2,
  };
}

// World point -> image pixel coords { u, v } (top-left origin; v grows with world +z).
export function worldToImage(u, pt) {
  return {
    u: (pt.x - u.center.x) / u.metersPerPixel + u.imgWidth / 2,
    v: (pt.z - u.center.z) / u.metersPerPixel + u.imgHeight / 2,
  };
}

// Image pixel coords -> world point (inverse of worldToImage).
export function imageToWorld(u, px, pv) {
  return {
    x: u.center.x + (px - u.imgWidth / 2) * u.metersPerPixel,
    z: u.center.z + (pv - u.imgHeight / 2) * u.metersPerPixel,
  };
}

// The calibration core: the user drew a segment currently measuring `measuredWorldLength`
// world-meters over an image feature they know is `knownRealLength` meters long, so the image's
// scale should be multiplied by (known / measured). Returns the corrected metersPerPixel.
export function calibrateScale(measuredWorldLength, knownRealLength, currentMetersPerPixel) {
  if (!(measuredWorldLength > 0)) throw new Error('measured length must be > 0');
  if (!(knownRealLength > 0)) throw new Error('known length must be > 0');
  if (!(currentMetersPerPixel > 0)) throw new Error('current metersPerPixel must be > 0');
  return currentMetersPerPixel * (knownRealLength / measuredWorldLength);
}

// Return a copy of the underlay at a new scale, keeping a given world `anchor` point fixed over
// the SAME image content (so a calibration drawn from `anchor` doesn't make the image jump).
// With no anchor the image rescales about its centre. Deriving center so that the image pixel
// currently under `anchor` still maps to `anchor` after the scale change:
//   center1 = anchor - (anchor - center0) * (newMpp / oldMpp)
export function rescaleUnderlay(u, newMetersPerPixel, { anchor } = {}) {
  if (!(newMetersPerPixel > 0)) throw new Error('newMetersPerPixel must be > 0');
  const a = anchor || u.center;
  const ratio = newMetersPerPixel / u.metersPerPixel;
  return createUnderlay({
    imgWidth: u.imgWidth, imgHeight: u.imgHeight,
    metersPerPixel: newMetersPerPixel,
    center: {
      x: a.x - (a.x - u.center.x) * ratio,
      z: a.z - (a.z - u.center.z) * ratio,
    },
    opacity: u.opacity,
  });
}

// End-to-end calibration: two world clicks `worldA`/`worldB` lie on an image feature the user
// says is `knownRealLength` meters. Rescale the underlay so that same feature now measures that,
// anchored at `worldA` so the traced-over content stays put. Returns the new descriptor.
export function calibrateUnderlay(u, worldA, worldB, knownRealLength) {
  const measured = Math.hypot(worldB.x - worldA.x, worldB.z - worldA.z);
  const newMpp = calibrateScale(measured, knownRealLength, u.metersPerPixel);
  return rescaleUnderlay(u, newMpp, { anchor: worldA });
}

// Return a copy at a new draw opacity (0..1). Pure display tweak — no geometry effect.
export function withOpacity(u, opacity) {
  return createUnderlay({
    imgWidth: u.imgWidth, imgHeight: u.imgHeight,
    metersPerPixel: u.metersPerPixel, center: u.center,
    opacity,
  });
}

// Return a copy re-centred at a world point (dragging the underlay under the walls).
export function moveUnderlay(u, center) {
  return createUnderlay({
    imgWidth: u.imgWidth, imgHeight: u.imgHeight,
    metersPerPixel: u.metersPerPixel, center, opacity: u.opacity,
  });
}
