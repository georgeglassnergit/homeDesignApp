// ============================================================================
// Schedule / quantities takeoff — engine-independent, computed on read (no Three.js).
//
// Rounds out the export family (OBJ / glTF / DXF / JSON in core/export*.js) with the
// one thing a real home designer reaches for that none of them give: a flat,
// spreadsheet-shaped SCHEDULE of the design —
//   • a room schedule  (level · name · floor area · perimeter · finish)
//   • an opening schedule (level · door/window · host wall · size · sill)
//   • a wall takeoff per storey (count · running length · gross wall face area,
//     openings deducted → the net area a paint/plaster/cladding estimate wants)
//   • a summary (storeys, GFA, room/door/window counts, running wall length, net area)
// and a CSV rendering of all four that opens in Excel / Numbers / Sheets / LibreCAD.
//
// ── HONESTY (constraint #6 in docs/PHASE-3-PLAN.md) ──────────────────────────
// This is a DESIGN / VISUALISATION tool, NOT a quantity surveyor. These numbers
// are APPROXIMATE quantities derived from the rough plan model — they are never a
// certified take-off, a bill of quantities, or a construction/procurement spec.
// Every consumer MUST surface `SCHEDULE_DISCLAIMER`. Gross wall face area is a
// single-face elevation area (length × height) with opening areas deducted; it is
// not a two-face drywall count, a stud count, or a waste-factored order quantity.
//
// Purity / save contract: this module only READS the model (levels, walls,
// openings, rooms) through the pure model helpers and returns plain data. It
// stores nothing, mutates nothing, issues no command, and adds no save field — so
// it cannot touch the Phase 1 lossless save (proven in src/test/schedule.test.mjs).
// It imports only pure model helpers; there is no Three.js here.
// ============================================================================

import { wallLength, polygonArea, polygonPerimeter } from './model.js';

// The label every consumer must show near a schedule. Plain-language, not legalese.
export const SCHEDULE_DISCLAIMER =
  'Approximate quantities from your design model — not a certified take-off, ' +
  'bill of quantities, or construction spec. Confirm every figure before ordering ' +
  'materials or pricing work.';

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
const num = (n) => (Number.isFinite(n) ? n : 0);

// A level's display name, tolerant of a bare/partial level object.
function levelName(level, index) {
  return (level && (level.name || level.id)) || `Level ${index + 1}`;
}

// ── the schedule as structured data ─────────────────────────────────────────
//
// buildSchedule(project) → { project, rooms[], openings[], wallsByLevel[], summary }
// Every measurement is in the model's native units (metres / m²). Per-row values are
// rounded to 2 dp for presentation; summary totals sum the RAW values first, then round
// once — so a total never drifts from re-rounding its parts.
export function buildSchedule(project) {
  const levels = project && Array.isArray(project.levels) ? project.levels : [];

  const rooms = [];
  const openings = [];
  const wallsByLevel = [];

  // raw running totals (round only at the end)
  let totFloor = 0, totWallLen = 0, totGross = 0, totOpening = 0;
  let nRooms = 0, nWalls = 0, nDoors = 0, nWindows = 0;

  for (let li = 0; li < levels.length; li++) {
    const lvl = levels[li] || {};
    const name = levelName(lvl, li);
    const lvlWalls = Array.isArray(lvl.walls) ? lvl.walls : [];
    const lvlOpenings = Array.isArray(lvl.openings) ? lvl.openings : [];
    const lvlRooms = Array.isArray(lvl.rooms) ? lvl.rooms : [];

    // rooms
    for (const r of lvlRooms) {
      const area = polygonArea(r.points);
      const per = polygonPerimeter(r.points);
      totFloor += area;
      nRooms++;
      rooms.push({
        level: name,
        name: r.name || 'Room',
        area: round2(area),
        perimeter: round2(per),
        material: r.material || '',
      });
    }

    // openings + this level's opening-area deduction
    let lvlOpeningArea = 0;
    for (const o of lvlOpenings) {
      const w = num(o.width), h = num(o.height);
      const area = w * h;
      lvlOpeningArea += area;
      if (o.kind === 'window') nWindows++; else nDoors++;
      openings.push({
        level: name,
        kind: o.kind === 'window' ? 'window' : 'door',
        wall: o.wallId || '',
        width: round2(w),
        height: round2(h),
        area: round2(area),
        sill: round2(num(o.sill)),
      });
    }

    // wall take-off for this storey
    let lvlLen = 0, lvlGross = 0, lvlHeightLen = 0;
    for (const w of lvlWalls) {
      const len = wallLength(w);
      const ht = num(w.height);
      lvlLen += len;
      lvlGross += len * ht;
      lvlHeightLen += len * ht; // for length-weighted mean height
    }
    // net wall face area never goes negative even if a level is over-glazed in the model
    const lvlNet = Math.max(0, lvlGross - lvlOpeningArea);
    const avgHeight = lvlLen > 0 ? lvlHeightLen / lvlLen : 0;

    nWalls += lvlWalls.length;
    totWallLen += lvlLen;
    totGross += lvlGross;
    totOpening += lvlOpeningArea;

    wallsByLevel.push({
      level: name,
      count: lvlWalls.length,
      totalLength: round2(lvlLen),
      avgHeight: round2(avgHeight),
      grossWallArea: round2(lvlGross),
      openingArea: round2(lvlOpeningArea),
      netWallArea: round2(lvlNet),
    });
  }

  const summary = {
    levels: levels.length,
    rooms: nRooms,
    doors: nDoors,
    windows: nWindows,
    openings: nDoors + nWindows,
    walls: nWalls,
    floorArea: round2(totFloor),
    totalWallLength: round2(totWallLen),
    grossWallArea: round2(totGross),
    openingArea: round2(totOpening),
    netWallArea: round2(Math.max(0, totGross - totOpening)),
  };

  return {
    project: (project && project.name) || 'Untitled home',
    disclaimer: SCHEDULE_DISCLAIMER,
    rooms,
    openings,
    wallsByLevel,
    summary,
  };
}

