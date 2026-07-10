// templates/sampleHome.js — the Phase 1 verification home as pure data: a two-room home
// (5 walls, 2 floors, flat roof, a front door + 2 windows + interior door), all in meters.
import { createProject, createLevel, makeWall, makeOpening } from '../core/model.js';

export function sampleHome() {
  const level = createLevel({ id: 'lvl1', roof: {} });

  // outer shell (rectangle) + one dividing wall -> two rooms
  const w1 = makeWall({ x: 0, z: 0 }, { x: 6, z: 0 }, { id: 'w_front' });
  const w2 = makeWall({ x: 6, z: 0 }, { x: 6, z: 4 }, { id: 'w_right' });
  const w3 = makeWall({ x: 6, z: 4 }, { x: 0, z: 4 }, { id: 'w_back' });
  const w4 = makeWall({ x: 0, z: 4 }, { x: 0, z: 0 }, { id: 'w_left' });
  const w5 = makeWall({ x: 3, z: 0 }, { x: 3, z: 4 }, { id: 'w_div' }); // divider
  level.walls.push(w1, w2, w3, w4, w5);

  level.openings.push(
    makeOpening('w_front', 'door',   1.2, { id: 'o_frontdoor' }),
    makeOpening('w_front', 'window', 4.5, { id: 'o_win1' }),
    makeOpening('w_back',  'window', 3.0, { id: 'o_win2' }),
    makeOpening('w_div',   'door',   2.0, { id: 'o_interior' }),
  );

  level.rooms.push(
    { id: 'r_living', points: [{x:0,z:0},{x:3,z:0},{x:3,z:4},{x:0,z:4}], material: 'floor' },
    { id: 'r_bed',    points: [{x:3,z:0},{x:6,z:0},{x:6,z:4},{x:3,z:4}], material: 'floor' },
  );

  return createProject({ name: 'Sample Two-Room Home', levels: [level] });
}
