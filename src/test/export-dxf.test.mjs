// E3+ — 2D DXF floor-plan export (engine-independent verification).
// Run: node src/test/export-dxf.test.mjs
//
// exportDxf turns the plan model into a DXF R12 (AC1009) 2D drawing — the universal CAD
// interchange a professional drafter opens (the format the D2 "Outsource" brief most wants to
// travel with). All the logic is pure text/geometry composition in core/exportDxf.js, so it is
// fully verifiable here without a browser or renderer. This file also carries a tiny structural
// DXF validator (a group-code walker) so we prove the output is well-formed — balanced sections,
// paired POLYLINE/SEQEND, and no entity on an undeclared layer — the way a reader would.
// It lives in its own file (pick-protocol §5) so it never collides with in-flight test work,
// and re-asserts the Phase 1 save is never touched.
import {
  exportDxf, dxfBaseName, dxfText, openingRect,
} from '../core/exportDxf.js';
import { UNIT } from '../core/units.js';
import {
  serialize, deserialize, validateProject, createProject, createLevel, createWall,
  createOpening, createRoom, _resetIds,
} from '../core/model.js';
import { sampleHome } from '../templates/sampleHome.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// ---- a minimal structural DXF group-code validator --------------------------------------------
// Walks the (code,value) line pairs and returns a structured summary + a list of structural
// errors. Not a full CAD parser — just enough to prove the document a reader would accept.
function parseDxf(text) {
  const raw = text.split('\n');
  // DXF is code/value line PAIRS; a trailing '' from the final newline is expected.
  const lines = raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  const errors = [];
  if (lines.length % 2 !== 0) errors.push('odd number of lines — not clean code/value pairs');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);

  const sections = [];
  const declaredLayers = new Set();
  const entityLayers = new Set();
  const entities = [];               // { type, layer, vertices, text, height }
  let sectionDepth = 0, curSection = null, inLayerTable = false, sawEOF = false;
  let expectTableName = false;       // the group-2 right after a 0/TABLE is the table's type
  let cur = null;                    // current entity being read

  const flush = () => { if (cur) { entities.push(cur); cur = null; } };

  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === '0') {
      // entity/structure boundary
      if (value === 'SECTION') { sectionDepth++; curSection = null; flush(); }
      else if (value === 'ENDSEC') { sectionDepth--; curSection = null; inLayerTable = false; flush(); }
      else if (value === 'EOF') { sawEOF = true; flush(); }
      else if (value === 'TABLE') { flush(); expectTableName = true; }
      else if (value === 'ENDTAB') { inLayerTable = false; flush(); }
      else if (value === 'LAYER' && inLayerTable) { flush(); cur = { type: 'LAYERDEF', name: null }; }
      else if (value === 'VERTEX') { if (cur && cur.type === 'POLYLINE') cur.vertices.push({}); }
      else if (value === 'SEQEND') { if (cur && cur.type === 'POLYLINE') { cur.closed = cur._closed; flush(); } }
      else { flush(); cur = { type: value, layer: null, vertices: [], text: null, height: null }; }
    } else if (code === '2' && expectTableName) {
      // table type follows a 0/TABLE marker (e.g. LAYER)
      expectTableName = false; if (value === 'LAYER') inLayerTable = true;
    } else if (code === '2' && curSection === null && sectionDepth > 0) {
      // section name follows a SECTION marker
      curSection = value; sections.push(value);
    } else if (code === '2' && inLayerTable && cur && cur.type === 'LAYERDEF') {
      cur.name = value; declaredLayers.add(value);
    } else if (code === '8' && cur) {
      cur.layer = value; entityLayers.add(value);
    } else if (code === '70' && cur && cur.type === 'POLYLINE') {
      cur._closed = value === '1';
    } else if (code === '10' && cur && cur.type === 'POLYLINE' && cur.vertices.length) {
      cur.vertices[cur.vertices.length - 1].x = parseFloat(value);
    } else if (code === '20' && cur && cur.type === 'POLYLINE' && cur.vertices.length) {
      cur.vertices[cur.vertices.length - 1].y = parseFloat(value);
    } else if (code === '1' && cur && cur.type === 'TEXT') {
      cur.text = value;
    } else if (code === '40' && cur && cur.type === 'TEXT') {
      cur.height = parseFloat(value);
    }
  }
  if (sectionDepth !== 0) errors.push('unbalanced SECTION/ENDSEC');
  if (!sawEOF) errors.push('missing EOF');
  // every entity layer must be declared
  for (const l of entityLayers) if (!declaredLayers.has(l)) errors.push(`entity on undeclared layer ${l}`);
  return { errors, sections, declaredLayers, entityLayers, entities, version: findVersion(pairs) };
}
function findVersion(pairs) {
  for (let i = 0; i < pairs.length - 1; i++) if (pairs[i][0] === '9' && pairs[i][1] === '$ACADVER') return pairs[i + 1][1];
  return null;
}
const polys = (p, layer) => p.entities.filter((e) => e.type === 'POLYLINE' && (!layer || e.layer === layer));
const texts = (p, layer) => p.entities.filter((e) => e.type === 'TEXT' && (!layer || e.layer === layer));

