// D2 — "Outsource" design brief (engine-independent verification).
// Run: node src/test/outsource-brief.test.mjs
//
// The Outsource onboarding tile turns the in-app model + a few optional intake fields into a
// plain-text brief a homeowner can hand to a professional. There is no backend — all the logic
// is the pure text composition in core/outsourceBrief.js:
//   • isPlausibleEmail / normalizeIntake — sanitize the optional intake fields
//   • buildOutsourceBrief — model counts + floor area + intake -> a stable brief string
// This file proves that composition so the DOM harness only has to confirm the modal renders and
// the download fires. It lives in its own file (pick-protocol §5) so it never collides with
// in-flight test work, and re-asserts the Phase 1 save is never touched.
import {
  isPlausibleEmail, normalizeIntake, buildOutsourceBrief,
} from '../core/outsourceBrief.js';
import { UNIT } from '../core/units.js';
import {
  serialize, deserialize, validateProject, createProject, createLevel, createWall, createRoom, _resetIds,
} from '../core/model.js';
import { STARTERS } from '../templates/starters.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

const FIXED = new Date('2026-09-04T08:00:00Z');

// All bundled starters are single-storey, so build a valid two-storey fixture for the
// per-storey-breakdown assertions (one 4×3 room per floor).
function twoStorey() {
  const room = () => {
    const A = { x: 0, z: 0 }, B = { x: 4, z: 0 }, C = { x: 4, z: 3 }, D = { x: 0, z: 3 };
    return createLevel({
      name: 'Floor',
      walls: [createWall(A, B), createWall(B, C), createWall(C, D), createWall(D, A)],
      rooms: [createRoom([A, B, C, D], { name: 'Room' })],
    });
  };
  const g = room(); g.name = 'Ground floor';
  const u = room(); u.name = 'Upper floor';
  return createProject({ name: 'Two-storey', levels: [g, u] });
}

// ---- 1) isPlausibleEmail ----------------------------------------------------------------------
{
  ok(isPlausibleEmail('jane@example.com'), '1a ordinary address ok');
  ok(isPlausibleEmail('a.b+c@sub.domain.co'), '1b plus/dots/subdomain ok');
  ok(!isPlausibleEmail('jane@example'), '1c missing TLD rejected');
  ok(!isPlausibleEmail('jane at example.com'), '1d no @ rejected');
  ok(!isPlausibleEmail('a@@b.com'), '1e double @ rejected');
  ok(!isPlausibleEmail('  '), '1f blank rejected');
  ok(!isPlausibleEmail(null), '1g non-string rejected');
}

// ---- 2) normalizeIntake: optional fields, collapse, email guard -------------------------------
{
  const n = normalizeIntake({ name: '  Jane   Homeowner ', email: 'jane@example.com', phone: '555\t1234' });
  ok(n.name === 'Jane Homeowner', '2a name whitespace collapsed');
  ok(n.phone === '555 1234', '2b phone tab collapsed');
  ok(n.email === 'jane@example.com' && n.emailRejected === false, '2c good email kept');

  const bad = normalizeIntake({ email: 'not-an-email' });
  ok(bad.email === '' && bad.emailRejected === true, '2d bad email dropped + flagged');

  const empty = normalizeIntake();
  ok(empty.name === '' && empty.email === '' && empty.notes === '' && empty.emailRejected === false,
    '2e empty intake yields all-blank, no rejection');

  const notes = normalizeIntake({ notes: 'line one\n\n  line   two  \nline three\n\n' });
  ok(notes.notes === 'line one\n\n line two\nline three', '2f notes keep paragraph breaks, collapse inline runs');
}

