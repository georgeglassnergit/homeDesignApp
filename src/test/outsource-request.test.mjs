// D2 · Outsource-drawing intake — engine-independent verification (plain Node, no Three.js).
// Run: node src/test/outsource-request.test.mjs
//
// Proves the pure intake module in src/core/outsourceRequest.js:
//   • buildProjectBrief derives storey/room/wall/opening counts, GFA, per-room area+perimeter,
//     materials-used and roof-types straight from the model — matching the inspector's numbers
//   • formatBriefText renders a deterministic, copy-pasteable plain-text brief
//   • service levels + request validation (needs a contact; needs a valid service; email sanity)
//   • the whole flow is DERIVED-ON-READ: it mutates NOTHING, adds NO save field, never throws on
//     malformed / partial / empty input, and leaves serialize(project) byte-identical
// Lives in its own file so it composes with in-flight work (the roof suite's approach).
import {
  createProject, createLevel, createWall, createOpening, createRoom, createRoof,
  serialize, deserialize, _resetIds,
} from '../core/model.js';
import {
  buildProjectBrief, formatBriefText, createOutsourceRequest, validateOutsourceRequest,
  outsourceRequestJson, SERVICE_LEVELS, isServiceLevel, serviceLevel, OUTSOURCE_DISCLAIMER,
} from '../core/outsourceRequest.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// A square room polygon of the given side (m), centred at (cx,cz).
const square = (side, cx = 0, cz = 0) => {
  const h = side / 2;
  return [{ x: cx - h, z: cz - h }, { x: cx + h, z: cz - h }, { x: cx + h, z: cz + h }, { x: cx - h, z: cz + h }];
};

// A representative two-storey home: ground floor has two rooms, walls, a door + window, a gable
// roof and a couple of finishes; upper floor has one room and a flat roof.
function sampleHome() {
  _resetIds();
  const w1 = createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { material: 'red-brick' });
  const w2 = createWall({ x: 4, z: 0 }, { x: 4, z: 4 });
  const ground = createLevel({
    name: 'Ground',
    height: 2.6,
    walls: [w1, w2],
    openings: [createOpening(w1.id, 'door'), createOpening(w2.id, 'window')],
    rooms: [
      createRoom(square(4, 2, 2), { name: 'Living', material: 'oak' }),
      createRoom(square(2, 6, 2), { name: 'Kitchen' }),
    ],
    roof: null,
  });
  const upper = createLevel({
    name: 'Upper',
    height: 2.4,
    walls: [createWall({ x: 0, z: 0 }, { x: 3, z: 0 })],
    rooms: [createRoom(square(3, 1.5, 1.5), { name: 'Bedroom' })],
    roof: createRoof({ type: 'flat' }),
  });
  ground.roof = createRoof({ type: 'gable' });
  return createProject({ name: 'Test House', units: 'metric', levels: [ground, upper] });
}

// ── 1. Brief: home-level counts + GFA ───────────────────────────────────────────
{
  const brief = buildProjectBrief(sampleHome());
  ok(brief.name === 'Test House', '1a brief carries the project name');
  ok(brief.home.levels === 2, '1b two storeys');
  ok(brief.home.rooms === 3, '1c three rooms total');
  ok(brief.home.walls === 3, '1d three walls total');
  ok(brief.home.openings.total === 2 && brief.home.openings.doors === 1 && brief.home.openings.windows === 1,
    '1e openings split into 1 door + 1 window');
  ok(near(brief.home.grossFloorArea, 16 + 4 + 9), '1f GFA = 16+4+9 = 29 m²');
  ok(brief.home.grossFloorAreaText === '29.0 m²', '1g GFA text formatted metric');
}

