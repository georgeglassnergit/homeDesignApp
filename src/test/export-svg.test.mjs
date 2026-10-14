// E3+ — 2D SVG floor-plan export (engine-independent verification).
// Run: node src/test/export-svg.test.mjs
//
// exportSvg turns the plan model into a self-contained SVG image — the novice-first companion to
// the drafter-first DXF export: the SAME plan geometry (it REUSES wallJoin's mitre and the DXF
// export's `openingRect`), drawn as a picture anyone can open in a browser, email, doc, or print,
// with no CAD software. All the logic is pure text/geometry composition in core/exportSvg.js, so
// it is fully verifiable here without a browser or renderer. This file carries a tiny structural
// SVG validator (a tag-balance + well-formedness walker) so we prove the output is markup a
// renderer would accept — balanced <g>/<text>/<polygon>, a real viewBox, and no "NaN"/"Infinity"
// leaking into any coordinate. It lives in its own file (pick-protocol §5) so it never collides
// with in-flight test work, and re-asserts the Phase 1 save is never touched.
import {
  exportSvg, svgBaseName, svgEscape,
} from '../core/exportSvg.js';
import { UNIT } from '../core/units.js';
import {
  serialize, deserialize, validateProject, createProject, createLevel, createWall,
  createOpening, createRoom, _resetIds,
} from '../core/model.js';
import { sampleHome } from '../templates/sampleHome.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// ---- a minimal structural SVG validator -------------------------------------------------------
// Not a full XML parser — just enough to prove a renderer would accept the document: an XML
// declaration, exactly one <svg> root with a well-formed 4-number viewBox, balanced container
// tags, and no non-finite token anywhere in the markup.
function validateSvg(text) {
  const errors = [];
  if (!/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/.test(text)) errors.push('missing/!malformed XML declaration');
  const svgOpen = (text.match(/<svg\b/g) || []).length;
  const svgClose = (text.match(/<\/svg>/g) || []).length;
  if (svgOpen !== 1 || svgClose !== 1) errors.push(`expected exactly one <svg> root (open=${svgOpen} close=${svgClose})`);

  const vb = text.match(/viewBox="([^"]*)"/);
  if (!vb) errors.push('no viewBox');
  else {
    const nums = vb[1].trim().split(/\s+/);
    if (nums.length !== 4 || !nums.every((n) => Number.isFinite(Number(n)))) errors.push(`viewBox is not 4 finite numbers: "${vb[1]}"`);
  }

  // balanced containers
  for (const tag of ['g', 'text']) {
    const open = (text.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
    const close = (text.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) errors.push(`<${tag}> unbalanced (open=${open} close=${close})`);
  }
  // no non-finite / undefined tokens leaked into markup
  if (/\b(NaN|Infinity|-Infinity|undefined|null)\b/.test(text)) errors.push('non-finite/undefined token in markup');
  // no raw unescaped ampersand (every & must begin an entity)
  if (/&(?!amp;|lt;|gt;|quot;|#39;|#\d+;)/.test(text)) errors.push('raw unescaped ampersand');

  const counts = {
    polygon: (text.match(/<polygon\b/g) || []).length,
    text: (text.match(/<text\b/g) || []).length,
    line: (text.match(/<line\b/g) || []).length,
    g: svgOpen && (text.match(/<g\b/g) || []).length,
  };
  return { errors, counts };
}

// ---- 1) sampleHome round-trips into a valid, well-formed SVG -----------------------------------
{
  _resetIds();
  const project = sampleHome();
  const out = exportSvg(project);
  const v = validateSvg(out.svg);
  ok(v.errors.length === 0, `1a sampleHome SVG is structurally valid (${v.errors.join('; ')})`);
  ok(out.svg.startsWith('<?xml'), '1b starts with XML declaration');
  ok(out.svg.trimEnd().endsWith('</svg>'), '1c ends with </svg>');
  ok(out.counts.walls === 5, `1d reports 5 walls (got ${out.counts.walls})`);
  ok(out.counts.openings === 4, `1e reports 4 openings (got ${out.counts.openings})`);
  ok(out.counts.rooms === 2, `1f reports 2 rooms (got ${out.counts.rooms})`);
  ok(out.counts.levels === 1, `1g reports 1 level (got ${out.counts.levels})`);
}

// ---- 2) geometry is REUSED, not re-derived: poché per wall, gap per opening --------------------
{
  _resetIds();
  const project = sampleHome();
  const out = exportSvg(project);
  const v = validateSvg(out.svg);
  // 5 wall poché polygons + 4 opening-gap polygons + 2 room polygons = 11 <polygon>.
  ok(v.counts.polygon === 5 + 4 + 2, `2a one polygon per wall/opening/room (got ${v.counts.polygon})`);
  // The wall fill colour appears on every wall footprint.
  ok((out.svg.match(/fill="#3a3128"/g) || []).length === 5, '2b five wall-poché fills');
  // Opening accent stroke appears on every opening.
  ok((out.svg.match(/stroke="#2f6f9f"/g) || []).length === 4, '2c four opening accents');
}

// ---- 3) room labels: name + area, and metric/imperial changes the area text --------------------
{
  _resetIds();
  const project = sampleHome();
  const metric = exportSvg(project, { units: UNIT.METRIC }).svg;
  const imperial = exportSvg(project, { units: UNIT.IMPERIAL }).svg;
  const roomNames = project.levels[0].rooms.map((r) => r.name);
  ok(roomNames.every((n) => metric.includes(svgEscape(n))), '3a every room name appears as a label');
  ok(metric.includes('m²') || /\dm/.test(metric), '3b metric label shows metric area');
  ok(imperial.includes('ft²') || /ft/.test(imperial), '3c imperial label shows imperial area');
  ok(metric !== imperial, '3d switching units changes the drawing text');
}

// ---- 4) XML escaping — a hostile project/room name can't break the markup ----------------------
{
  ok(svgEscape('A & B < C > D "q" \'s\'') === 'A &amp; B &lt; C &gt; D &quot;q&quot; &#39;s&#39;', '4a svgEscape maps all five XML chars');
  ok(svgEscape(null) === '' && svgEscape(undefined) === '', '4b svgEscape null/undefined → empty');
  _resetIds();
  const room = createRoom([{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }], { name: 'Kids\' <Play> & "Fun"' });
  const project = createProject({ name: 'Bob & "Sons" <Ltd>', levels: [createLevel({ name: 'G', rooms: [room] })] });
  const out = exportSvg(project);
  const v = validateSvg(out.svg);
  ok(v.errors.length === 0, `4c hostile names still produce valid SVG (${v.errors.join('; ')})`);
  ok(out.svg.includes('Bob &amp; &quot;Sons&quot; &lt;Ltd&gt;'), '4d project name escaped in title');
  ok(!/<Play>/.test(out.svg) && !/ & /.test(out.svg), '4e no raw < > or bare & from the room name');
}

// ---- 5) non-finite geometry never emits NaN/Infinity and never throws --------------------------
{
  _resetIds();
  const badWall = createWall({ x: NaN, z: 0 }, { x: 4, z: 0 }, { thickness: 0.2 });
  const goodWall = createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { thickness: 0.2 });
  const badRoom = createRoom([{ x: 0, z: 0 }, { x: Infinity, z: 0 }, { x: 3, z: 3 }], { name: 'X' });
  let threw = false, out = null;
  try { out = exportSvg(createProject({ levels: [createLevel({ walls: [badWall, goodWall], rooms: [badRoom] })] })); }
  catch { threw = true; }
  ok(!threw, '5a exporting non-finite geometry does not throw');
  ok(out && validateSvg(out.svg).errors.length === 0, '5b output is still valid (no NaN/Infinity token)');
}

// ---- 6) empty / null projects produce a friendly, valid SVG -----------------------------------
{
  const emptyOut = exportSvg(createProject({ name: 'Fresh', levels: [] }));
  const ev = validateSvg(emptyOut.svg);
  ok(ev.errors.length === 0, `6a empty project → valid SVG (${ev.errors.join('; ')})`);
  ok(emptyOut.counts.levels === 0 && emptyOut.counts.walls === 0, '6b empty counts');
  ok(/Nothing to draw yet/.test(emptyOut.svg), '6c empty plan shows a helpful hint');

  let threw = false, nullOut = null;
  try { nullOut = exportSvg(null); } catch { threw = true; }
  ok(!threw && nullOut && validateSvg(nullOut.svg).errors.length === 0, '6d null project → valid SVG, no throw');
  ok(nullOut.counts.walls === 0 && nullOut.counts.rooms === 0, '6e null project → zero counts');

  // orphan opening (no matching wall) is skipped, drawing stays valid.
  _resetIds();
  const w = createWall({ x: 0, z: 0 }, { x: 4, z: 0 });
  const orphan = createOpening('wall_does_not_exist', 'door');
  const out = exportSvg(createProject({ levels: [createLevel({ walls: [w], openings: [orphan] })] }));
  ok(out.counts.openings === 0 && validateSvg(out.svg).errors.length === 0, '6f orphan opening skipped, drawing still valid');
}

// ---- 7) multi-storey: one titled panel per level, laid out side by side ------------------------
{
  _resetIds();
  const mk = (nm) => createLevel({
    name: nm,
    walls: [createWall({ x: 0, z: 0 }, { x: 3, z: 0 }), createWall({ x: 3, z: 0 }, { x: 3, z: 3 })],
    rooms: [createRoom([{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }], { name: 'R' })],
  });
  const project = createProject({ name: 'Stack', levels: [mk('Ground'), mk('Upper')] });
  const out = exportSvg(project);
  const v = validateSvg(out.svg);
  ok(v.errors.length === 0, `7a two-storey SVG is valid (${v.errors.join('; ')})`);
  ok(out.counts.levels === 2, `7b reports 2 levels (got ${out.counts.levels})`);
  ok(out.svg.includes('>Ground<') && out.svg.includes('>Upper<'), '7c both level titles present');
  // The two level groups sit at increasing x offsets (side by side, not stacked at one origin).
  const xs = [...out.svg.matchAll(/<g transform="translate\(([-\d.]+),/g)].map((m) => Number(m[1]));
  ok(xs.length === 2 && xs[1] > xs[0], `7d second storey is offset to the right (xs=${xs.join(',')})`);
}

// ---- 8) scale option: clamped, and it changes the canvas size ---------------------------------
{
  _resetIds();
  const project = sampleHome();
  const small = exportSvg(project, { scale: 20 });
  const big = exportSvg(project, { scale: 120 });
  const w = (svg) => Number(svg.match(/width="([\d.]+)"/)[1]);
  ok(w(big.svg) > w(small.svg), '8a larger scale → wider canvas');
  // out-of-range scales are clamped, not honoured literally (never a 1px or 1e9px canvas).
  const tiny = exportSvg(project, { scale: -5 });
  const huge = exportSvg(project, { scale: 1e6 });
  ok(w(tiny.svg) === w(exportSvg(project, { scale: 4 }).svg), '8b scale clamped up to 4');
  ok(w(huge.svg) === w(exportSvg(project, { scale: 400 }).svg), '8c scale clamped down to 400');
  ok(w(exportSvg(project).svg) === w(exportSvg(project, { scale: 50 }).svg), '8d default scale is 50');
}

// ---- 9) warnings mirror DXF: roof + furniture noted, not drawn ---------------------------------
{
  _resetIds();
  const project = sampleHome();
  const out = exportSvg(project);
  ok(out.warnings.some((w) => /roof/.test(w)), '9a roof reported as not drawn');
  ok(out.warnings.some((w) => /furniture/.test(w)), '9b furniture reported as not drawn');
}

// ---- 10) filename slugging --------------------------------------------------------------------
{
  ok(svgBaseName({ name: 'My Home!!' }) === 'my-home', '10a base name slugged');
  ok(svgBaseName(null) === 'home', '10b null → home');
  ok(svgBaseName({ name: '   ' }) === 'home', '10c blank → home');
}

// ---- 11) the export is DERIVED — it never touches the Phase 1 save (contract inviolate) --------
{
  _resetIds();
  const project = sampleHome();
  const before = serialize(project);
  exportSvg(project, { units: UNIT.IMPERIAL });
  const after = serialize(project);
  ok(after === before, '11a exporting SVG leaves the project save byte-identical');
  ok(validateProject(deserialize(after)).ok, '11b the untouched save still validates');
  ok(!('svg' in project), '11c no export field leaks into the model');
}

console.log(`\nexport-svg.test: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n- ' + fails.join('\n- ')); process.exit(1); }
