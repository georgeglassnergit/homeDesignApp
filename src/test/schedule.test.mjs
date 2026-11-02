// Engine-independent schedule / quantities take-off — pure verification (plain Node, no Three.js).
// Run: node src/test/schedule.test.mjs
//
// Rounds out the export family with a spreadsheet-shaped SCHEDULE of the design. This proves the
// pure builder + CSV renderer (core/schedule.js):
//   • buildSchedule: room schedule (area/perimeter), opening schedule (door/window sizes),
//     tagged opening-TYPE schedule (identical openings roll up to a marked D#/W# type + qty),
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
  createProject, createLevel, createWall, createOpening, createRoom, createRoof, createFurniture,
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

// a furnished copy of the sample project: 1 sofa + 2 identical chairs on the Ground storey,
// plus a lamp with no levelId (valid "not tied to a storey"). Furniture lives in the
// top-level project.furniture[] and carries its own levelId.
function furnishedProject() {
  const p = sampleProject();                       // single 'Ground' level
  const lvlId = p.levels[0].id;
  p.furniture = [
    createFurniture('sofa.glb',  { name: 'Sofa',  levelId: lvlId }),
    createFurniture('chair.glb', { name: 'Chair', levelId: lvlId }),
    createFurniture('chair.glb', { name: 'Chair', levelId: lvlId }),  // identical → rolls up to qty 2
    createFurniture('lamp.glb',  { name: 'Lamp',  levelId: null }),   // unassigned storey
  ];
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

// ===== furniture (FF&E) schedule =====
(() => {
  const s = buildSchedule(furnishedProject());
  ok(s.summary.furniture === 4, 'summary: 4 furniture placements counted');
  ok(s.furniture.length === 3, 'furniture grouped into 3 distinct (level · item) rows');
  const chair = s.furniture.find((f) => f.name === 'Chair');
  ok(chair && chair.count === 2 && chair.level === 'Ground', 'identical chairs roll up to qty 2 under their storey');
  const sofa = s.furniture.find((f) => f.name === 'Sofa');
  ok(sofa && sofa.count === 1 && sofa.level === 'Ground', 'sofa qty 1 under its storey');
  const lamp = s.furniture.find((f) => f.name === 'Lamp');
  ok(lamp && lamp.count === 1 && lamp.level === 'Unassigned', 'a null levelId is labelled Unassigned (valid: not tied to a storey)');
  ok(s.furniture[s.furniture.length - 1].level === 'Unassigned', 'unassigned furniture sorts after the storey-assigned items');
})();

// ===== furniture absent / degenerate → empty section, count 0, no throw (old saves) =====
(() => {
  const s = buildSchedule(sampleProject());
  ok(Array.isArray(s.furniture) && s.furniture.length === 0, 'project with no furniture → empty furniture schedule');
  ok(s.summary.furniture === 0, 'summary furniture count 0 when none placed');
  ok(buildSchedule({}).summary.furniture === 0, 'furniture-less/degenerate project → 0 furniture, no throw');
  // a blank/degenerate furniture entry must not throw and must not be counted
  const p = sampleProject(); p.furniture = [null, createFurniture('x.glb', { name: 'Desk', levelId: p.levels[0].id })];
  const s2 = buildSchedule(p);
  ok(s2.summary.furniture === 1 && s2.furniture.length === 1, 'blank furniture entry is skipped, not counted or thrown on');
})();

// ===== furniture CSV section =====
(() => {
  const csv = scheduleToCsv(buildSchedule(furnishedProject()));
  ok(csv.includes('Furniture'), 'CSV has the "Furniture" section');
  ok(csv.includes('Level,Item,Qty'), 'furniture header columns present');
  ok(csv.includes('Ground,Chair,2'), 'furniture row rendered with the grouped quantity');
  ok(csv.includes('Unassigned,Lamp,1'), 'unassigned furniture row rendered');
  ok(csv.includes('Furniture,4,'), 'summary block carries the furniture count');
})();

// ===== opening-TYPE schedule (tagged door/window roll-up) =====
// A long wall carrying: 3 standard doors (0.9×2.1), 1 wider door (1.0×2.1), 2 identical windows
// (1.4×1.2 sill 0.9) → types D1 ×3, D2 ×1, W1 ×2. Marks assigned in first-seen (model) order.
function typedProject() {
  _resetIds();
  const wall = createWall({ x: 0, z: 0 }, { x: 20, z: 0 }); // long enough to host several openings
  const openings = [
    createOpening(wall.id, 'door',   { offset: 1,  width: 0.9, height: 2.1 }),            // D1
    createOpening(wall.id, 'door',   { offset: 3,  width: 0.9, height: 2.1 }),            // D1
    createOpening(wall.id, 'door',   { offset: 5,  width: 0.9, height: 2.1 }),            // D1
    createOpening(wall.id, 'door',   { offset: 7,  width: 1.0, height: 2.1 }),            // D2 (wider)
    createOpening(wall.id, 'window', { offset: 9,  width: 1.4, height: 1.2, sill: 0.9 }), // W1
    createOpening(wall.id, 'window', { offset: 12, width: 1.4, height: 1.2, sill: 0.9 }), // W1
  ];
  const lvl = createLevel({ name: 'Ground', walls: [wall], openings });
  return createProject({ name: 'Typed Home', levels: [lvl] });
}

(() => {
  const s = buildSchedule(typedProject());
  // summary type counts
  ok(s.summary.doors === 4 && s.summary.windows === 2, 'summary still counts every opening instance (4 doors, 2 windows)');
  ok(s.summary.doorTypes === 2 && s.summary.windowTypes === 1, 'summary: 2 distinct door types + 1 window type');
  // the tagged schedule itself: doors first (mark order), then windows
  ok(s.openingTypes.length === 3, 'three distinct opening types (D1, D2, W1)');
  ok(s.openingTypes.map((t) => t.mark).join(',') === 'D1,D2,W1', 'doors (D1,D2) sort before windows (W1), each in first-seen mark order');
  const d1 = s.openingTypes[0], d2 = s.openingTypes[1], w1 = s.openingTypes[2];
  ok(d1.mark === 'D1' && d1.kind === 'door' && near(d1.width, 0.9) && near(d1.height, 2.1) && d1.count === 3, 'D1 = 0.9×2.1 door, qty 3 (identical doors roll up)');
  ok(d2.mark === 'D2' && near(d2.width, 1.0) && d2.count === 1, 'D2 = the 1.0 m-wide door, qty 1 (a different size is a different type)');
  ok(w1.mark === 'W1' && w1.kind === 'window' && near(w1.sill, 0.9) && w1.count === 2, 'W1 = 1.4×1.2 window sill 0.9, qty 2');
  // the type counts reconcile with the raw instance counts
  const typeDoorQty = s.openingTypes.filter((t) => t.kind === 'door').reduce((a, t) => a + t.count, 0);
  const typeWinQty = s.openingTypes.filter((t) => t.kind === 'window').reduce((a, t) => a + t.count, 0);
  ok(typeDoorQty === s.summary.doors && typeWinQty === s.summary.windows, 'type quantities sum back to the raw door/window instance totals');
  // every per-instance opening cross-references its type mark
  ok(s.openings.every((o) => typeof o.mark === 'string' && /^[DW]\d+$/.test(o.mark)), 'each per-instance opening carries a D#/W# mark');
  ok(s.openings.filter((o) => o.mark === 'D1').length === 3, 'the three 0.9×2.1 door instances all carry mark D1');
})();

// ===== opening-type marks are PROJECT-WIDE (shared across storeys) =====
(() => {
  _resetIds();
  const mk = (name, x) => {
    const w = createWall({ x: 0, z: x }, { x: 6, z: x });
    const d = createOpening(w.id, 'door', { offset: 1, width: 0.9, height: 2.1 }); // same type both floors
    return createLevel({ name, walls: [w], openings: [d] });
  };
  const p = createProject({ name: 'Two Floor', levels: [mk('Ground', 0), mk('Upper', 10)] });
  stackElevations(p.levels);
  const s = buildSchedule(p);
  ok(s.summary.doorTypes === 1, 'a standard door on two storeys is ONE project-wide type, not two');
  ok(s.openingTypes.length === 1 && s.openingTypes[0].mark === 'D1' && s.openingTypes[0].count === 2, 'D1 rolls up both storeys → qty 2');
})();

// ===== opening-type CSV section =====
(() => {
  const csv = scheduleToCsv(buildSchedule(typedProject()));
  ok(csv.includes('Opening types'), 'CSV has the "Opening types" section');
  ok(csv.includes('Mark,Type,Width (m),Height (m),Sill (m),Qty'), 'opening-type header columns present');
  ok(csv.includes('D1,door,0.9,2.1,0,3'), 'D1 type row rendered with the rolled-up quantity');
  ok(csv.includes('W1,window,1.4,1.2,0.9,2'), 'W1 type row rendered');
  ok(csv.includes('Door types,2,') && csv.includes('Window types,1,'), 'summary block carries the distinct-type counts');
  // the per-instance Openings section now cross-references the mark
  ok(csv.includes('Level,Mark,Type,Host wall,Width (m),Height (m),Area (m²),Sill (m)'), 'per-instance Openings header carries the Mark column');
})();

// ===== opening types: empty / degenerate → empty section, no throw =====
(() => {
  const s = buildSchedule(sampleProject()); // 1 door + 1 window, distinct → D1 + W1
  ok(s.openingTypes.length === 2 && s.summary.doorTypes === 1 && s.summary.windowTypes === 1, 'the sample home yields exactly D1 + W1');
  ok(Array.isArray(buildSchedule({}).openingTypes) && buildSchedule({}).openingTypes.length === 0, 'no-levels project → empty openingTypes, no throw');
  ok(buildSchedule(null).summary.doorTypes === 0, 'null project → 0 door types, no throw');
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
  for (const section of ['Summary', 'Rooms', 'Openings', 'Opening types', 'Walls by level', 'Furniture']) {
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
  const p = furnishedProject();   // includes furniture, so reading it is proven mutation-free too
  const before = serialize(p);
  buildSchedule(p); scheduleToCsv(p); scheduleToCsv(buildSchedule(p)); scheduleBaseName(p);
  ok(serialize(p) === before, 'schedule leaves the (furnished) project byte-identical (no mutation, no save field)');
  ok(validateProject(deserialize(before)).ok, 'furnished project still validates after scheduling (lossless save intact)');
})();

// ---- summary ----
console.log(`\nschedule: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
