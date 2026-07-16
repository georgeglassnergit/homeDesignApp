// templates/starters.js — starter projects the template picker (S4) instantiates.
// Pure data only — no geometry, no Three.js. Each returns a fresh, valid Project.
//
// Offset convention matches src/core/model.js: an opening's `offset` is the distance
// from wall endpoint `a` to the opening's NEAR edge (createOpening default), and
// validateProject checks `offset >= 0 && offset + width <= wallLength`.
import {
  createProject, createSite, createLevel, createWall, createOpening,
  createRoom, createRoof,
} from '../core/model.js';
import { sampleHome } from './sampleHome.js';

// Blank: a single empty level with a flat roof — draw a home from scratch.
export function blank() {
  return createProject({
    name: 'Blank home',
    site: createSite({ width: 16, depth: 14 }),
    levels: [createLevel({ name: 'Ground floor', roof: createRoof({ type: 'flat' }) })],
  });
}

// Studio: one rectangular room (4m x 3.5m) with a front door and a rear window.
export function studio() {
  const A = { x: 0, z: 0 }, B = { x: 4, z: 0 }, C = { x: 4, z: 3.5 }, D = { x: 0, z: 3.5 };
  const front = createWall(A, B);
  const right = createWall(B, C);
  const back  = createWall(C, D);
  const left  = createWall(D, A);

  const level = createLevel({
    name: 'Ground floor',
    walls: [front, right, back, left],
    openings: [
      createOpening(front.id, 'door',   { offset: 1.5 }),   // near-edge 1.5, width 0.9 -> fits len 4
      createOpening(back.id,  'window', { offset: 1.3 }),   // near-edge 1.3, width 1.4 -> fits len 4
    ],
    rooms: [createRoom([A, B, C, D], { name: 'Studio' })],
    roof: createRoof({ type: 'flat' }),
  });

  return createProject({ name: 'Studio', site: createSite({ width: 12, depth: 12 }), levels: [level] });
}

// The template picker's menu (S4). `build()` returns a fresh Project each call;
// `desc` is the one-line blurb the start screen shows under each thumbnail.
export const STARTERS = [
  { id: 'blank',  label: 'Blank',           desc: 'Empty level — draw your own walls from scratch.', build: blank },
  { id: 'studio', label: 'Studio (1 room)', desc: 'One 4×3.5 m room with a front door and rear window.', build: studio },
  { id: 'two',    label: 'Two-room home',   desc: 'Two rooms, 5 walls, 4 openings — the sample home.', build: sampleHome },
];
