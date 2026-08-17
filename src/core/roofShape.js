// Pure roof-shape geometry — engine-independent (no Three.js, no DOM).
//
// Given a level's rectangular wall footprint, produce the triangle mesh for a
// gable or hip roof. The view layer (build/geometry.js) turns the returned flat
// position array into a BufferGeometry; keeping the shape math here means it is
// unit-tested under Node, and the plain model stays the single source of truth.
//
// This is a design/visualization roof, NOT a framing model: an approximate,
// symmetric pitched shell over the wall bounding box. Approachable defaults —
// never presented as code-certified or engineer-verified.

export const ROOF_TYPES = ['flat', 'gable', 'hip'];
export const DEFAULT_ROOF_PITCH = 30; // degrees from horizontal

// Which plan axis the ridge line runs along. 'auto' picks the longer axis (the
// conventional default); 'x'/'z' let the designer force it the other way — useful
// on a near-square footprint where "longer axis" is ambiguous, or purely for looks.
export const RIDGE_MODES = ['auto', 'x', 'z'];
export const DEFAULT_RIDGE = 'auto';

// Fallback depth (m) for a gable-end infill panel when the caller supplies none.
// Matches the model's default wall thickness so a lone gable reads as wall, not paper.
export const DEFAULT_INFILL_THICKNESS = 0.12;

export function isPitched(type) {
  return type === 'gable' || type === 'hip';
}

// Resolve a ridge mode to a concrete orientation for the given footprint.
// Returns true when the ridge runs along X, false when it runs along Z.
//   'auto' → the longer plan axis (W >= D) — the previous hardwired behaviour
//   'x'    → force the ridge along X
//   'z'    → force the ridge along Z
// Any unknown value falls back to 'auto', so an old/garbled field never throws.
export function resolveRidgeAlongX(footprint, ridge = DEFAULT_RIDGE) {
  if (ridge === 'x') return true;
  if (ridge === 'z') return false;
  const W = footprint.x1 - footprint.x0, D = footprint.z1 - footprint.z0;
  return W >= D;
}

// Bare axis-aligned bounding box of a level's walls (NO overhang) — the wall plane
// itself. Returns null when the level has no walls.
export function wallBounds(level) {
  const walls = (level && level.walls) || [];
  if (!walls.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const w of walls) for (const p of [w.a, w.b]) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  return { x0, x1, z0, z1 };
}

// Resolve a roof's effective EAVE and RAKE overhangs (metres), backfilling both
// from the legacy uniform `overhang` when the per-slope fields are absent. This is
// what keeps B2 lossless: a roof carrying only `overhang` yields eave === rake ===
// overhang, so its footprint — and every downstream vertex — is byte-identical to
// pre-B2 behaviour, and an old save (no eave/rake fields) still validates.
//   eave — overhang at the EAVES (the two sloped sides, PERPENDICULAR to the ridge)
//   rake — overhang at the RAKES (the gable/hip ends, ALONG the ridge)
export function roofOverhangs(roof) {
  const base = (roof && roof.overhang) || 0;
  const eave = (roof && roof.eaveOverhang != null) ? roof.eaveOverhang : base;
  const rake = (roof && roof.rakeOverhang != null) ? roof.rakeOverhang : base;
  return { eave, rake };
}

// Axis-aligned footprint of a level's walls, expanded by the roof overhang.
// Returns null when the level has no walls (nothing to cover).
//
// A FLAT roof overhangs uniformly on all four sides (the Phase-1 behaviour, unchanged).
// A PITCHED roof (B2) distinguishes the EAVE overhang (perpendicular to the ridge) from
// the RAKE overhang (along the ridge) so the two can differ. The ridge axis is resolved
// from the bare WALL bounds — deterministic and independent of the overhang — so the view
// layer can resolve it the same way and pass a concrete ridge to roofSolid/gableInfill,
// keeping the footprint's per-slope expansion and the shell in agreement when eave ≠ rake.
export function roofFootprint(level) {
  const b = wallBounds(level);
  if (!b) return null;
  const roof = (level && level.roof) || {};
  if (!isPitched(roof.type)) {
    const o = roof.overhang || 0;
    return { x0: b.x0 - o, x1: b.x1 + o, z0: b.z0 - o, z1: b.z1 + o };
  }
  const { eave, rake } = roofOverhangs(roof);
  const ridgeAlongX = resolveRidgeAlongX(b, roof.ridge);
  // Eaves run parallel to the ridge and overhang PERPENDICULAR to it; rakes are the
  // ends and overhang ALONG the ridge. Map that onto the X/Z expansion of the box.
  const ox = ridgeAlongX ? rake : eave;   // ±X expansion
  const oz = ridgeAlongX ? eave : rake;   // ±Z expansion
  return { x0: b.x0 - ox, x1: b.x1 + ox, z0: b.z0 - oz, z1: b.z1 + oz };
}

// Vertical rise (m) for a horizontal run (m) at a given pitch (degrees).
export function pitchRise(run, pitchDeg) {
  return Math.max(0, run) * Math.tan((pitchDeg * Math.PI) / 180);
}

