// app/inspector.js — the selection inspector as PURE data (engine-free + DOM-free).
// This is where the Simple/Pro seam finally becomes visible to the user: given the plain
// Project and the current selection, describeSelection() returns a descriptor of the object's
// editable dimensions. In Simple mode the fields are read-only (a novice-friendly measurement
// readout, formatted per the display units); in Pro mode they become exact-entry inputs that
// parse feet-and-inches / metric via units.js. main.js renders this descriptor to DOM and
// dispatches the edit through history; the Node test suite asserts on the descriptor + command
// directly. ZERO Three.js and ZERO DOM in here (importing under Node is the separation guard).
import { findWall, findOpening, findRoom, wallLength, polygonArea, polygonPerimeter, projectFloorArea, MATERIAL_LIBRARY, materialDef, isLibraryMaterial } from '../core/model.js';
import { isAvailable, MODE } from './state.js';
import { formatLength, formatArea, parseLength, UNIT } from '../core/units.js';
import { resizeWall, resizeOpening, renameRoom, setElementLabel, setElementMaterial } from '../edit/commands.js';

// Longest room name we accept — long enough for "Master bedroom / ensuite", short enough that
// the label never overruns the inspector or a plan-canvas chip. Enforced in buildRoomRename.
export const MAX_ROOM_NAME = 40;
// Longest wall/opening label we accept (A3). Same cap as a room name so the seam feels uniform
// and no label can overrun the inspector title. Enforced in buildElementLabel.
export const MAX_ELEMENT_LABEL = 40;

// Locate the level + object a selection {kind,id} refers to, scanning every level so the
// inspector works in multi-level projects (the model already supports them).
function locate(project, selection) {
  if (!project || !selection || !selection.id) return null;
  for (const lvl of project.levels || []) {
    if (selection.kind === 'wall') {
      const w = findWall(lvl, selection.id);
      if (w) return { level: lvl, kind: 'wall', wall: w };
    } else if (selection.kind === 'room') {
      const r = findRoom(lvl, selection.id);
      if (r) return { level: lvl, kind: 'room', room: r };
    } else {
      const o = findOpening(lvl, selection.id);
      if (o) return { level: lvl, kind: 'opening', opening: o };
    }
  }
  return null;
}

// snap storage precision so display/round-trip stays clean (meters kept to the micron)
const round = (m) => Math.round(m * 1e6) / 1e6;

// Friendly names for the base material roles the model ships with (defaultMaterials()), so a
// wall/floor that still uses its role default reads clearly in the swatch list rather than as
// a bare key. Any other id (a library finish) carries its own label from the catalog.
const ROLE_LABELS = Object.freeze({
  wall: 'Wall (default)', floor: 'Floor (default)', roof: 'Roof (default)', ground: 'Ground', default: 'Default',
});

// Build the E1 `materials-swatch` slot for an element that carries a `material` key (a wall or a
// room's floor). Returns a descriptor of the finish palette — the current finish + a swatch list
// (the library, with the current finish guaranteed present even when it's a base role not in the
// catalog) — or null when the seam is unavailable. Pure data: no command, no Three.js; picking a
// swatch commits setElementMaterial via buildSetMaterial. `materials-swatch` is a Simple-tier row,
// so this is a novice-visible affordance available in both modes.
function materialsSlot(project, el, mode) {
  if (!el || !isAvailable('materials-swatch', mode)) return null;
  const defs = (project && project.materials) || {};
  const colorOf = (id) => (defs[id] && defs[id].color) || (materialDef(id) && materialDef(id).color) || '#cccccc';
  const current = el.material;
  const options = MATERIAL_LIBRARY.map((m) => ({ id: m.id, label: m.label, color: m.color }));
  // Keep the current finish selectable/visible even if it's a base role (or a bespoke saved
  // material) that isn't in the library — prepend it so a swatch always reflects "what's on now".
  if (!isLibraryMaterial(current) && !options.some((o) => o.id === current)) {
    options.unshift({ id: current, label: ROLE_LABELS[current] || current, color: colorOf(current) });
  }
  return { key: 'material', label: 'Material', current, currentColor: colorOf(current), options };
}

// Which fields must stay strictly positive vs. merely non-negative (used by the edit guard).
export const POSITIVE_FIELDS = Object.freeze(new Set(['length', 'thickness', 'height', 'width']));
export const NONNEG_FIELDS = Object.freeze(new Set(['sill', 'offset']));

