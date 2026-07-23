// app/inspector.js — the selection inspector as PURE data (engine-free + DOM-free).
// This is where the Simple/Pro seam finally becomes visible to the user: given the plain
// Project and the current selection, describeSelection() returns a descriptor of the object's
// editable dimensions. In Simple mode the fields are read-only (a novice-friendly measurement
// readout, formatted per the display units); in Pro mode they become exact-entry inputs that
// parse feet-and-inches / metric via units.js. main.js renders this descriptor to DOM and
// dispatches the edit through history; the Node test suite asserts on the descriptor + command
// directly. ZERO Three.js and ZERO DOM in here (importing under Node is the separation guard).
import { findWall, findOpening, findRoom, wallLength } from '../core/model.js';
import { isAvailable, MODE } from './state.js';
import { formatLength, parseLength, UNIT } from '../core/units.js';
import { resizeWall, resizeOpening } from '../edit/commands.js';
import { describeRoom } from '../core/roomMeasure.js';

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
// Returns null when nothing editable is selected (empty selection, or a room/floor — room
// editing is a later phase). `editable` reflects the Simple/Pro seam via isAvailable().
export function describeSelection(project, selection, { mode = MODE.SIMPLE, units = UNIT.METRIC } = {}) {
  const loc = locate(project, selection);
  if (!loc) return null;
  // A room is a read-only MEASUREMENT readout (floor area + perimeter derived from its
  // polygon) — there are no exact-entry inputs to edit here, in Simple OR Pro, so the
  // Simple/Pro seam doesn't apply. `measurement: true` tells the UI to show the neutral
  // footer instead of the "switch to Pro" hint. No model fields, no command: pure derived.
  if (loc.kind === 'room') {
    const m = describeRoom(loc.room, units);
    if (!m) return null;
    return {
      title: m.name, type: 'room', id: selection.id, editable: false, measurement: true,
      fields: [
        { key: 'area',      label: 'Floor area', text: m.areaLabel },
        { key: 'perimeter', label: 'Perimeter',  text: m.perimeterLabel },
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
  const meters = parseLength(rawValue, units);
  if (!isFinite(meters)) return { error: `Couldn't read "${rawValue}"` };
  if (POSITIVE_FIELDS.has(key) && !(meters > 0)) return { error: `${key} must be greater than 0` };
  if (NONNEG_FIELDS.has(key) && meters < 0) return { error: `${key} can't be negative` };
  const command = loc.kind === 'wall'
    ? resizeWall(loc.level.id, selection.id, { [key]: meters })
    : resizeOpening(loc.level.id, selection.id, { [key]: meters });
  return { command, meters: round(meters) };
}