// ---- small vector helpers (arrays of 3) ------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Emit a triangle / quad into a raw (unoriented) soup. Winding is fixed later
// by finalize(), so callers may push faces in any order.
function tri(out, a, b, c) { out.push(...a, ...b, ...c); }
function quad(out, a, b, c, d) { tri(out, a, b, c); tri(out, a, c, d); }

// Orient every triangle so its normal points away from the solid's centre
// (valid because gable/hip shells are convex), and drop zero-area faces (which
// appear when a hip degenerates to a pyramid). Returns non-indexed positions.
function finalize(raw, center) {
  const positions = [];
  let triangleCount = 0;
  for (let i = 0; i < raw.length; i += 9) {
    const a = [raw[i], raw[i + 1], raw[i + 2]];
    const b = [raw[i + 3], raw[i + 4], raw[i + 5]];
    const c = [raw[i + 6], raw[i + 7], raw[i + 8]];
    const n = cross(sub(b, a), sub(c, a));
    if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue; // degenerate — skip
    const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (dot(n, sub(cen, center)) < 0) positions.push(...a, ...c, ...b); // flip inward face
    else positions.push(...a, ...b, ...c);
    triangleCount++;
  }
  return { positions, triangleCount };
}

// Build the closed triangle shell for a pitched roof over a rectangular
// footprint. `type` must be 'gable' or 'hip'. Options:
//   baseY  — eave height (top of the walls), in metres
//   pitch  — roof slope in degrees (0<pitch<90)
//   ridge  — 'auto' (longer axis) | 'x' | 'z' (force the ridge orientation)
// Returns { positions (9 numbers/triangle, non-indexed, outward-facing),
//           triangleCount, ridgeY, ridgeAlongX, apex|null }. apex is set only
// when a hip degenerates to a pyramid (square footprint).
export function roofSolid(type, footprint, { baseY = 0, pitch = DEFAULT_ROOF_PITCH, ridge = DEFAULT_RIDGE } = {}) {
  const { x0, x1, z0, z1 } = footprint;
  const W = x1 - x0, D = z1 - z0;
  const ridgeAlongX = resolveRidgeAlongX(footprint, ridge); // 'auto' = longer axis
  // The run each slope covers is half the footprint span PERPENDICULAR to the ridge.
  const shortHalf = (ridgeAlongX ? D : W) / 2;
  const rise = pitchRise(shortHalf, pitch);
  const h0 = baseY, hR = baseY + rise;
  const center = [(x0 + x1) / 2, (h0 + hR) / 2, (z0 + z1) / 2];
  const raw = [];
  let apex = null;

  // eave corners
  const c00 = [x0, h0, z0], c10 = [x1, h0, z0], c11 = [x1, h0, z1], c01 = [x0, h0, z1];

  if (type === 'gable') {
    if (ridgeAlongX) {
      const zc = (z0 + z1) / 2;
      const R0 = [x0, hR, zc], R1 = [x1, hR, zc];
      quad(raw, c00, c10, R1, R0);       // -Z slope
      quad(raw, c11, c01, R0, R1);       // +Z slope
      tri(raw, c00, c01, R0);            // gable end at x0
      tri(raw, c10, c11, R1);            // gable end at x1
    } else {
      const xc = (x0 + x1) / 2;
      const R0 = [xc, hR, z0], R1 = [xc, hR, z1];
      quad(raw, c10, c11, R1, R0);       // +X slope
      quad(raw, c01, c00, R0, R1);       // -X slope
      tri(raw, c00, c10, R0);            // gable end at z0
      tri(raw, c01, c11, R1);            // gable end at z1
    }
  } else if (type === 'hip') {
    // Inset the ridge from each end by the hip run — but never past the midpoint,
    // else a ridge forced along the shorter axis would cross itself. Clamped to the
    // ridge-axis half-length, so it collapses to a pyramid apex instead of inverting.
    if (ridgeAlongX) {
      const zc = (z0 + z1) / 2;
      const inset = Math.min(shortHalf, W / 2);
      const rx0 = x0 + inset, rx1 = x1 - inset;
      const R0 = [rx0, hR, zc], R1 = [rx1, hR, zc];
      if (rx1 - rx0 < 1e-6) apex = [(rx0 + rx1) / 2, hR, zc];
      quad(raw, c00, c10, R1, R0);       // -Z trapezoid slope
      quad(raw, c11, c01, R0, R1);       // +Z trapezoid slope
      tri(raw, c00, R0, c01);            // hip end at x0
      tri(raw, c10, c11, R1);            // hip end at x1
    } else {
      const xc = (x0 + x1) / 2;
      const inset = Math.min(shortHalf, D / 2);
      const rz0 = z0 + inset, rz1 = z1 - inset;
      const R0 = [xc, hR, rz0], R1 = [xc, hR, rz1];
      if (rz1 - rz0 < 1e-6) apex = [xc, hR, (rz0 + rz1) / 2];
      quad(raw, c10, c11, R1, R0);       // +X trapezoid slope
      quad(raw, c01, c00, R0, R1);       // -X trapezoid slope
      tri(raw, c00, c10, R0);            // hip end at z0
      tri(raw, c11, c01, R1);            // hip end at z1
    }
  } else {
    throw new Error(`roofSolid: unsupported pitched type ${type}`);
  }

  // flat bottom cap at eave height closes the shell (an attic floor).
  quad(raw, c00, c10, c11, c01);

  return { ...finalize(raw, center), ridgeY: hR, ridgeAlongX, apex };
}

