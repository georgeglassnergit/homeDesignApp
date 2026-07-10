// core/model.js — pure, JSON-serializable whole-home model. ZERO Three.js.
// This is the save file. The builder/viewer are the only code that touches the engine.
// Reconstructed to the Phase 1 architecture contract (platform/PHASE-1-ARCHITECTURE.md).

export const SCHEMA_VERSION = 1;

// "Approachable but correct" defaults — one place. Real-world meters, +Y up.
export const DEFAULTS = Object.freeze({
  wallThickness: 0.12,   // 12 cm
  wallHeight: 2.7,       // 2.7 m ceiling
  levelHeight: 2.7,
  door:   { width: 0.9, height: 2.1, sill: 0.0 },
  window: { width: 1.4, height: 1.2, sill: 0.9 },
  roof:   { type: 'flat', thickness: 0.2, overhang: 0.3 },
});

export const DEFAULT_MATERIALS = Object.freeze({
  wall:   { id: 'wall',   color: '#e8e6e1' },
  floor:  { id: 'floor',  color: '#b8916a' },
  roof:   { id: 'roof',   color: '#4a4f57' },
  ground: { id: 'ground', color: '#cfd6cf' },
});

// --- id generation (stable once stored in the model) ---
let _seq = 0;
export function uid(prefix = 'id') {
  _seq += 1;
  return `${prefix}_${_seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
export function _resetSeq(n = 0) { _seq = n; } // test hook

// --- geometry helpers (pure) ---
export function wallLength(w) {
  const dx = w.b.x - w.a.x, dz = w.b.z - w.a.z;
  return Math.hypot(dx, dz);
}

// --- constructors ---
export function createLevel(opts = {}) {
  return {
    id: opts.id || uid('lvl'),
    elevation: opts.elevation ?? 0,
    height: opts.height ?? DEFAULTS.levelHeight,
    walls: [], openings: [], rooms: [],
    roof: opts.roof ? { ...DEFAULTS.roof, ...opts.roof } : null,
  };
}

export function createProject(opts = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: opts.name || 'Untitled Home',
    units: opts.units || 'metric',
    site: opts.site || { width: 20, depth: 20, material: 'ground' },
    materials: opts.materials || JSON.parse(JSON.stringify(DEFAULT_MATERIALS)),
    levels: opts.levels || [createLevel()],
    furniture: opts.furniture || [],
  };
}

export function makeWall(a, b, opts = {}) {
  return {
    id: opts.id || uid('wall'),
    a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z },
    thickness: opts.thickness ?? DEFAULTS.wallThickness,
    height: opts.height ?? DEFAULTS.wallHeight,
    material: opts.material || 'wall',
  };
}

export function makeOpening(wallId, kind, offset, opts = {}) {
  const d = kind === 'door' ? DEFAULTS.door : DEFAULTS.window;
  return {
    id: opts.id || uid('op'),
    wallId, kind, offset,
    width: opts.width ?? d.width,
    height: opts.height ?? d.height,
    sill: opts.sill ?? d.sill,
  };
}

// --- lookups ---
export function findLevel(project, levelId) { return project.levels.find(l => l.id === levelId) || null; }
export function findWall(level, wallId) { return level.walls.find(w => w.id === wallId) || null; }

// --- validation ---
export function validateProject(project) {
  const errors = [];
  if (!project || typeof project !== 'object') return { ok: false, errors: ['project is not an object'] };
  if (project.schemaVersion !== SCHEMA_VERSION) errors.push(`unexpected schemaVersion ${project.schemaVersion}`);
  if (!Array.isArray(project.levels) || project.levels.length === 0) errors.push('project has no levels');

  for (const level of project.levels || []) {
    const wallById = new Map();
    for (const w of level.walls || []) {
      wallById.set(w.id, w);
      if (wallLength(w) <= 1e-6) errors.push(`wall ${w.id}: zero-length`);
      if (!(w.thickness > 0)) errors.push(`wall ${w.id}: non-positive thickness`);
      if (!(w.height > 0)) errors.push(`wall ${w.id}: non-positive height`);
    }
    for (const o of level.openings || []) {
      const w = wallById.get(o.wallId);
      if (!w) { errors.push(`opening ${o.id}: references missing wall ${o.wallId}`); continue; }
      if (!(o.width > 0)) errors.push(`opening ${o.id}: non-positive width`);
      if (!(o.height > 0)) errors.push(`opening ${o.id}: non-positive height`);
      const len = wallLength(w), half = o.width / 2;
      if (o.offset - half < -1e-9 || o.offset + half > len + 1e-9)
        errors.push(`opening ${o.id}: does not fit within wall ${w.id} (len ${len.toFixed(3)}m)`);
      if ((o.sill ?? 0) + o.height > w.height + 1e-9)
        errors.push(`opening ${o.id}: sill+height exceeds wall height`);
    }
    for (const r of level.rooms || [])
      if (!Array.isArray(r.points) || r.points.length < 3) errors.push(`room ${r.id}: needs >= 3 points`);
  }
  return { ok: errors.length === 0, errors };
}

// --- save format: the project IS the save file ---
export function serialize(project) { return JSON.stringify(project, null, 2); }

function migrate(obj) {
  if (obj.schemaVersion == null) obj.schemaVersion = SCHEMA_VERSION; // v0 -> v1 slot
  return obj;
}
export function deserialize(text) {
  const obj = typeof text === 'string' ? JSON.parse(text) : text;
  return migrate(obj);
}
