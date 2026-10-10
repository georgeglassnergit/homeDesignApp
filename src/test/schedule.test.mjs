// Engine-independent schedule / quantities take-off — pure verification (plain Node, no Three.js).
// Run: node src/test/schedule.test.mjs
//
// Rounds out the export family with a spreadsheet-shaped SCHEDULE of the design. This proves the
// pure builder + CSV renderer (core/schedule.js):
//   • buildSchedule: room schedule (area/perimeter), opening schedule (door/window sizes),
//     per-storey wall take-off (count, running length, length-weighted mean height,
//     gross wall face area, opening deduction, net area), and a rolled-up summary
//   • totals sum RAW then round once (no re-rounding drift); net area never goes negative
//   • multi-storey aggregation; door/window classification; empty/degenerate projects
//   • csvField: RFC-4180-ish escaping (commas, quotes, newlines in names)
//   • scheduleToCsv: all four sections present, correct headers, CRLF terminated, round-trip
//     parseable back to the same numbers
//   • the schedule MUTATES NOTHING — serialize() is byte-identical before and after
//   • the disclaimer (constraint #6) is present and surfaced in the CSV
// Own file (pick-protocol §5) so it never collides with in-flight test work.
import {
  createProject, createLevel, createWall, createOpening, createRoom, createRoof,
  serialize, validateProject, deserialize, _resetIds, stackElevations,
} from '../core/model.js';
import {
  buildSchedule, scheduleToCsv, csvField, scheduleBaseName, SCHEDULE_DISCLAIMER,
} from '../core/schedule.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- a small realistic single-storey project -------------------------------
// A 4×3 m room: walls 4+3+4+3 = 14 m running length, all 2.7 m high.
//   gross wall area = 14 × 2.7 = 37.8 m²
//   one door 0.9×2.1 = 1.89 m², one window 1.4×1.2 = 1.68 m² → openings 3.57 m²
//   net wall area = 37.8 − 3.57 = 34.23 m²   ·   floor area = 12 m²  ·  perimeter = 14 m
function sampleProject() {
  _resetIds();
  const w1 = createWall({ x: 0, z: 0 }, { x: 4, z: 0 });
  const w2 = createWall({ x: 4, z: 0 }, { x: 4, z: 3 });
  const w3 = createWall({ x: 4, z: 3 }, { x: 0, z: 3 });
  const w4 = createWall({ x: 0, z: 3 }, { x: 0, z: 0 });
  const door = createOpening(w1.id, 'door', { offset: 1 });        // 0.9 × 2.1
  const win = createOpening(w2.id, 'window', { offset: 0.6 });     // 1.4 × 1.2
  const room = createRoom([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], { name: 'Living' });
  const lvl = createLevel({ name: 'Ground', walls: [w1, w2, w3, w4], openings: [door, win], rooms: [room], roof: createRoof({ type: 'gable' }) });
  const p = createProject({ name: 'Test Home', levels: [lvl] });
  stackElevations(p.levels);
  return p;
}

// ===== room schedule =====
(() => {
  const s = buildSchedule(sampleProject());
  ok(s.rooms.length === 1, 'one room in the schedule');
  ok(s.rooms[0].level === 'Ground', 'room carries its level name');
  ok(s.rooms[0].name === 'Living', 'room name preserved');
  ok(near(s.rooms[0].area, 12), 'room floor area 12 m²');
  ok(near(s.rooms[0].perimeter, 14), 'room perimeter 14 m');
  ok(s.rooms[0].material === 'floor', 'room finish defaults to floor material');
})();

// ===== opening schedule =====
(() => {
  const s = buildSchedule(sampleProject());
  ok(s.openings.length === 2, 'two openings scheduled');
  const door = s.openings.find((o) => o.kind === 'door');
  const win = s.openings.find((o) => o.kind === 'window');
  ok(door && near(door.width, 0.9) && near(door.height, 2.1), 'door size 0.9 × 2.1');
  ok(near(door.area, 1.89), 'door area 1.89 m²');
  ok(win && near(win.width, 1.4) && near(win.height, 1.2), 'window size 1.4 × 1.2');
  ok(near(win.area, 1.68), 'window area 1.68 m²');
  ok(near(win.sill, 0.9), 'window sill 0.9 m recorded');
  ok(door.wall && win.wall && door.wall !== win.wall, 'each opening records its (distinct) host wall');
})();

