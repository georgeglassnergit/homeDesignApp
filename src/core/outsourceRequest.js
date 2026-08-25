// D2 · Outsource-drawing intake — build a shareable "project brief" from the live model.
//
// The second onboarding tile ("Outsource — have your home drawn for you") wires to a LOCAL,
// no-backend flow: we derive a plain-language summary of whatever the user has designed so far
// and let them copy/download it to hand to a drafting service of their choice. There is no
// upload, no API, no key (constraint #7) — this repo carries no backend, so D2 is content/UX
// only. The whole thing is DERIVED-ON-READ: it reads the model and returns new objects, never
// mutating the project and never adding a save field, so the Phase 1 lossless save is untouched
// (proven in the pure suite). No Three.js — pure `core/` (model + units helpers only).

import {
  projectCounts, projectFloorArea, polygonArea, polygonPerimeter, materialDef,
} from './model.js';
import { formatArea, formatLength, UNIT } from './units.js';

// The drafting depth the user is asking for. Advisory descriptions only — never a claim that
// the delivered drawings are code-compliant or engineer-stamped (constraint #6); that is the
// third party's responsibility, and the intake copy says so.
export const SERVICE_LEVELS = Object.freeze([
  Object.freeze({ id: 'concept',      label: 'Concept sketch',       desc: 'A tidied-up plan and 3D view from this design.' }),
  Object.freeze({ id: 'full-drawing', label: 'Full drawing set',     desc: 'Dimensioned floor plans and elevations for every storey.' }),
  Object.freeze({ id: 'permit-ready', label: 'Permit-ready package', desc: 'A drafter prepares submission drawings — they, not this tool, certify code compliance.' }),
]);

const SERVICE_BY_ID = new Map(SERVICE_LEVELS.map((s) => [s.id, s]));

export function isServiceLevel(id) { return SERVICE_BY_ID.has(id); }
export function serviceLevel(id) { return SERVICE_BY_ID.get(id) || null; }

