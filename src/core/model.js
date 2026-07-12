// ============================================================================
// Whole-home data model — plain, serializable data (no Three.js in here).
// This is the single source of truth a project is built from and saved as.
// Everything is in REAL-WORLD METERS, +Y up (glTF / IFC convention).
// Model/view separation: this file knows nothing about rendering.
// ============================================================================

export const SCHEMA_VERSION = 1;

// "Approachable but correct" defaults — real-world dimensions so novices get
// sane results without measuring, while the numbers stay editable in Pro mode.
export const DEFAULTS = Object.freeze({
  wall:   { thickness: 0.12, height: 2.7 },          // 12 cm wall, 2.7 m ceiling
  door:   { width: 0.9,  height: 2.1, sill: 0.0 },    // standard interior door
  window: { width: 1.4,  height: 1.2, sill: 0.9 },    // sill 0.9 m off the floor
  roof:   { type: 'flat', thickness: 0.15, overhang: 0.3 },
  level:  { height: 2.7 },
});

// deterministic ids (stable within a session; good for tests + save files)
let _n = 0;
export function uid(prefix = 'id') { return `${prefix}_${(++_n).toString(36)}`; }
export function _resetIds() { _n = 0; } // test helper

// ---- factories -------------------------------------------------------------

export function createProject(opts = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: opts.name || 'Untitled home',
    units: opts.units || 'metric',          // display preference; storage is always meters
    site: opts.site || createSite(),
    materials: opts.materials || defaultMaterials(),
    levels: opts.levels || [],
    furniture: opts.furniture || [],
    meta: opts.meta || {},
  };
}

export function createSite(opts = {}) {
  return { width: opts.width ?? 16, depth: opts.depth ?? 14, material: opts.material || 'ground' };
}

export function createLevel(opts = {}) {
  return {
    id: opts.id || uid('lvl'),
    name: opts.name || 'Level',
    elevation: opts.elevation ?? 0,               // base height of this storey (m)
    height: opts.height ?? DEFAULTS.level.height,
    walls: opts.walls || [],
    openings: opts.openings || [],                // reference walls by id
    rooms: opts.rooms || [],
    roof: opts.roof || null,
  };
}

// wall centerline from point a to point b (plan coords {x,z})
export function createWall(a, b, opts = {}) {
  return {
    id: opts.id || uid('wall'),
    a: { x: a.x, z: a.z },
    b: { x: b.x, z: b.z },
    thickness: opts.thickness ?? DEFAULTS.wall.thickness,
    height: opts.height ?? DEFAULTS.wall.height,
    material: opts.material || 'wall',
  };
}

// opening (door/window) placed along a wall's length from endpoint a
export function createOpening(wallId, kind = 'door', opts = {}) {
  const d = kind === 'window' ? DEFAULTS.window : DEFAULTS.door;
  return {
    id: opts.id || uid(kind),
    wallId,
    kind,                                   // 'door' | 'window'
    offset: opts.offset ?? 0.6,             // distance from wall endpoint a to opening's near edge
    width: opts.width ?? d.width,
    height: opts.height ?? d.height,
    sill: opts.sill ?? d.sill,              // height of opening bottom off the floor
  };
}

// room floor as a plan polygon of {x,z} points (CCW)
export function createRoom(points, opts = {}) {
  return {
    id: opts.id || uid('room'),
    name: opts.name || 'Room',
    points: points.map(p => ({ x: p.x, z: p.z })),
    material: opts.material || 'floor',
  };
}

export function createRoof(opts = {}) {
  return {
    type: opts.type || DEFAULTS.roof.type,     // 'flat' (gable/hip come in a later phase)
    thickness: opts.thickness ?? DEFAULTS.roof.thickness,
    overhang: opts.overhang ?? DEFAULTS.roof.overhang,
    material: opts.material || 'roof',
  };
}

export function createFurniture(src, opts = {}) {
  return {
    id: opts.id || uid('furn'),
    name: opts.name || 'Object',
    src,                                    // GLB url or asset id (e.g. a Meshy export)
    levelId: opts.levelId || null,
    position: opts.position || { x: 0, z: 0 },   // plan position; y is auto-dropped to floor
    rotationY: opts.rotationY ?? 0,
    scale: opts.scale ?? 1,
  };
}

export function defaultMaterials() {
  return {
    wall:   { color: '#f3ece1', roughness: 0.9 },
    floor:  { color: '#b9a58c', roughness: 0.95 },
    roof:   { color: '#8d7f6f', roughness: 0.9 },
    ground: { color: '#cfc7ba', roughness: 1.0 },
    default:{ color: '#cccccc', roughness: 0.9 },
  };
}

// ---- geometry helpers on the data (still no Three.js) ----------------------

export function wallLength(wall) {
  return Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z);
}

export function projectCounts(project) {
  let walls = 0, openings = 0, rooms = 0;
  for (const lvl of project.levels) { walls += lvl.walls.length; openings += lvl.openings.length; rooms += lvl.rooms.length; }
  return { levels: project.levels.length, walls, openings, rooms, furniture: project.furniture.length };
}

// ---- lookups (used by the edit/command layer; still pure data) --------------

export function findLevel(project, levelId) {
  return project.levels.find(l => l.id === levelId) || null;
}
export function findWall(level, wallId) {
  return level ? level.walls.find(w => w.id === wallId) || null : null;
}
export function findOpening(level, openingId) {
  return level ? level.openings.find(o => o.id === openingId) || null : null;
}

// ---- validation ------------------------------------------------------------

export function validateProject(project) {
  const errors = [];
  if (!project || typeof project !== 'object') return { ok: false, errors: ['not an object'] };
  if (project.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion ${project.schemaVersion} != ${SCHEMA_VERSION}`);
  if (!Array.isArray(project.levels)) errors.push('levels must be an array');
  for (const lvl of project.levels || []) {
    const wallIds = new Set(lvl.walls.map(w => w.id));
    for (const w of lvl.walls) {
      if (!(w.thickness > 0)) errors.push(`wall ${w.id}: thickness must be > 0`);
      if (!(w.height > 0)) errors.push(`wall ${w.id}: height must be > 0`);
      if (wallLength(w) < 1e-4) errors.push(`wall ${w.id}: zero length`);
    }
    for (const o of lvl.openings) {
      if (!wallIds.has(o.wallId)) { errors.push(`opening ${o.id}: unknown wallId ${o.wallId}`); continue; }
      const w = lvl.walls.find(x => x.id === o.wallId);
      const L = wallLength(w);
      if (o.offset < 0 || o.offset + o.width > L + 1e-6) errors.push(`opening ${o.id}: doesn't fit on wall ${o.wallId} (offset ${o.offset} + width ${o.width} > ${L.toFixed(2)})`);
      if (o.sill + o.height > w.height + 1e-6) errors.push(`opening ${o.id}: taller than wall`);
    }
    for (const r of lvl.rooms) {
      if (!Array.isArray(r.points) || r.points.length < 3) errors.push(`room ${r.id}: needs >= 3 points`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---- save format (JSON) ----------------------------------------------------

export function serialize(project) {
  return JSON.stringify(project, null, 2);
}
export function deserialize(json) {
  const p = typeof json === 'string' ? JSON.parse(json) : json;
  // forward-compat hook: migrate older schema versions here as the model evolves
  return p;
}
