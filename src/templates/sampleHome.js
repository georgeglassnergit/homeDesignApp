// A small two-room home, defined entirely with the data model — no geometry here.
// This is both a starter template and the Phase 1 proof that the model → scene
// pipeline works from pure data.
import {
  createProject, createSite, createLevel, createWall, createOpening,
  createRoom, createRoof, createFurniture,
} from '../core/model.js';

export function sampleHome() {
  // footprint: 8m (x) x 6m (z), split into two rooms by a central partition
  const A = { x: -4, z: -3 }, B = { x: 4, z: -3 }, C = { x: 4, z: 3 }, D = { x: -4, z: 3 };
  const P1 = { x: 0, z: -3 }, P2 = { x: 0, z: 3 }; // partition endpoints

  const south = createWall(A, B);   // front
  const east  = createWall(B, C);
  const north = createWall(C, D);
  const west  = createWall(D, A);
  const partition = createWall(P1, P2);

  const openings = [
    createOpening(south.id, 'door',   { offset: 3.0 }),          // front entry door
    createOpening(east.id,  'window', { offset: 2.0 }),          // window on the east wall
    createOpening(north.id, 'window', { offset: 3.0 }),          // window on the north wall
    createOpening(partition.id, 'door', { offset: 3.5 }),        // interior door between rooms
  ];

  const level = createLevel({
    name: 'Ground floor',
    elevation: 0,
    walls: [south, east, north, west, partition],
    openings,
    rooms: [
      createRoom([A, P1, P2, D], { name: 'Living' }),
      createRoom([P1, B, C, P2], { name: 'Bedroom' }),
    ],
    roof: createRoof({ type: 'flat' }),
  });

  const furniture = [
    createFurniture('/sample.glb', { name: 'Sample object', levelId: level.id, position: { x: 2, z: -0.5 } }),
  ];

  return createProject({ name: 'Sample two-room home', site: createSite({ width: 16, depth: 14 }), levels: [level], furniture });
}