// ===== wall take-off per storey =====
(() => {
  const s = buildSchedule(sampleProject());
  ok(s.wallsByLevel.length === 1, 'one storey in the wall take-off');
  const g = s.wallsByLevel[0];
  ok(g.count === 4, '4 walls');
  ok(near(g.totalLength, 14), 'running wall length 14 m');
  ok(near(g.avgHeight, 2.7), 'length-weighted mean height 2.7 m');
  ok(near(g.grossWallArea, 37.8), 'gross wall face area 37.8 m²');
  ok(near(g.openingArea, 3.57), 'opening deduction 3.57 m²');
  ok(near(g.netWallArea, 34.23), 'net wall area 34.23 m²');
})();

// ===== summary rollup =====
(() => {
  const s = buildSchedule(sampleProject()).summary;
  ok(s.levels === 1, 'summary: 1 storey');
  ok(s.rooms === 1, 'summary: 1 room');
  ok(s.doors === 1 && s.windows === 1 && s.openings === 2, 'summary: 1 door + 1 window = 2 openings');
  ok(s.walls === 4, 'summary: 4 walls');
  ok(near(s.floorArea, 12), 'summary: GFA 12 m²');
  ok(near(s.totalWallLength, 14), 'summary: 14 m running wall');
  ok(near(s.grossWallArea, 37.8), 'summary: gross 37.8 m²');
  ok(near(s.openingArea, 3.57), 'summary: openings 3.57 m²');
  ok(near(s.netWallArea, 34.23), 'summary: net 34.23 m²');
})();

// ===== multi-storey aggregation =====
(() => {
  _resetIds();
  const mk = (name) => {
    const a = createWall({ x: 0, z: 0 }, { x: 5, z: 0 });   // 5 m
    const b = createWall({ x: 5, z: 0 }, { x: 5, z: 4 });   // 4 m
    const rm = createRoom([{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 4 }, { x: 0, z: 4 }], { name: name + ' room' });
    return createLevel({ name, walls: [a, b], rooms: [rm] });
  };
  const p = createProject({ name: 'Two Storey', levels: [mk('Ground'), mk('Upper')] });
  stackElevations(p.levels);
  const s = buildSchedule(p);
  ok(s.summary.levels === 2, 'two storeys aggregated');
  ok(s.rooms.length === 2 && s.wallsByLevel.length === 2, 'rooms + wall take-off per storey');
  ok(s.summary.walls === 4, 'walls summed across storeys (2+2)');
  ok(near(s.summary.floorArea, 40), 'GFA summed across storeys (20+20)');
  ok(near(s.summary.totalWallLength, 18), 'wall length summed across storeys (9+9)');
})();

// ===== net area never negative (over-glazed model) =====
(() => {
  _resetIds();
  const w = createWall({ x: 0, z: 0 }, { x: 2, z: 0 }, { height: 2.4 }); // gross 4.8 m²
  // pile on openings that (impossibly) exceed the wall area — the model may allow it; the
  // schedule must still report a sane, non-negative net.
  const o1 = createOpening(w.id, 'window', { offset: 0, width: 1.9, height: 2.0 }); // 3.8
  const o2 = createOpening(w.id, 'window', { offset: 0, width: 1.9, height: 2.0 }); // 3.8 → 7.6 > 4.8
  const lvl = createLevel({ name: 'L', walls: [w], openings: [o1, o2] });
  const p = createProject({ name: 'Glassy', levels: [lvl] });
  const s = buildSchedule(p);
  ok(s.wallsByLevel[0].netWallArea === 0, 'net wall area clamps at 0, never negative (per level)');
  ok(s.summary.netWallArea === 0, 'summary net wall area clamps at 0');
})();