// ── CSV rendering ────────────────────────────────────────────────────────────

// RFC-4180-ish field escape: quote a field that contains a comma, quote, CR or LF, and
// double any embedded quote. Numbers/blanks pass through untouched. Keeps the CSV robust
// when a room or level is named e.g. `Kitchen, open-plan` or `Bob's "study"`.
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells) => cells.map(csvField).join(',');

// buildSchedule result → a single sectioned CSV string (Summary · Rooms · Openings ·
// Walls by level). Sections are separated by a blank line and led by a title cell so the
// one file opens cleanly in any spreadsheet. Line terminator is CRLF (Excel-friendly).
export function scheduleToCsv(schedule) {
  const s = schedule && schedule.summary ? schedule : buildSchedule(schedule);
  const lines = [];

  lines.push(row([`Roomclip schedule — ${s.project}`]));
  lines.push(row([s.disclaimer || SCHEDULE_DISCLAIMER]));
  lines.push('');

  lines.push(row(['Summary']));
  lines.push(row(['Metric', 'Value', 'Unit']));
  lines.push(row(['Storeys', s.summary.levels, '']));
  lines.push(row(['Rooms', s.summary.rooms, '']));
  lines.push(row(['Doors', s.summary.doors, '']));
  lines.push(row(['Windows', s.summary.windows, '']));
  lines.push(row(['Walls', s.summary.walls, '']));
  lines.push(row(['Floor area (GFA)', s.summary.floorArea, 'm²']));
  lines.push(row(['Total wall length', s.summary.totalWallLength, 'm']));
  lines.push(row(['Gross wall area (1 face)', s.summary.grossWallArea, 'm²']));
  lines.push(row(['Openings area', s.summary.openingArea, 'm²']));
  lines.push(row(['Net wall area', s.summary.netWallArea, 'm²']));
  lines.push('');

  lines.push(row(['Rooms']));
  lines.push(row(['Level', 'Room', 'Floor area (m²)', 'Perimeter (m)', 'Finish']));
  for (const r of s.rooms) lines.push(row([r.level, r.name, r.area, r.perimeter, r.material]));
  lines.push('');

  lines.push(row(['Openings']));
  lines.push(row(['Level', 'Type', 'Host wall', 'Width (m)', 'Height (m)', 'Area (m²)', 'Sill (m)']));
  for (const o of s.openings) lines.push(row([o.level, o.kind, o.wall, o.width, o.height, o.area, o.sill]));
  lines.push('');

  lines.push(row(['Walls by level']));
  lines.push(row(['Level', 'Walls', 'Total length (m)', 'Avg height (m)', 'Gross wall area (m²)', 'Openings area (m²)', 'Net wall area (m²)']));
  for (const w of s.wallsByLevel) {
    lines.push(row([w.level, w.count, w.totalLength, w.avgHeight, w.grossWallArea, w.openingArea, w.netWallArea]));
  }

  return lines.join('\r\n') + '\r\n';
}

// Filesystem-safe base filename (no extension), mirroring core/exportObj.js's exportBaseName.
export function scheduleBaseName(project) {
  const raw = (project && project.name) || 'home';
  const safe = String(raw).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${safe || 'home'}-schedule`;
}
