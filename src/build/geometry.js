import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { wallLength } from '../core/model.js';
import { roofFootprint, roofSolid, isPitched, DEFAULT_ROOF_PITCH } from '../core/roofShape.js';

const _eval = new Evaluator();

// Build a wall as a solid box along its centerline, then subtract each opening
// (door/window) via CSG boolean — the same subtraction model IFC uses.
export function buildWallMesh(wall, openings, elevation, material) {
  const { a, b, thickness, height } = wall;
  const len = wallLength(wall);
  const angle = Math.atan2(b.z - a.z, b.x - a.x); // direction of the wall in plan
  const rotY = -angle;                            // Three.js: +X maps to (cosφ,0,-sinφ)
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const dirx = Math.cos(angle), dirz = Math.sin(angle);

  let result = new Brush(new THREE.BoxGeometry(len, height, thickness), material);
  result.position.set(mx, elevation + height / 2, mz);
  result.rotation.y = rotY;
  result.updateMatrixWorld();

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
    const { positions } = roofSolid(type, fp, { baseY, pitch });
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

// Ground plane for the site/lot.
export function buildGroundMesh(site, material) {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(site.width, site.depth), material);
  g.rotation.x = -Math.PI / 2;
  g.position.y = 0;
  g.receiveShadow = true;
  g.userData.kind = 'ground';
  return g;
}
