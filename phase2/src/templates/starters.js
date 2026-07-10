// templates/starters.js — starter projects the template picker instantiates (pure data).
import { createProject, createLevel, makeWall, makeOpening } from '../core/model.js';
import { sampleHome } from './sampleHome.js';

// Blank: a single empty level (draw from scratch).
export function blank() {
  return createProject({ name: 'Blank Project', levels: [createLevel({ id: 'lvl1', roof: {} })] });
}

// Studio: one rectangular room with a door + window.
export function studio() {
  const level = createLevel({ id: 'lvl1', roof: {} });
  const walls = [
    makeWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { id: 's_front' }),
    makeWall({ x: 4, z: 0 }, { x: 4, z: 3.5 }, { id: 's_right' }),
    makeWall({ x: 4, z: 3.5 }, { x: 0, z: 3.5 }, { id: 's_back' }),
    makeWall({ x: 0, z: 3.5 }, { x: 0, z: 0 }, { id: 's_left' }),
  ];
  level.walls.push(...walls);
  level.openings.push(
    makeOpening('s_front', 'door', 1.0, { id: 's_door' }),
    makeOpening('s_back', 'window', 2.0, { id: 's_win' }),
  );
  level.rooms.push({ id: 's_room', points: [{x:0,z:0},{x:4,z:0},{x:4,z:3.5},{x:0,z:3.5}], material: 'floor' });
  return createProject({ name: 'Studio', levels: [level] });
}

export const STARTERS = [
  { id: 'blank',  label: 'Blank',            build: blank },
  { id: 'studio', label: 'Studio (1 room)',  build: studio },
  { id: 'two',    label: 'Two-room home',    build: sampleHome },
];
