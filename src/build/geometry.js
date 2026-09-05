import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { wallLength } from '../core/model.js';
import { roofFootprint, wallBounds, roofSolid, gableInfill, isPitched, resolveRidgeAlongX, DEFAULT_ROOF_PITCH } from '../core/roofShape.js';
import { DEFAULTS } from '../core/model.js';
import { wallQuad } from '../core/wallJoin.js';

const _eval = new Evaluator();

// Build the solid a wall occupies in plan. The footprint is a quad in plan {x,z}
// (its plain ±½-thickness rectangle, OR — for C2 — a mitred quad from wallJoin so
// adjoining corners meet gap-free and non-overlapping). We extrude it up to the
// wall height and stand it on the ground plane. A degenerate/absent quad falls back
// to the plain centreline box so a lone or zero-length wall behaves exactly as before.
function wallPrismBrush(wall, quad, elevation, material) {
  const { height } = wall;
  const fp = (Array.isArray(quad) && quad.length === 4) ? quad : wallQuad(wall);
  if (!fp) {
    // zero-length / no direction: preserve the legacy centreline box (may be degenerate,
    // exactly as before — validation rejects such walls upstream).
    const len = wallLength(wall);
    const box = new Brush(new THREE.BoxGeometry(len, height, wall.thickness), material);
    box.position.set((wall.a.x + wall.b.x) / 2, elevation + height / 2, (wall.a.z + wall.b.z) / 2);
    box.updateMatrixWorld();
    return box;
  }
  // Shape in (x, -z): rotateX(-90°) then maps shape-Y→world-Z and the extrude depth→world-Y,
  // laying the footprint flat in world XZ (matching buildFloorMesh's convention) and standing
  // the prism from y=0 to y=height. The mesh is positioned at y=elevation.
  const shape = new THREE.Shape();
  fp.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
  geo.rotateX(-Math.PI / 2);
  const brush = new Brush(geo, material);
  brush.position.set(0, elevation, 0);
  brush.updateMatrixWorld();
  return brush;
}

// Build a wall as a solid prism over its (optionally mitred) plan footprint, then
// subtract each opening (door/window) via CSG boolean — the same subtraction model
// IFC uses. `quad` is the wall's mitred footprint from wallJoin (see buildGeometry);
// omit it and the wall falls back to its plain ±½-thickness rectangle.
export function buildWallMesh(wall, openings, elevation, material, quad) {
  const { a, b, thickness, height } = wall;
  const len = wallLength(wall);
  const angle = Math.atan2(b.z - a.z, b.x - a.x); // direction of the wall in plan
  const rotY = -angle;                            // Three.js: +X maps to (cosφ,0,-sinφ)
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const dirx = Math.cos(angle), dirz = Math.sin(angle);

  let result = wallPrismBrush(wall, quad, elevation, material);

  for (const op of openings) {
    const localX = op.offset + op.width / 2 - len / 2;  // along-wall offset from midpoint
    const cutY = elevation + op.sill + op.height / 2;
    const cut = new Brush(new THREE.BoxGeometry(op.width, op.height, thickness * 4));
    cut.position.set(mx + dirx * localX, cutY, mz + dirz * localX);
    cut.rotation.y = rotY;
    cut.updateMatrixWorld();
    result = _eval.evaluate(result, cut, SUBTRACTION);
  }
  result.castShadow = true;
  result.receiveShadow = true;
  result.userData.modelId = wall.id;
  result.userData.kind = 'wall';
  return result;
}

// Floor from a plan polygon of {x,z} points.
export function buildFloorMesh(room, elevation, material) {
  const shape = new THREE.Shape();
  room.points.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);            // XY shape -> XZ ground plane
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = elevation + 0.005;   // just above the ground to avoid z-fighting
  mesh.receiveShadow = true;
  mesh.userData.modelId = room.id;
  mesh.userData.kind = 'floor';
  return mesh;
}

// Roof covering the level's wall footprint. Flat = a slab (unchanged from Phase 1);
// gable/hip = a pitched shell whose SHAPE math lives in the pure core/roofShape.js
// (unit-tested under Node) — this function only turns those vertices into a mesh.
export function buildRoofMesh(level, material) {
  if (!level.walls.length) return null;
  const type = (level.roof && level.roof.type) || 'flat';

  if (isPitched(type)) {
    const fp = roofFootprint(level);
    if (!fp) return null;
    const baseY = level.elevation + level.height;
    const pitch = level.roof.pitch ?? DEFAULT_ROOF_PITCH;
    // Resolve the ridge axis from the bare WALL bounds — the same basis roofFootprint used —
    // and pass a CONCRETE ridge so the per-slope (eave≠rake) footprint and the shell agree.
    const ridgeAlongX = resolveRidgeAlongX(wallBounds(level), level.roof.ridge ?? 'auto');
    const { positions } = roofSolid(type, fp, { baseY, pitch, ridge: ridgeAlongX ? 'x' : 'z' });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.kind = 'roof';
    return mesh;
  }

  // flat slab
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const w of level.walls) for (const p of [w.a, w.b]) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const o = level.roof.overhang || 0;
  const w = (maxX - minX) + 2 * o, d = (maxZ - minZ) + 2 * o;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w, level.roof.thickness, d), material);
  slab.position.set((minX + maxX) / 2, level.elevation + level.height + level.roof.thickness / 2, (minZ + maxZ) / 2);
  slab.castShadow = true;
  slab.userData.kind = 'roof';
  return slab;
}

// Gable-end WALL infill — the triangular wall panels that fill the void between
// the top of the walls and the roof slopes at a gable's ends. Returns a single
// mesh (both end panels) in the WALL material, or null when the level has no
// gable roof / no walls. Additive only: the roof mesh (buildRoofMesh) is unchanged.
export function buildGableInfillMesh(level, material) {
  if (!level.walls.length || !level.roof || level.roof.type !== 'gable') return null;
  const roofFp = roofFootprint(level);
  const wallFp = wallBounds(level);
  if (!roofFp || !wallFp) return null;
  const baseY = level.elevation + level.height;
  const pitch = level.roof.pitch ?? DEFAULT_ROOF_PITCH;
  // Concrete ridge from the wall bounds (matches roofFootprint) so the panel apex meets
  // the real ridge even when the eave/rake overhangs differ (B2).
  const ridgeAlongX = resolveRidgeAlongX(wallFp, level.roof.ridge ?? 'auto');
  // Match the panel depth to the walls so the gable reads as a continuation of them.
  const thickness = level.walls[0]?.thickness ?? DEFAULTS.wall.thickness;
  const { positions } = gableInfill('gable', roofFp, wallFp, { baseY, pitch, ridge: ridgeAlongX ? 'x' : 'z', thickness });
  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.kind = 'wall';
  return mesh;
}

// Ground plane for the site/lot.
export function buildGroundMesh(site, material) {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(site.width, site.depth), material);
  g.rotation.x = -Math.PI / 2;
  g.position.y = 0;
  g.receiveShadow = true;
  g.userData.kind = 'ground';
  return g;
}