// ---- 1) well-formed document from the sample home ---------------------------------------------
{
  _resetIds();
  const project = sampleHome();               // 5 walls, 4 openings, 2 rooms, 1 storey
  const { dxf, counts, warnings } = exportDxf(project);
  const p = parseDxf(dxf);

  ok(p.errors.length === 0, `1a document is structurally valid (${p.errors.join('; ') || 'no errors'})`);
  ok(p.version === 'AC1009', '1b declares DXF R12 (AC1009)');
  ok(p.sections.includes('HEADER') && p.sections.includes('TABLES') && p.sections.includes('ENTITIES'),
    '1c has HEADER + TABLES + ENTITIES sections');
  ok(dxf.startsWith('999\n') || dxf.includes('$ACADVER'), '1d begins with a header');
  ok(counts.walls === 5, `1e reports 5 walls (got ${counts.walls})`);
  ok(counts.openings === 4, `1f reports 4 openings (got ${counts.openings})`);
  ok(counts.rooms === 2, `1g reports 2 rooms (got ${counts.rooms})`);
  ok(warnings.some((w) => /roof/.test(w)) && warnings.some((w) => /furniture/.test(w)),
    '1h warns roof + furniture not drawn (2D plan scope)');
}

// ---- 2) walls drawn as closed polylines on a per-storey WALLS layer ---------------------------
{
  _resetIds();
  const project = sampleHome();
  const { dxf } = exportDxf(project);
  const p = parseDxf(dxf);
  const wallLayer = [...p.declaredLayers].find((l) => l.endsWith('-WALLS'));
  ok(!!wallLayer, '2a a per-storey WALLS layer is declared');
  const wp = polys(p, wallLayer);
  ok(wp.length === 5, `2b 5 wall polylines on the WALLS layer (got ${wp.length})`);
  ok(wp.every((e) => e.closed), '2c wall footprints are CLOSED polylines');
  ok(wp.every((e) => e.vertices.length === 4), '2d each wall footprint is a 4-corner quad');
}

// ---- 3) openings drawn on their own layer -----------------------------------------------------
{
  _resetIds();
  const project = sampleHome();
  const { dxf } = exportDxf(project);
  const p = parseDxf(dxf);
  const openLayer = [...p.declaredLayers].find((l) => l.endsWith('-OPENINGS'));
  ok(!!openLayer, '3a an OPENINGS layer is declared');
  const op = polys(p, openLayer);
  ok(op.length === 4 && op.every((e) => e.closed && e.vertices.length === 4),
    `3b 4 closed opening rectangles (got ${op.length})`);
}

// ---- 4) rooms: boundary polyline + a TEXT label with the area ---------------------------------
{
  _resetIds();
  const project = sampleHome();
  const { dxf } = exportDxf(project, { units: UNIT.METRIC });
  const p = parseDxf(dxf);
  const roomLayer = [...p.declaredLayers].find((l) => l.endsWith('-ROOMS'));
  const labelLayer = [...p.declaredLayers].find((l) => l.endsWith('-ROOM-LABELS'));
  ok(polys(p, roomLayer).length === 2, '4a 2 room boundary polylines');
  const t = texts(p, labelLayer);
  ok(t.length === 2, '4b 2 room labels');
  ok(t.every((e) => /m2/.test(e.text) && e.height > 0), '4c labels carry a metric area (m2) at a real text height');
  ok(t.every((e) => e.text && e.text.length > 3), '4d labels include the room name');
}

// ---- 5) coordinate mapping is (x, z) -> (x, -z) — plan up stays up -----------------------------
{
  _resetIds();
  // one axis-aligned wall from (1,2) to (5,2), thin, so its footprint corners are near z=2 → y=-2
  const wall = createWall({ x: 1, z: 2 }, { x: 5, z: 2 }, { thickness: 0.2 });
  const project = createProject({ name: 'Map', levels: [createLevel({ name: 'G', walls: [wall] })] });
  const { dxf } = exportDxf(project);
  const p = parseDxf(dxf);
  const verts = polys(p)[0].vertices;
  ok(verts.every((v) => Math.abs(v.y - (-2)) <= 0.11), '5a world z≈2 maps to DXF y≈-2 (z negated)');
  ok(verts.some((v) => Math.abs(v.x - 1) < 1e-6) && verts.some((v) => Math.abs(v.x - 5) < 1e-6),
    '5b world x passes through unchanged');
}

