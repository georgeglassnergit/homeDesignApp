// app/inspector.js — the selection inspector as PURE data (engine-free + DOM-free).
// This is where the Simple/Pro seam finally becomes visible to the user: given the plain
// Project and the current selection, describeSelection() returns a descriptor of the object's
// editable dimensions. In Simple mode the fields are read-only (a novice-friendly measurement
// readout, formatted per the display units); in Pro mode they become exact-entry inputs that
// parse feet-and-inches / metric via units.js. main.js renders this descriptor to DOM and
// dispatches the edit through history; the Node test suite asserts on the descriptor + command
// directly. ZERO Three.js and ZERO DOM in here (importing under Node is the separation guard).
import { findWall, findOpening, findRoom, wallLength, polygonArea, polygonPerimeter } from '../core/model.js';
import { isAvailable, MODE } from './state.js';
import { formatLength, formatArea, parseLength, UNIT } from '../core/units.js';
import { resizeWall, resizeOpening } from '../edit/commands.js';

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
      editable: false,           // a measurement readout, not an input, in Simple AND Pro
      hint: 'Floor area updates automatically as you edit the room',
      fields: [
        { key: 'area',      label: 'Floor area', sqm: round(area),        text: formatArea(area, units) },
        { key: 'perimeter', label: 'Perimeter',  meters: round(perimeter), text: formatLength(perimeter, units) },
      ],
    };
  }
  const editable = isAvailable('exact-dimensions', mode);
  let title, fields;
  if (loc.kind === 'wall') {
    const w = loc.wall;
    title = 'Wall';
    fields = [
      { key: 'length',    label: 'Length',    meters: round(wallLength(w)) },
      { key: 'thickness', label: 'Thickness', meters: round(w.thickness) },
      { key: 'height',    label: 'Height',    meters: round(w.height) },
    ];
  } else {
    const o = loc.opening;
    title = o.kind === 'window' ? 'Window' : 'Door';
    fields = [
      { key: 'width',  label: 'Width',  meters: round(o.width) },
      { key: 'height', label: 'Height', meters: round(o.height) },
      { key: 'sill',   label: 'Sill',   meters: round(o.sill) },
      { key: 'offset', label: 'Offset', meters: round(o.offset) },
    ];
  }
  for (const f of fields) f.text = formatLength(f.meters, units);
  return { title, type: loc.kind === 'wall' ? 'wall' : loc.opening.kind, id: selection.id, editable, fields };
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