// Human label for a material id — the project's own registered material carries no label, so we
// fall back to the curated library's label, then a title-cased id, then a generic word.
function materialLabel(id) {
  const def = materialDef(id);
  if (def && def.label) return def.label;
  if (typeof id === 'string' && id) {
    return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return 'Default';
}

// Distinct material ids actually referenced by the design (walls, rooms/floors, roofs), in
// first-seen order — what a drafter needs to know about finishes without dumping the whole map.
function materialsUsed(project) {
  const seen = [];
  const add = (id) => { if (id && !seen.includes(id)) seen.push(id); };
  for (const lvl of project.levels || []) {
    for (const w of lvl.walls || []) add(w.material);
    for (const r of lvl.rooms || []) add(r.material);
    if (lvl.roof && lvl.roof.material) add(lvl.roof.material);
  }
  return seen.map((id) => ({ id, label: materialLabel(id) }));
}

// Roof types present across storeys (e.g. ['gable','flat']), first-seen order. A storey with no
// roof contributes nothing. Lets the brief say "gable + flat roofs" without the geometry.
function roofTypesUsed(project) {
  const seen = [];
  for (const lvl of project.levels || []) {
    const t = lvl.roof && lvl.roof.type;
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen;
}

// buildProjectBrief(project, opts?) → a pure, serializable summary of the home for a drafter.
// Reuses the same derived-read helpers the inspector uses (projectCounts / projectFloorArea /
// polygonArea / polygonPerimeter), so the numbers match what the user already sees on screen.
// Never throws on a partial/empty project — an empty design yields a zeroed brief, not an error.
export function buildProjectBrief(project, opts = {}) {
  const src = project && typeof project === 'object' ? project : {};
  const units = opts.units || src.units || UNIT.METRIC;
  // Normalize defensively: a hand-built or partial project may have a level missing its
  // walls/openings/rooms arrays. Guarantee the arrays so the shared read helpers never throw.
  const p = {
    name: src.name,
    units: src.units,
    furniture: Array.isArray(src.furniture) ? src.furniture : [],
    levels: (Array.isArray(src.levels) ? src.levels : []).map((lvl) => ({
      name: lvl && lvl.name,
      roof: lvl && lvl.roof,
      walls: lvl && Array.isArray(lvl.walls) ? lvl.walls : [],
      openings: lvl && Array.isArray(lvl.openings) ? lvl.openings : [],
      rooms: lvl && Array.isArray(lvl.rooms) ? lvl.rooms : [],
    })),
  };
  const counts = projectCounts(p);
  const gfa = projectFloorArea(p);

  let doors = 0, windows = 0;
  for (const lvl of p.levels || []) {
    for (const o of lvl.openings || []) {
      if (o.kind === 'window') windows++; else doors++;
    }
  }

  const levels = (p.levels || []).map((lvl) => {
    const rooms = (lvl.rooms || []).map((r) => {
      const area = polygonArea(r.points);
      const perimeter = polygonPerimeter(r.points);
      return {
        name: r.name || 'Room',
        area, areaText: formatArea(area, units),
        perimeter, perimeterText: formatLength(perimeter, units),
      };
    });
    const area = rooms.reduce((s, r) => s + r.area, 0);
    return {
      name: lvl.name || 'Level',
      area, areaText: formatArea(area, units),
      rooms,
      roofType: (lvl.roof && lvl.roof.type) || null,
    };
  });

  return {
    name: p.name || 'Untitled home',
    units,
    home: {
      levels: counts.levels,
      rooms: counts.rooms,
      walls: counts.walls,
      openings: { total: counts.openings, doors, windows },
      furniture: counts.furniture,
      grossFloorArea: gfa.total,
      grossFloorAreaText: formatArea(gfa.total, units),
    },
    levels,
    materials: materialsUsed(p),
    roofTypes: roofTypesUsed(p),
  };
}

// formatBriefText(brief) → a plain-text, copy-pasteable brief a user can drop into an email to a
// drafting service. Deterministic (no timestamps), so it is safe to snapshot in tests.
export function formatBriefText(brief) {
  const b = brief || {};
  const home = b.home || {};
  const op = home.openings || {};
  const lines = [];
  lines.push(`Project: ${b.name || 'Untitled home'}`);
  lines.push(`Units: ${b.units === UNIT.IMPERIAL ? 'imperial (ft/in)' : 'metric (m)'}`);
  lines.push('');
  lines.push('Overview');
  lines.push(`  Storeys: ${home.levels || 0}`);
  lines.push(`  Rooms: ${home.rooms || 0}`);
  lines.push(`  Walls: ${home.walls || 0}`);
  lines.push(`  Doors: ${op.doors || 0}   Windows: ${op.windows || 0}`);
  lines.push(`  Furniture placed: ${home.furniture || 0}`);
  lines.push(`  Gross floor area: ${home.grossFloorAreaText || formatArea(0, b.units)}`);
  if (b.roofTypes && b.roofTypes.length) lines.push(`  Roof: ${b.roofTypes.join(', ')}`);
  if (b.materials && b.materials.length) lines.push(`  Finishes: ${b.materials.map((m) => m.label).join(', ')}`);
  for (const lvl of b.levels || []) {
    lines.push('');
    lines.push(`${lvl.name} — ${lvl.areaText}${lvl.roofType ? ` (${lvl.roofType} roof)` : ''}`);
    if (!lvl.rooms.length) lines.push('  (no rooms yet)');
    for (const r of lvl.rooms) lines.push(`  • ${r.name}: ${r.areaText}, ${r.perimeterText} perimeter`);
  }
  return lines.join('\n');
}

// The intake note shown in the UI and echoed into the request. This is a design tool, not a
// certifying authority (constraint #6): the outside drafter owns any code-compliance claim.
export const OUTSOURCE_DISCLAIMER =
  'This brief is a starting point generated from your design. Drawings are produced by a ' +
  'third-party drafter of your choice — this tool does not draw, submit, or certify them, and ' +
  'makes no code-compliance or engineering guarantee.';

// createOutsourceRequest(project, contact?, opts?) → a serializable request bundling the derived
// brief with the user's contact + chosen service + notes. `opts.createdAt` is passed in (never
// generated here) so the result stays deterministic for tests; the UI supplies a real timestamp.
export function createOutsourceRequest(project, contact = {}, opts = {}) {
  const service = isServiceLevel(opts.service) ? opts.service : SERVICE_LEVELS[0].id;
  return {
    kind: 'outsource-request',
    createdAt: opts.createdAt != null ? opts.createdAt : null,
    service,
    contact: {
      name: (contact.name || '').trim(),
      email: (contact.email || '').trim(),
      notes: (contact.notes || '').trim(),
    },
    disclaimer: OUTSOURCE_DISCLAIMER,
    brief: buildProjectBrief(project, opts),
  };
}

// validateOutsourceRequest(req) → { ok, errors[] }. A request needs some way to reach the user
// (name or email) and a real service level. Pure predicate — no side effects, never throws.
export function validateOutsourceRequest(req) {
  const errors = [];
  const r = req && typeof req === 'object' ? req : {};
  const c = r.contact || {};
  if (!c.name && !c.email) errors.push('Add your name or email so the drafter can reach you.');
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) errors.push('That email address looks off.');
  if (!isServiceLevel(r.service)) errors.push('Pick a service level.');
  return { ok: errors.length === 0, errors };
}

// outsourceRequestJson(req) → pretty JSON for a downloadable .json the user can attach.
export function outsourceRequestJson(req) {
  return JSON.stringify(req, null, 2);
}
