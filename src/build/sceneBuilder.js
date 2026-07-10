import * as THREE from 'three';
import { makeMaterialRegistry } from './materials.js';
import { buildWallMesh, buildFloorMesh, buildRoofMesh, buildGroundMesh } from './geometry.js';
import { loadFurniture } from './furniture.js';

// Turn a whole-home project model into a Three.js scene graph.
// Geometry (walls/floors/roof/ground) is built synchronously; furniture GLBs load
// async. Resolves once everything (including furniture) is in the group.
export async function buildScene(project) {
  const group = new THREE.Group();
  group.name = 'home';
  const mat = makeMaterialRegistry(project.materials);
  const pick = (key) => mat[key] || mat.default;

  // site
  if (project.site) group.add(buildGroundMesh(project.site, pick(project.site.material)));

  // levels: walls (+ their openings), floors, roof
  for (const level of project.levels) {
    for (const wall of level.walls) {
      const ops = level.openings.filter((o) => o.wallId === wall.id);
      group.add(buildWallMesh(wall, ops, level.elevation, pick(wall.material)));
    }
    for (const room of level.rooms) group.add(buildFloorMesh(room, level.elevation, pick(room.material)));
    if (level.roof) { const r = buildRoofMesh(level, pick(level.roof.material)); if (r) group.add(r); }
  }

  // furniture (async GLBs)
  const levelElev = (id) => (project.levels.find((l) => l.id === id)?.elevation) ?? 0;
  await Promise.all(project.furniture.map((f) => loadFurniture(f, group, levelElev(f.levelId))));

  return group;
}

// Bounds of the built home, for camera framing.
export function sceneBounds(group) {
  return new THREE.Box3().setFromObject(group);
}
