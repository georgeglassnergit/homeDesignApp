// D2 — "Outsource" onboarding path: compose a shareable DESIGN BRIEF.
//
// The second onboarding tile (after D1's "Import a plan") is "Outsource — have your home drawn
// for you". There is deliberately NO backend in this repo (constraint: never touch backend
// deploy config), so outsourcing here is a content/UX helper: it turns the in-app model plus a
// few optional intake fields into a plain-text brief a homeowner can hand — by email, print, or
// paste — to a professional designer to finish or redraw properly.
//
// This module is PURE core: it imports only model.js + units.js, no Three.js, mutates nothing,
// and adds no save field (the brief is derived on demand). All the shaping logic lives here so
// the DOM only has to collect fields and offer the download; the text is unit-tested headlessly.

import { projectCounts, projectFloorArea } from './model.js';
import { UNIT, formatArea } from './units.js';

// A conservative e-mail sanity check (NOT validation for delivery — there is no delivery). It
// only stops obviously malformed input from reaching the brief; an empty string is fine (the
// field is optional). Deliberately simple: one @, non-empty local part, a dotted domain.
export function isPlausibleEmail(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// One-line collapse: brief fields are single logical values, so newlines/tabs a user pastes in
// become spaces (a multi-line NOTES block is handled separately and keeps its lines).
function oneLine(str) { return String(str == null ? '' : str).replace(/\s+/g, ' ').trim(); }

// Normalize the free-form intake into a predictable shape. Every field is OPTIONAL — a brief can
// be generated from the model alone. `notes` keeps its paragraph structure (trimmed lines); the
// rest collapse to a single line. `email` is dropped (with a flag) if it can't plausibly be one,
// so a typo never rides silently into the brief as if it were a real address.
export function normalizeIntake(intake = {}) {
  const i = intake || {};
  const email = oneLine(i.email);
  const emailOk = email === '' || isPlausibleEmail(email);
  const notes = String(i.notes == null ? '' : i.notes)
    .split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').trim();
  return {
    name: oneLine(i.name),
    email: emailOk ? email : '',
    emailRejected: !emailOk,
    phone: oneLine(i.phone),
    style: oneLine(i.style),
    timeline: oneLine(i.timeline),
    notes,
  };
}

// YYYY-MM-DD from a Date (injectable in tests for determinism). UTC so the same instant always
// prints the same day regardless of the machine's timezone.
function isoDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// A filesystem-safe slug of the project name for the download filename; falls back to "home".
function slug(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'home';
}

// Build the design brief. Pure function of (project, intake, opts):
//   opts.units — UNIT.METRIC | UNIT.IMPERIAL (default metric); areas format to match.
//   opts.date  — injectable Date for a deterministic "Prepared" line (default: now).
// Returns { text, filename, subject, intake } — `intake` is the normalized echo (so the caller
// can surface e.g. a rejected e-mail). Never throws on a sparse/empty project.
export function buildOutsourceBrief(project, intake = {}, opts = {}) {
  const units = opts.units === UNIT.IMPERIAL ? UNIT.IMPERIAL : UNIT.METRIC;
  const p = project && Array.isArray(project.levels) ? project : { name: '', levels: [], furniture: [] };
  const norm = normalizeIntake(intake);
  const counts = projectCounts(p);
  const area = projectFloorArea(p);
  const name = oneLine(p.name) || 'Untitled home';
  const day = isoDay(opts.date || new Date());

  const L = [];
  L.push('HOME DESIGN BRIEF');
  L.push(`Project: ${name}`);
  if (day) L.push(`Prepared: ${day}`);
  L.push('Prepared with Home Design App');
  L.push('');

  // Contact — only the fields the homeowner filled in.
  const contact = [];
  if (norm.name) contact.push(`  Name:  ${norm.name}`);
  if (norm.email) contact.push(`  Email: ${norm.email}`);
  if (norm.phone) contact.push(`  Phone: ${norm.phone}`);
  if (contact.length) { L.push('CONTACT'); L.push(...contact); L.push(''); }

  // Project overview — the numbers straight off the model.
  L.push('PROJECT OVERVIEW');
  L.push(`  Storeys:            ${counts.levels}`);
  L.push(`  Rooms:              ${area.rooms}`);
  L.push(`  Gross floor area:   ${formatArea(area.total, units)}`);
  L.push(`  Walls:              ${counts.walls}`);
  L.push(`  Doors & windows:    ${counts.openings}`);
  L.push(`  Furniture placed:   ${counts.furniture}`);
  if (area.byLevel.length > 1) {
    L.push('');
    L.push('  Per storey:');
    for (const lvl of area.byLevel) {
      const rm = lvl.rooms === 1 ? '1 room' : `${lvl.rooms} rooms`;
      L.push(`    ${lvl.name} — ${formatArea(lvl.area, units)} (${rm})`);
    }
  }
  L.push('');

  // What the homeowner wants — their words, or a gentle prompt if they left it blank.
  L.push('WHAT I’D LIKE HELP WITH');
  if (norm.notes) {
    for (const line of norm.notes.split('\n')) L.push(line ? `  ${line}` : '');
  } else {
    L.push('  (Describe what you’d like a designer to help with — e.g. finish the');
    L.push('  layout, add detail, or redraw to scale.)');
  }
  if (norm.style || norm.timeline) {
    L.push('');
    if (norm.style) L.push(`  Preferred style:  ${norm.style}`);
    if (norm.timeline) L.push(`  Ideal timeline:   ${norm.timeline}`);
  }
  L.push('');

  // The honest footer — this is a homeowner's rough model, not a survey (guardrail #6).
  L.push('FOR THE DESIGNER');
  L.push('  This brief was generated from a rough model made in Home Design App, a');
  L.push('  design/visualization tool. The measurements are approximate homeowner');
  L.push('  estimates — not a surveyed, engineered, or construction-ready drawing.');

  const text = L.join('\n') + '\n';
  return { text, filename: `${slug(name)}-design-brief.txt`, subject: `Design brief — ${name}`, intake: norm };
}