// ── 2. Brief: per-level + per-room area / perimeter ─────────────────────────────
{
  const brief = buildProjectBrief(sampleHome());
  ok(brief.levels.length === 2, '2a two level entries');
  const g = brief.levels[0];
  ok(g.name === 'Ground' && near(g.area, 20), '2b ground area = 16+4 = 20 m²');
  ok(g.roofType === 'gable', '2c ground roof type surfaced');
  const living = g.rooms.find((r) => r.name === 'Living');
  ok(living && near(living.area, 16) && near(living.perimeter, 16), '2d Living: 16 m², 16 m perimeter');
  ok(living.areaText === '16.0 m²', '2e room area text formatted');
  ok(brief.levels[1].rooms[0].name === 'Bedroom' && near(brief.levels[1].rooms[0].area, 9), '2f upper Bedroom 9 m²');
}

// ── 3. Brief: materials + roof types used ───────────────────────────────────────
{
  const brief = buildProjectBrief(sampleHome());
  const ids = brief.materials.map((m) => m.id);
  ok(ids.includes('red-brick') && ids.includes('oak'), '3a custom finishes captured');
  ok(ids.includes('wall') && ids.includes('floor') && ids.includes('roof'), '3b default finishes captured');
  const brick = brief.materials.find((m) => m.id === 'red-brick');
  ok(brick && brick.label === 'Red brick', '3c library material gets its human label');
  ok(brief.roofTypes.includes('gable') && brief.roofTypes.includes('flat'), '3d gable + flat roof types');
  // distinctness: each id appears once
  ok(new Set(ids).size === ids.length, '3e materials list is de-duplicated');
}

// ── 4. Imperial units flow through formatting ───────────────────────────────────
{
  const brief = buildProjectBrief(sampleHome(), { units: 'imperial' });
  ok(brief.units === 'imperial', '4a units override honoured');
  ok(/sq ft$/.test(brief.home.grossFloorAreaText), '4b GFA formatted in sq ft');
  ok(/sq ft$/.test(brief.levels[0].rooms[0].areaText), '4c room area in sq ft');
  ok(/[′″]/.test(brief.levels[0].rooms[0].perimeterText), '4d perimeter in ft/in');
}

// ── 5. formatBriefText: deterministic plain text ────────────────────────────────
{
  const text = formatBriefText(buildProjectBrief(sampleHome()));
  ok(text === formatBriefText(buildProjectBrief(sampleHome())), '5a text render is deterministic');
  ok(text.includes('Project: Test House'), '5b names the project');
  ok(text.includes('Gross floor area: 29.0 m²'), '5c includes GFA');
  ok(text.includes('• Living: 16.0 m²'), '5d lists a room with its area');
  ok(text.includes('Doors: 1') && text.includes('Windows: 1'), '5e door/window counts');
  ok(text.includes('Ground — 20.0 m² (gable roof)'), '5f level header shows area + roof');
  ok(!/\d{4}-\d\d-\d\d/.test(text), '5g no date leaks in (deterministic)');
}

// ── 6. Service levels + request assembly ────────────────────────────────────────
{
  ok(SERVICE_LEVELS.length === 3, '6a three service levels');
  ok(isServiceLevel('concept') && isServiceLevel('permit-ready') && !isServiceLevel('nope'), '6b membership test');
  ok(serviceLevel('full-drawing').label === 'Full drawing set', '6c service lookup');
  const req = createOutsourceRequest(sampleHome(), { name: 'Ada', email: 'ada@example.com', notes: 'ASAP' }, { service: 'full-drawing', createdAt: '2026-08-25' });
  ok(req.kind === 'outsource-request', '6d request kind');
  ok(req.service === 'full-drawing', '6e chosen service carried');
  ok(req.contact.name === 'Ada' && req.contact.email === 'ada@example.com' && req.contact.notes === 'ASAP', '6f contact captured + trimmed');
  ok(req.createdAt === '2026-08-25', '6g createdAt is the passed value (never generated)');
  ok(req.disclaimer === OUTSOURCE_DISCLAIMER && /does not draw/.test(req.disclaimer), '6h advisory disclaimer present (constraint #6)');
  ok(req.brief && req.brief.home.rooms === 3, '6i request embeds the derived brief');
  // unknown service falls back to the first
  ok(createOutsourceRequest(sampleHome(), {}, { service: 'bogus' }).service === 'concept', '6j unknown service → concept default');
  // whitespace-only contact trims to empty
  ok(createOutsourceRequest(sampleHome(), { name: '   ' }).contact.name === '', '6k whitespace name trims away');
}