// ===== empty / degenerate projects don't throw =====
(() => {
  ok(buildSchedule({}).summary.levels === 0, 'no-levels project → empty schedule, no throw');
  ok(buildSchedule(null).summary.rooms === 0, 'null project → empty schedule, no throw');
  const empty = createProject({ name: 'Bare' });
  const s = buildSchedule(empty);
  ok(s.rooms.length === 0 && s.openings.length === 0, 'bare project has empty room/opening schedules');
  ok(s.wallsByLevel.length === 0 && s.summary.walls === 0, 'bare project (no levels) has an empty wall take-off');
})();

// ===== csvField escaping =====
(() => {
  ok(csvField('Living') === 'Living', 'plain field unquoted');
  ok(csvField('Kitchen, open-plan') === '"Kitchen, open-plan"', 'comma forces quoting');
  ok(csvField('Bob\'s "study"') === '"Bob\'s ""study"""', 'embedded quotes doubled + wrapped');
  ok(csvField('line1\nline2') === '"line1\nline2"', 'newline forces quoting');
  ok(csvField(12.5) === '12.5', 'number rendered bare');
  ok(csvField(null) === '' && csvField(undefined) === '', 'null/undefined → empty field');
})();

// ===== scheduleToCsv structure =====
(() => {
  const csv = scheduleToCsv(buildSchedule(sampleProject()));
  ok(csv.includes('\r\n'), 'CSV uses CRLF line endings');
  ok(csv.endsWith('\r\n'), 'CSV ends with a terminator');
  ok(csv.includes(SCHEDULE_DISCLAIMER), 'CSV surfaces the advisory disclaimer');
  for (const section of ['Summary', 'Rooms', 'Openings', 'Walls by level']) {
    ok(csv.includes(section), `CSV has the "${section}" section`);
  }
  ok(csv.includes('Floor area (m²),Perimeter (m),Finish'), 'room header columns present');
  ok(csv.includes('Living,12,14,floor'), 'room row rendered with rounded figures');
  ok(csv.includes('Net wall area (m²)'), 'wall take-off net-area column present');
  // buildSchedule can be skipped — scheduleToCsv accepts a raw project too
  const csv2 = scheduleToCsv(sampleProject());
  ok(csv2.includes('Roomclip schedule — Test Home'), 'scheduleToCsv accepts a raw project (auto-builds)');
})();

// ===== CSV numbers round-trip back to the schedule =====
(() => {
  const s = buildSchedule(sampleProject());
  const csv = scheduleToCsv(s);
  // find the Living room data row (Level,Room,Area,Perimeter,Finish) and re-parse its cells
  const line = csv.split('\r\n').find((l) => l.includes(',Living,'));
  ok(!!line, 'Living row locatable in CSV');
  const cells = line.split(',');
  ok(Number(cells[2]) === s.rooms[0].area, 'CSV floor-area cell parses back to the schedule value');
  ok(Number(cells[3]) === s.rooms[0].perimeter, 'CSV perimeter cell parses back to the schedule value');
})();

// ===== scheduleBaseName =====
(() => {
  ok(scheduleBaseName({ name: 'My House!' }) === 'my-house-schedule', 'base name sanitised + suffixed');
  ok(scheduleBaseName({}) === 'home-schedule', 'missing name → home-schedule');
  ok(scheduleBaseName({ name: '   ' }) === 'home-schedule', 'blank name → home-schedule');
})();

// ===== the schedule mutates nothing (save byte-identical) + old saves still valid =====
(() => {
  const p = sampleProject();
  const before = serialize(p);
  buildSchedule(p); scheduleToCsv(p); scheduleToCsv(buildSchedule(p)); scheduleBaseName(p);
  ok(serialize(p) === before, 'schedule leaves the project byte-identical (no mutation, no save field)');
  ok(validateProject(deserialize(before)).ok, 'project still validates after scheduling (lossless save intact)');
})();

// ---- summary ----
console.log(`\nschedule: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