// Describe the current selection's editable dimensions.
// Returns null when nothing is selected (empty selection or an object with no readout).
// Walls/openings carry editable dimensions gated by the Simple/Pro seam (isAvailable).
// A selected room returns a READ-ONLY floor-area + perimeter readout — a novice-friendly
// measurement (available in both tiers, computed from the room polygon, never an input),
// so it carries no command and can never touch the Phase 1 save contract.
export function describeSelection(project, selection, { mode = MODE.SIMPLE, units = UNIT.METRIC } = {}) {
  const loc = locate(project, selection);
  if (!loc) return null;
  if (loc.kind === 'room') {
    const area = polygonArea(loc.room.points);
    const perimeter = polygonPerimeter(loc.room.points);
    return {
      title: loc.room.name || 'Room',
      type: 'room',
      id: selection.id,
      editable: false,           // the area/perimeter fields are a measurement readout, never inputs
      // The room's NAME, however, is editable in Pro (novice Simple keeps a clean read-only card).
      // This is a separate text edit from the numeric dimension fields — it commits a renameRoom
      // command, not a parsed length — so it's carried in its own `rename` slot, gated by the seam.
      rename: isAvailable('room-rename', mode)
        ? { key: 'name', label: 'Name', value: loc.room.name || 'Room' }
        : null,
      // The floor's finish is editable in both tiers via the materials swatch (E1). Selecting a
      // swatch commits setElementMaterial (an undoable, lossless material change), never an input.
      materials: materialsSlot(project, loc.room, mode),
      hint: isAvailable('room-rename', mode)
        ? 'Rename the room above; floor area updates automatically as you edit it'
        : 'Floor area updates automatically as you edit the room',
      fields: [
        { key: 'area',      label: 'Floor area', sqm: round(area),        text: formatArea(area, units) },
        { key: 'perimeter', label: 'Perimeter',  meters: round(perimeter), text: formatLength(perimeter, units) },
      ],
    };
  }
  const editable = isAvailable('exact-dimensions', mode);
  let title, fields;
  // The element's default type name (used as the title when no label is set) and its current
  // optional label. A wall/opening carries a `label` only once a Pro user names it (A3); the
  // title shows the label when present so a named element reads by its name, exactly like a room.
  let typeName;
  if (loc.kind === 'wall') {
    const w = loc.wall;
    typeName = 'Wall';
    fields = [
      { key: 'length',    label: 'Length',    meters: round(wallLength(w)) },
      { key: 'thickness', label: 'Thickness', meters: round(w.thickness) },
      { key: 'height',    label: 'Height',    meters: round(w.height) },
    ];
  } else {
    const o = loc.opening;
    typeName = o.kind === 'window' ? 'Window' : 'Door';
    fields = [
      { key: 'width',  label: 'Width',  meters: round(o.width) },
      { key: 'height', label: 'Height', meters: round(o.height) },
      { key: 'sill',   label: 'Sill',   meters: round(o.sill) },
      { key: 'offset', label: 'Offset', meters: round(o.offset) },
    ];
  }
  const el = loc.kind === 'wall' ? loc.wall : loc.opening;
  const currentLabel = typeof el.label === 'string' ? el.label : '';
  title = currentLabel || typeName;
  for (const f of fields) f.text = formatLength(f.meters, units);
  // A wall/opening in Pro carries a `rename` slot — an optional free-text LABEL — mirroring the
  // room-rename seam. It commits a setElementLabel command (not a parsed length), so it rides in
  // the same `rename` slot the inspector already renders. Simple keeps the clean read-only card.
  // Empty is allowed here (unlike a room name) because clearing the field removes the label.
  const rename = isAvailable('element-label', mode)
    ? { key: 'label', label: 'Label', value: currentLabel, placeholder: `Name this ${typeName.toLowerCase()} (optional)` }
    : null;
  // A wall carries a material finish (E1 swatch); an opening (door/window) is a void cut into the
  // wall, not a rendered surface, so it has no material slot.
  const materials = loc.kind === 'wall' ? materialsSlot(project, loc.wall, mode) : null;
  return { title, type: loc.kind === 'wall' ? 'wall' : loc.opening.kind, id: selection.id, editable, rename, materials, fields };
}

// Describe the whole-home floor-area summary shown when nothing is selected (the inspector's
// otherwise-dead empty state). A READ-ONLY overview — total gross floor area, a per-storey
// breakdown when the home has more than one storey, and the room count — formatted per the
// display-units toggle. Available in BOTH tiers (novice-first): it answers "how big is my
// house?" from the data, carries no command, stores nothing, and never touches the save
// contract. Returns a descriptor shaped like describeSelection's read-only case so main.js
// renders it with the same row template. When there are no rooms yet, the hint invites the
// user to draw one instead of dwelling on a bare 0.
export function describeHomeSummary(project, { units = UNIT.METRIC } = {}) {
  if (!project || !Array.isArray(project.levels)) return null;
  const gfa = projectFloorArea(project);
  const fields = [
    { key: 'total-area', label: 'Total floor area', sqm: round(gfa.total), text: formatArea(gfa.total, units) },
  ];
  // per-storey breakdown only when it adds information (a single storey === the total)
  if (gfa.levels > 1) {
    for (const l of gfa.byLevel) {
      fields.push({ key: `level-${l.id}`, label: l.name, sqm: round(l.area), text: formatArea(l.area, units) });
    }
  }
  fields.push({ key: 'rooms', label: gfa.levels > 1 ? 'Rooms · storeys' : 'Rooms', count: gfa.rooms,
    text: gfa.levels > 1 ? `${gfa.rooms} · ${gfa.levels}` : String(gfa.rooms) });
  return {
    title: project.name || 'Home',
    type: 'home',
    editable: false,
    hint: gfa.rooms === 0
      ? 'Draw a room to start measuring your home'
      : 'Click a wall, opening or room to edit it',
    fields,
  };
}

