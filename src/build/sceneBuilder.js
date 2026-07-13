import * as THREE from 'three';
import { makeMaterialRegistry } from './materials.js';
import { buildWallMesh, buildFloorMesh, buildRoofMesh, buildGroundMesh } from './geometry.js';
import { loadFurniture } from './furniture.js';

// Generated-geometry kinds (walls/floors/roof/ground). Furniture is loaded async and
// tracked separately so incremental rebuilds after an edit don't reload every GLB.
const GEOMETRY_KINDS = new Set(['wall', 'floor', 'roof', 'ground']);

// Build all synchronous geometry meshes for a project (no furniture). Pure function
// of the model: returns a flat array of stamped meshes. Used by buildScene and by
// rebuildGeometry so an edit re-derives exactly the same objects.
export function buildGeometry(project) {
  const mat = makeMaterialRegistry(project.materials);
  const pick = (key) => mat[key] || mat.default;
  const meshes = [];

  if (project.site) meshes.push(buildGroundMesh(project.site, pick(project.site.material)));

  for (const level of project.levels) {
    for (const wall of level.walls) {
      const ops = level.openings.filter((o) => o.wallId === wall.id);
      meshes.push(buildWallMesh(wall, ops, level.elevation, pick(wall.material)));
    }
    for (const room of level.rooms) meshes.push(buildFloorMesh(room, level.elevation, pick(room.material)));
    if (level.roof) { const r = buildRoofMesh(level, pick(level.roof.material)); if (r) meshes.push(r); }
  }
  return meshes;
}

// Turn a whole-home project model into a Three.js scene graph.
// Geometry (walls/floors/roof/ground) is built synchronously; furniture GLBs load
// async. Resolves once everything (including furniture) is in the group.
export async function buildScene(project) {
  const group = new THREE.Group();
  group.name = 'home';

  for (const mesh of buildGeometry(project)) group.add(mesh);

  // furniture (async GLBs)
  const levelElev = (id) => (project.levels.find((l) => l.id === id)?.elevation) ?? 0;
  await Promise.all(project.furniture.map((f) => loadFurniture(f, group, levelElev(f.levelId))));

  return group;
}

// Incremental rebuild after a model edit: drop the old generated geometry (keeping
// any loaded furniture in place) and re-derive walls/floors/roof/ground from the
// current model. Every mesh re-stamps its userData, so picking keeps working.
export function rebuildGeometry(group, project) {
  const stale = group.children.filter((c) => GEOMETRY_KINDS.has(c.userData.kind));
  for (const m of stale) {
    group.remove(m);
    m.geometry?.dispose?.();
  }
  for (const mesh of buildGeometry(project)) group.add(mesh);
  return group;
}

// Bounds of the built home, for camera framing.
export function sceneBounds(group) {
  return new THREE.Box3().setFromObject(group);
}