// ---- 3) buildOutsourceBrief: model overview from a real template ------------------------------
{
  _resetIds();
  const project = twoStorey();
  const { text, filename, subject } = buildOutsourceBrief(project, {}, { units: UNIT.METRIC, date: FIXED });

  ok(text.startsWith('HOME DESIGN BRIEF\n'), '3a starts with the brief header');
  ok(text.includes('Prepared: 2026-09-04'), '3b injected date printed deterministically');
  ok(/Storeys:\s+2/.test(text), '3c two-storey fixture reports 2 storeys');
  ok(/Gross floor area:\s+[\d.]+ m²/.test(text), '3d GFA formatted in metric');
  ok(text.includes('Per storey:'), '3e multi-storey breakdown present');
  ok(text.includes('FOR THE DESIGNER') && text.toLowerCase().includes('not a surveyed'),
    '3f advisory footer present (guardrail #6 — not a construction spec)');
  ok(filename.endsWith('-design-brief.txt'), '3g filename slugged');
  ok(subject.startsWith('Design brief —'), '3h subject line present');
  ok(text.endsWith('\n'), '3i trailing newline');
}

// ---- 4) intake fields flow into the brief -----------------------------------------------------
{
  _resetIds();
  const project = STARTERS.find((s) => s.id === 'studio').build();
  const { text } = buildOutsourceBrief(project, {
    name: 'Jane Homeowner', email: 'jane@example.com', phone: '555-1234',
    style: 'Modern farmhouse', timeline: 'Spring 2027',
    notes: 'Please finish the kitchen layout.\nAdd a mud room off the garage.',
  }, { date: FIXED });

  ok(text.includes('CONTACT') && text.includes('Jane Homeowner') && text.includes('jane@example.com'),
    '4a contact block rendered');
  ok(text.includes('Please finish the kitchen layout.') && text.includes('Add a mud room off the garage.'),
    '4b multi-line notes carried through');
  ok(text.includes('Preferred style:  Modern farmhouse') && text.includes('Ideal timeline:   Spring 2027'),
    '4c style + timeline rendered');
}

// ---- 5) blank/no-notes brief still coherent; contact omitted when unfilled --------------------
{
  _resetIds();
  const project = STARTERS.find((s) => s.id === 'studio').build();
  const { text } = buildOutsourceBrief(project, {}, { date: FIXED });
  ok(!text.includes('CONTACT'), '5a no contact block when nothing entered');
  ok(text.includes('WHAT I’D LIKE HELP WITH') && text.includes('Describe what you’d like'),
    '5b blank notes get a helpful prompt, not an empty section');
}

// ---- 6) imperial units format areas in sq ft --------------------------------------------------
{
  _resetIds();
  const project = twoStorey();
  const { text } = buildOutsourceBrief(project, {}, { units: UNIT.IMPERIAL, date: FIXED });
  ok(text.includes('sq ft') && !text.includes(' m²'), '6a imperial brief uses sq ft, no m²');
}

// ---- 7) single-storey brief omits the per-storey breakdown ------------------------------------
{
  _resetIds();
  const project = STARTERS.find((s) => s.id === 'studio').build();
  const { text } = buildOutsourceBrief(project, {}, { date: FIXED });
  ok(!text.includes('Per storey:'), '7a one-storey home has no per-storey list');
}

// ---- 8) robust on a degenerate/empty project (never throws) -----------------------------------
{
  let threw = false, res = null;
  try { res = buildOutsourceBrief(null, {}, { date: FIXED }); } catch { threw = true; }
  ok(!threw && res && res.text.includes('Storeys:            0'), '8a null project -> zeroed brief, no throw');

  const bare = createProject({ name: 'Sketch' });
  const { text, filename } = buildOutsourceBrief(bare, {}, { date: FIXED });
  ok(text.includes('Project: Sketch') && filename === 'sketch-design-brief.txt', '8b empty project name slugged');
}

// ---- 9) the brief is DERIVED — it never touches the Phase 1 save (contract inviolate) ---------
{
  _resetIds();
  const project = twoStorey();
  const before = serialize(project);
  buildOutsourceBrief(project, { name: 'Jane', email: 'jane@example.com', notes: 'x\ny' }, { date: FIXED });
  const after = serialize(project);
  ok(after === before, '9a building a brief leaves the project save byte-identical');
  ok(validateProject(deserialize(after)).ok, '9b the untouched save still validates');
  ok(!('brief' in project) && !(project.meta && 'brief' in project.meta), '9c no brief/intake field leaks into the model');
}

console.log(`\noutsource-brief.test: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n- ' + fails.join('\n- ')); process.exit(1); }