// Build the undoable command for a single dimension edit. Returns { command, meters } on
// success, or { error } if the raw input can't be parsed or is out of range for the field.
// The caller runs the command through history, re-validates the whole project (which enforces
// opening-fits-on-wall etc.), and rolls the command back on validation failure.
export function buildDimensionEdit(project, selection, key, rawValue, { units = UNIT.METRIC } = {}) {
  const loc = locate(project, selection);
  if (!loc) return { error: 'Nothing selected' };
  // A room is a read-only measurement readout — its area/perimeter are computed, never typed,
  // so there is no dimension command to build (guards against a bogus edit to a room selection).
  if (loc.kind === 'room') return { error: 'Room measurements are read-only' };
  const meters = parseLength(rawValue, units);
  if (!isFinite(meters)) return { error: `Couldn't read "${rawValue}"` };
  if (POSITIVE_FIELDS.has(key) && !(meters > 0)) return { error: `${key} must be greater than 0` };
  if (NONNEG_FIELDS.has(key) && meters < 0) return { error: `${key} can't be negative` };
  const command = loc.kind === 'wall'
    ? resizeWall(loc.level.id, selection.id, { [key]: meters })
    : resizeOpening(loc.level.id, selection.id, { [key]: meters });
  return { command, meters: round(meters) };
}

// Build the undoable command for a room-name edit (the Pro-seam room-rename). Returns
// { command, name } on success, { unchanged: true } when the trimmed name equals the current
// one (so the caller skips a no-op history push — e.g. a blur that didn't change anything), or
// { error } when the selection isn't a room or the name is empty. The name is trimmed, collapsed
// of runs of whitespace, and capped at MAX_ROOM_NAME so a label can't overrun the UI. Renaming
// only rewrites the room's existing `name` field, so it never touches the save schema.
export function buildRoomRename(project, selection, rawValue) {
  const loc = locate(project, selection);
  if (!loc || loc.kind !== 'room') return { error: 'Select a room to rename' };
  const name = String(rawValue ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ROOM_NAME);
  if (!name) return { error: 'Name can’t be empty' };
  if (name === loc.room.name) return { unchanged: true };
  return { command: renameRoom(loc.level.id, selection.id, name), name };
}

// Build the undoable command for a wall/opening label edit (the A3 Pro-seam element-label).
// Mirrors buildRoomRename but for the OPTIONAL `label` field: an empty input is legal — it
// clears the label (removing the key) — so this returns { command } for both set and clear,
// { unchanged: true } when the trimmed input equals the element's current label (or both are
// empty, so a blur that changed nothing pushes no history), and { error } only when the
// selection isn't a wall/opening. The text is trimmed, whitespace-collapsed, and capped at
// MAX_ELEMENT_LABEL so a label can't overrun the inspector title.
export function buildElementLabel(project, selection, rawValue) {
  const loc = locate(project, selection);
  if (!loc || (loc.kind !== 'wall' && loc.kind !== 'opening')) return { error: 'Select a wall or opening to label' };
  const el = loc.kind === 'wall' ? loc.wall : loc.opening;
  const current = typeof el.label === 'string' ? el.label : '';
  const label = String(rawValue ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ELEMENT_LABEL);
  if (label === current) return { unchanged: true };
  return { command: setElementLabel(loc.level.id, loc.kind, selection.id, label), label };
}

// Build the undoable command for applying a material finish (the E1 materials-swatch seam).
// Applies to a selected wall or room (floor); returns { command, materialId } on success,
// { unchanged: true } when the finish already applied (so a re-click pushes no history), and
// { error } when the selection can't take a material or the id is neither a library finish nor
// an id already present in the project's materials (guards against setting a phantom key). The
// command repoints the element's EXISTING `material` field, so it never touches the save schema.
export function buildSetMaterial(project, selection, materialId) {
  const loc = locate(project, selection);
  if (!loc || (loc.kind !== 'wall' && loc.kind !== 'room')) return { error: 'Select a wall or floor to apply a material' };
  const el = loc.kind === 'wall' ? loc.wall : loc.room;
  const known = isLibraryMaterial(materialId)
    || Object.prototype.hasOwnProperty.call((project && project.materials) || {}, materialId);
  if (!known) return { error: `Unknown material "${materialId}"` };
  if (materialId === el.material) return { unchanged: true };
  // Pass the catalog def so the command can register a library finish on first use; a base role
  // (or an already-saved material) has no library def and is already resolvable, so def is null.
  const def = materialDef(materialId);
  return { command: setElementMaterial(loc.level.id, loc.kind, selection.id, materialId, def), materialId };
}
