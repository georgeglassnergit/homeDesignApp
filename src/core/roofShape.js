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

export function isPitched(type) {
  return type === 'gable' || type === 'hip';
}

// Axis-aligned footprint of a level's walls, expanded by the roof overhang.
// Returns null when the level has no walls (nothing to cover).
export function roofFootprint(level) {
  const walls = (level && level.walls) || [];
  if (!walls.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const w of walls) for (const p of [w.a, w.b]) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  const o = (level.roof && level.roof.overhang) || 0;
  return { x0: x0 - o, x1: x1 + o, z0: z0 - o, z1: z1 + o };
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
// Returns { positions (9 numbers/triangle, non-indexed, outward-facing),
//           triangleCount, ridgeY, apex|null }. apex is set only when a hip
// degenerates to a pyramid (square footprint).
export function roofSolid(type, footprint, { baseY = 0, pitch = DEFAULT_ROOF_PITCH } = {}) {
  const { x0, x1, z0, z1 } = footprint;
  const W = x1 - x0, D = z1 - z0;
  const ridgeAlongX = W >= D;          // ridge runs along the longer plan axis
  const shortHalf = Math.min(W, D) / 2;
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
    if (ridgeAlongX) {
      const zc = (z0 + z1) / 2;
      const rx0 = x0 + shortHalf, rx1 = x1 - shortHalf;
      const R0 = [rx0, hR, zc], R1 = [rx1, hR, zc];
      if (rx1 - rx0 < 1e-6) apex = [(rx0 + rx1) / 2, hR, zc];
      quad(raw, c00, c10, R1, R0);       // -Z trapezoid slope
      quad(raw, c11, c01, R0, R1);       // +Z trapezoid slope
      tri(raw, c00, R0, c01);            // hip end at x0
      tri(raw, c10, c11, R1);            // hip end at x1
    } else {
      const xc = (x0 + x1) / 2;
      const rz0 = z0 + shortHalf, rz1 = z1 - shortHalf;
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

  return { ...finalize(raw, center), ridgeY: hR, apex };
}