// ── 7. Request validation ───────────────────────────────────────────────────────
{
  const good = createOutsourceRequest(sampleHome(), { email: 'a@b.co' }, { service: 'concept' });
  ok(validateOutsourceRequest(good).ok, '7a valid: email + service');
  const noContact = createOutsourceRequest(sampleHome(), {}, { service: 'concept' });
  ok(!validateOutsourceRequest(noContact).ok, '7b invalid: no name/email');
  ok(validateOutsourceRequest(noContact).errors.some((e) => /name or email/.test(e)), '7c error names the contact gap');
  const badEmail = createOutsourceRequest(sampleHome(), { name: 'X', email: 'not-an-email' }, { service: 'concept' });
  ok(!validateOutsourceRequest(badEmail).ok, '7d invalid: malformed email');
  const nameOnly = createOutsourceRequest(sampleHome(), { name: 'Just a name' }, { service: 'concept' });
  ok(validateOutsourceRequest(nameOnly).ok, '7e valid: name only, no email');
  ok(!validateOutsourceRequest({ contact: { name: 'X' }, service: 'nope' }).ok, '7f invalid: bad service');
  ok(!validateOutsourceRequest(null).ok && Array.isArray(validateOutsourceRequest(undefined).errors), '7g null/undefined safe');
}

// ── 8. JSON round-trips ─────────────────────────────────────────────────────────
{
  const req = createOutsourceRequest(sampleHome(), { name: 'Ada', email: 'ada@example.com' }, { service: 'permit-ready', createdAt: '2026-08-25' });
  const json = outsourceRequestJson(req);
  const back = JSON.parse(json);
  ok(back.service === 'permit-ready' && back.contact.name === 'Ada', '8a request JSON round-trips');
  ok(back.brief.home.grossFloorAreaText === '29.0 m²', '8b brief survives JSON');
}

// ── 9. Derived-on-read: NOTHING is mutated, save stays byte-identical ────────────
{
  const project = sampleHome();
  const before = serialize(project);
  buildProjectBrief(project);
  formatBriefText(buildProjectBrief(project));
  createOutsourceRequest(project, { name: 'Ada', email: 'ada@example.com' }, { service: 'full-drawing', createdAt: '2026-08-25' });
  const after = serialize(project);
  ok(before === after, '9a building a brief/request leaves serialize(project) byte-identical');
  // no new field leaked onto the project or its meta
  const reload = deserialize(after);
  ok(!('brief' in reload) && !('outsource' in reload) && Object.keys(reload.meta).length === 0, '9b no outsource field leaked into the save/meta');
  ok(serialize(reload) === before, '9c full round-trip byte-identical');
}

// ── 10. Robustness: partial / empty / malformed input never throws ──────────────
{
  let threw = false;
  try {
    const empty = buildProjectBrief(createProject());
    ok(empty.home.levels === 0 && empty.home.rooms === 0 && near(empty.home.grossFloorArea, 0), '10a empty project → zeroed brief');
    ok(empty.materials.length === 0 && empty.roofTypes.length === 0 && empty.levels.length === 0, '10b empty project → empty lists');
    ok(formatBriefText(empty).includes('Storeys: 0'), '10c empty brief still renders text');
    buildProjectBrief(null);            // no project at all
    buildProjectBrief({ levels: [{ name: 'X' }] }); // level missing arrays
    buildProjectBrief(undefined);
    formatBriefText(null);
    formatBriefText({});
    createOutsourceRequest(null);
  } catch (e) { threw = true; console.log('  threw: ' + e.message); }
  ok(!threw, '10d malformed/partial/empty input never throws');
}

// ── summary ─────────────────────────────────────────────────────────────────────
console.log(`\noutsource-request.test: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n  ' + fails.join('\n  ')); process.exit(1); }