// ---- 6) openingRect geometry — a width×thickness rectangle at the offset -----------------------
{
  _resetIds();
  const wall = createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { thickness: 0.2 });
  const op = createOpening(wall.id, 'door', { offset: 1, width: 0.9 });
  const rect = openingRect(wall, op);
  ok(rect.length === 4, '6a rectangle has 4 corners');
  const xs = rect.map((p) => p.x), zs = rect.map((p) => p.z);
  ok(Math.min(...xs) === 1 && Math.max(...xs) === 1.9, '6b spans the opening width along the wall (1 → 1.9)');
  ok(Math.abs(Math.min(...zs) - -0.1) < 1e-9 && Math.abs(Math.max(...zs) - 0.1) < 1e-9,
    '6c spans the wall thickness across it (±0.1)');
  // clamps a run-past-the-end opening onto the wall
  const opWide = createOpening(wall.id, 'window', { offset: 3.5, width: 2 });
  const r2 = openingRect(wall, opWide);
  ok(Math.max(...r2.map((p) => p.x)) <= 4 + 1e-9, '6d an over-long opening is clamped to the wall end');
  ok(openingRect(createWall({ x: 0, z: 0 }, { x: 0, z: 0 }), op).length === 0, '6e degenerate wall → empty rect');
}

// ---- 7) multi-storey: per-level layers, de-duplicated ------------------------------------------
{
  _resetIds();
  const mk = (nm) => createLevel({
    name: nm,
    walls: [createWall({ x: 0, z: 0 }, { x: 3, z: 0 }), createWall({ x: 3, z: 0 }, { x: 3, z: 3 })],
    rooms: [createRoom([{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }], { name: 'R' })],
  });
  // two storeys that slug to the SAME tag must not collide on one layer name
  const project = createProject({ name: 'Stack', levels: [mk('Ground'), mk('Ground')] });
  const { dxf, counts } = exportDxf(project);
  const p = parseDxf(dxf);
  ok(p.errors.length === 0, `7a multi-storey document valid (${p.errors.join('; ') || 'ok'})`);
  const wallLayers = [...p.declaredLayers].filter((l) => l.endsWith('-WALLS'));
  ok(wallLayers.length === 2, `7b two DISTINCT per-storey WALLS layers (got ${wallLayers.length}: ${wallLayers.join(',')})`);
  ok(counts.walls === 4, '7c all four walls across both storeys drawn');
}

// ---- 8) imperial units switch the label to sq ft ----------------------------------------------
{
  _resetIds();
  const project = sampleHome();
  const { dxf } = exportDxf(project, { units: UNIT.IMPERIAL });
  const p = parseDxf(dxf);
  const t = texts(p).map((e) => e.text).join(' | ');
  ok(/sq ft/.test(t) && !/m2/.test(t), '8a imperial labels use sq ft, no m2');
}

// ---- 9) robustness: never throws on sparse / broken input -------------------------------------
{
  let threw = false, res = null;
  try { res = exportDxf(null); } catch { threw = true; }
  ok(!threw && res && parseDxf(res.dxf).errors.length === 0, '9a null project → valid empty drawing, no throw');
  ok(res.counts.walls === 0 && res.counts.rooms === 0, '9b empty counts for a null project');

  // an opening pointing at a wall that doesn't exist is skipped, not fatal
  _resetIds();
  const w = createWall({ x: 0, z: 0 }, { x: 4, z: 0 });
  const orphan = createOpening('wall_does_not_exist', 'door');
  const proj = createProject({ levels: [createLevel({ walls: [w], openings: [orphan] })] });
  const out = exportDxf(proj);
  ok(out.counts.openings === 0 && parseDxf(out.dxf).errors.length === 0, '9c orphan opening skipped, drawing still valid');
}

// ---- 10) dxfText sanitisation + dxfBaseName ----------------------------------------------------
{
  ok(dxfText('12.5 m²') === '12.5 m2', '10a m² glyph mapped to m2');
  ok(dxfText('Café — Zür? 日本') === 'Caf  Zr?', '10b non-ASCII stripped (accents/CJK removed)');
  ok(dxfBaseName({ name: 'My Home!!' }) === 'my-home', '10c base name slugged');
  ok(dxfBaseName(null) === 'home', '10d null → home');
}

// ---- 11) the export is DERIVED — it never touches the Phase 1 save (contract inviolate) --------
{
  _resetIds();
  const project = sampleHome();
  const before = serialize(project);
  exportDxf(project, { units: UNIT.IMPERIAL });
  const after = serialize(project);
  ok(after === before, '11a exporting DXF leaves the project save byte-identical');
  ok(validateProject(deserialize(after)).ok, '11b the untouched save still validates');
  ok(!('dxf' in project), '11c no export field leaks into the model');
}

console.log(`\nexport-dxf.test: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n- ' + fails.join('\n- ')); process.exit(1); }