// Two triangular gable-end WALL panels — the wall infill under a gable roof.
//
// A gable leaves a triangle of open wall between the top of the (rectangular)
// walls and the two rising roof slopes at each end perpendicular to the ridge.
// In reality that triangle is wall (siding/brick), not roof and not void. This
// returns thin solid prisms — one per gable end — sitting on the WALL plane
// (inset from the roof's overhang), rising from eave height to the ridge, so the
// end reads as wall. The roof shell built by roofSolid() is left untouched: it
// keeps its own closing gable triangle at the overhang plane, which now reads as
// the rake overhang above/around this wall infill.
//
// Only 'gable' produces panels — 'hip'/'flat' have no gable end (empty result).
//   roofFp    — the roof (overhang-expanded) footprint; fixes ridge orientation &
//               height so each panel apex meets the ACTUAL roof ridge.
//   wallFp    — the bare wall bounding box (from wallBounds); fixes the panel base.
//   baseY     — eave height (top of the walls)
//   pitch     — roof slope in degrees (same value the roof uses)
//   ridge     — 'auto'|'x'|'z', resolved against roofFp exactly like roofSolid
//   thickness — panel depth (wall thickness), centred on the wall plane
// Returns { positions (9/tri, non-indexed, outward-facing), triangleCount,
//           ridgeAlongX, ridgeY }.
export function gableInfill(type, roofFp, wallFp, { baseY = 0, pitch = DEFAULT_ROOF_PITCH, ridge = DEFAULT_RIDGE, thickness = DEFAULT_INFILL_THICKNESS } = {}) {
  const ridgeAlongX = resolveRidgeAlongX(roofFp, ridge);
  // Ridge height matches the roof: rise over half the footprint span PERPENDICULAR
  // to the ridge (the overhang-expanded span, so the apex reaches the real ridge).
  const shortHalf = (ridgeAlongX ? (roofFp.z1 - roofFp.z0) : (roofFp.x1 - roofFp.x0)) / 2;
  const ridgeY = baseY + pitchRise(shortHalf, pitch);
  if (type !== 'gable' || !wallFp) return { positions: [], triangleCount: 0, ridgeAlongX, ridgeY };

  const { x0: wx0, x1: wx1, z0: wz0, z1: wz1 } = wallFp;
  const h = thickness / 2;
  const positions = [];
  let triangleCount = 0;

  // A thin triangular prism from a 3-vertex profile, extruded by ±h along `axis`.
  // finalize() orients its faces outward using the prism's own centroid (convex).
  const addPanel = (profile, axis) => {
    const e = axis === 'x' ? [h, 0, 0] : [0, 0, h];
    const front = profile.map((p) => [p[0] + e[0], p[1] + e[1], p[2] + e[2]]);
    const back = profile.map((p) => [p[0] - e[0], p[1] - e[1], p[2] - e[2]]);
    const raw = [];
    tri(raw, front[0], front[1], front[2]);        // near cap
    tri(raw, back[0], back[1], back[2]);           // far cap
    for (let i = 0; i < 3; i++) {                  // 3 side quads join the caps
      const j = (i + 1) % 3;
      quad(raw, front[i], front[j], back[j], back[i]);
    }
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < raw.length; i += 3) { cx += raw[i]; cy += raw[i + 1]; cz += raw[i + 2]; }
    const n = raw.length / 3;
    const fin = finalize(raw, [cx / n, cy / n, cz / n]);
    positions.push(...fin.positions);
    triangleCount += fin.triangleCount;
  };

  if (ridgeAlongX) {
    const zc = (wz0 + wz1) / 2;                    // == roof ridge z (symmetric overhang)
    addPanel([[wx0, baseY, wz0], [wx0, baseY, wz1], [wx0, ridgeY, zc]], 'x'); // end at x0
    addPanel([[wx1, baseY, wz0], [wx1, baseY, wz1], [wx1, ridgeY, zc]], 'x'); // end at x1
  } else {
    const xc = (wx0 + wx1) / 2;
    addPanel([[wx0, baseY, wz0], [wx1, baseY, wz0], [xc, ridgeY, wz0]], 'z'); // end at z0
    addPanel([[wx0, baseY, wz1], [wx1, baseY, wz1], [xc, ridgeY, wz1]], 'z'); // end at z1
  }
  return { positions, triangleCount, ridgeAlongX, ridgeY };
}
