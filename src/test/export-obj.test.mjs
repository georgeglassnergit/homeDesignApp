// Engine-independent export — pure verification (plain Node, no Three.js).
// Run: node src/test/export-obj.test.mjs
//
// E3 (PHASE-3-PLAN.md): a pure model → interchange export (OBJ massing + companion MTL,
// plus the project's lossless JSON save). This proves the pure serializer:
//   • wallMesh: a clean 8-vert / 12-tri box on the wall centreline, thickness/height/base honoured
//   • roomSlabMesh: a triangulated top+bottom cap + perimeter, watertight vert/tri counts
//   • triangulate: ear-clipping a convex AND a non-convex (L-shaped) simple polygon
//   • exportObj: valid OBJ text (v/f/o/usemtl/mtllib), 1-indexed faces in range, per-element groups,
//     multi-storey base elevations, and honest warnings (uncut openings / roof / furniture)
//   • buildMtl / hexToRgb01: colours from the project map; JSON export == lossless save
//   • the export MUTATES NOTHING — serialize() is byte-identical before and after
// Own file (pick-protocol §5) so it never collides with in-flight test work.
import {
  createProject, createLevel, createWall, createOpening, createRoom, createRoof,
  createFurniture, serialize, validateProject, _resetIds, stackElevations,
} from '../core/model.js';
import {
  exportObj, wallMesh, roomSlabMesh, triangulate, buildMtl, hexToRgb01,
  exportProjectJson, exportBaseName,
} from '../core/exportObj.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- a small realistic project ---------------------------------------------
function sampleProject() {
  _resetIds();
  const w1 = createWall({ x: 0, z: 0 }, { x: 4, z: 0 });
  const w2 = createWall({ x: 4, z: 0 }, { x: 4, z: 3 });
  const w3 = createWall({ x: 4, z: 3 }, { x: 0, z: 3 });
  const w4 = createWall({ x: 0, z: 3 }, { x: 0, z: 0 });
  const door = createOpening(w1.id, 'door', { offset: 1 });
  const room = createRoom([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], { name: 'Living' });
  const lvl = createLevel({ name: 'Ground', walls: [w1, w2, w3, w4], openings: [door], rooms: [room], roof: createRoof({ type: 'gable' }) });
  const furn = createFurniture('sample.glb', { levelId: lvl.id });
  const p = createProject({ name: 'Test Home', levels: [lvl], furniture: [furn] });
  stackElevations(p.levels);
  return p;
}

// ===== hexToRgb01 =====
(() => {
  ok(hexToRgb01('#ffffff').every((v) => near(v, 1)), 'hex white → 1,1,1');
  ok(hexToRgb01('#000000').every((v) => near(v, 0)), 'hex black → 0,0,0');
  const [r, g, b] = hexToRgb01('#ff8000');
  ok(near(r, 1) && near(g, 128 / 255) && near(b, 0), 'hex #ff8000 parses per-channel');
  ok(hexToRgb01('#abc').every((v, i) => near(v, hexToRgb01('#aabbcc')[i])), '3-digit hex expands');
  ok(hexToRgb01('nonsense').every((v) => near(v, 0.8)), 'bad hex → mid-grey fallback');
})();

// ===== triangulate =====
(() => {
  const sq = [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }];
  const t = triangulate(sq);
  ok(t.length === 2, 'square → 2 triangles');
  ok(t.every((tri) => tri.every((i) => i >= 0 && i < 4)), 'square tri indices in range');
  // a non-convex L-shape (6 verts → 4 triangles)
  const L = [
    { x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 1 },
    { x: 1, z: 1 }, { x: 1, z: 3 }, { x: 0, z: 3 },
  ];
  const tL = triangulate(L);
  ok(tL.length === 4, 'L-shape (6 verts) → 4 triangles');
  ok(tL.every((tri) => tri.every((i) => i >= 0 && i < 6)), 'L-shape tri indices in range');
  // triangulated area must equal the polygon area (no overlap / no gap)
  const triArea = (pts, tris) => tris.reduce((s, [i, j, k]) => {
    const a = pts[i], b = pts[j], c = pts[k];
    return s + Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
  }, 0);
  ok(near(triArea(L, tL), 5, 1e-6), 'L-shape triangles tile the full area (5 m²)');
  ok(triangulate([{ x: 0, z: 0 }, { x: 1, z: 0 }]).length === 0, '< 3 points → no triangles');
})();

// ===== wallMesh =====
(() => {
  const w = createWall({ x: 0, z: 0 }, { x: 4, z: 0 }, { thickness: 0.2, height: 2.5 });
  const m = wallMesh(w, 0);
  ok(m.verts.length === 8, 'wall box has 8 vertices');
  ok(m.tris.length === 12, 'wall box has 12 triangles');
  ok(m.tris.every((t) => t.every((i) => i >= 0 && i < 8)), 'wall tri indices in range');
  const ys = m.verts.map((v) => v[1]);
  ok(near(Math.min(...ys), 0) && near(Math.max(...ys), 2.5), 'wall spans baseY..baseY+height');
  const zs = m.verts.map((v) => v[2]);
  ok(near(Math.min(...zs), -0.1) && near(Math.max(...zs), 0.1), 'wall extruded ±thickness/2 across');
  const m2 = wallMesh(w, 3);   // second storey base
  ok(near(Math.min(...m2.verts.map((v) => v[1])), 3), 'wall base elevation honoured');
})();

// ===== roomSlabMesh =====
(() => {
  const r = createRoom([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }]);
  const m = roomSlabMesh(r, 0, 0.05);
  ok(m.verts.length === 8, 'rect slab has 2×4 vertices');
  // top cap (2) + bottom cap (2) + 4 perimeter quads (2 tris each = 8) = 12
  ok(m.tris.length === 12, 'rect slab has 12 triangles (caps + sides)');
  ok(m.tris.every((t) => t.every((i) => i >= 0 && i < m.verts.length)), 'slab tri indices in range');
  const ys = m.verts.map((v) => v[1]);
  ok(near(Math.max(...ys), 0) && near(Math.min(...ys), -0.05), 'slab hangs below baseY by thickness');
  ok(roomSlabMesh(createRoom.call(null, [{ x: 0, z: 0 }, { x: 1, z: 0 }]) || { points: [{ x: 0, z: 0 }] }, 0).verts.length === 0
     || roomSlabMesh({ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] }, 0).verts.length === 0, 'degenerate room → empty slab');
})();

// ===== exportObj — structure & validity =====
(() => {
  const p = sampleProject();
  const { obj, mtl, counts, warnings } = exportObj(p);
  const L = obj.split('\n');
  ok(L[0].startsWith('# Roomclip export'), 'OBJ starts with a header comment');
  ok(L.some((l) => l === 'mtllib roomclip.mtl'), 'OBJ references the companion MTL');
  const vLines = L.filter((l) => l.startsWith('v '));
  const fLines = L.filter((l) => l.startsWith('f '));
  const oLines = L.filter((l) => l.startsWith('o '));
  const useLines = L.filter((l) => l.startsWith('usemtl '));
  ok(vLines.length === counts.vertices, 'vertex-line count matches reported count');
  ok(fLines.length === counts.faces, 'face-line count matches reported count');
  ok(counts.objects === 5, 'one object per element (4 walls + 1 floor)');
  ok(oLines.length === 5, '5 `o` groups emitted');
  ok(useLines.length === 5, 'each object gets a usemtl');
  // 4 walls (8 verts) + 1 rect floor slab (8 verts) = 40 vertices
  ok(counts.vertices === 4 * 8 + 8, 'total vertices = 4 walls + 1 slab');
  // every face index is a valid 1-based reference within total vertices
  let allInRange = true;
  for (const f of fLines) {
    const idxs = f.slice(2).trim().split(/\s+/).map(Number);
    if (idxs.some((i) => !(i >= 1 && i <= counts.vertices))) allInRange = false;
  }
  ok(allInRange, 'all face indices are 1-based and within range');
  ok(counts.openings === 1, 'reports the 1 uncut opening');
  ok(warnings.some((w) => /opening/.test(w)), 'warns openings are uncut');
  ok(warnings.some((w) => /roof/.test(w)), 'warns roof not exported');
  ok(warnings.some((w) => /furniture/.test(w)), 'warns furniture not exported');
  ok(L.some((l) => l.startsWith('# note:')), 'warnings are echoed as OBJ comments');
})();

// ===== exportObj — multi-storey base elevations =====
(() => {
  _resetIds();
  const wa = createWall({ x: 0, z: 0 }, { x: 3, z: 0 });
  const wb = createWall({ x: 0, z: 0 }, { x: 3, z: 0 });
  const l0 = createLevel({ name: 'G', height: 3, walls: [wa] });
  const l1 = createLevel({ name: 'First', height: 3, walls: [wb] });
  const p = createProject({ levels: [l0, l1] });
  stackElevations(p.levels);
  const { obj } = exportObj(p);
  const ys = obj.split('\n').filter((l) => l.startsWith('v ')).map((l) => Number(l.split(/\s+/)[2]));
  ok(Math.max(...ys) > 3, 'upper storey walls sit above the ground storey (base elevation applied)');
  ok(near(Math.min(...ys), 0), 'ground storey starts at y=0');
})();

// ===== buildMtl =====
(() => {
  const p = sampleProject();
  const { mtl, counts } = exportObj(p);
  const M = mtl.split('\n');
  const newmtls = M.filter((l) => l.startsWith('newmtl '));
  ok(newmtls.length === counts.materials, 'one newmtl per used material');
  ok(newmtls.length >= 2, 'wall + floor materials both present');
  ok(M.some((l) => l.startsWith('Kd ')), 'MTL carries a diffuse colour');
  // unknown-material fallback still yields a valid single-material MTL
  const fb = buildMtl({}, new Set());
  ok(fb.includes('newmtl default'), 'empty used-set falls back to a default material');
})();

// ===== JSON export + naming =====
(() => {
  const p = sampleProject();
  const json = exportProjectJson(p);
  ok(json === serialize(p), 'JSON export == the lossless save (re-loadable)');
  ok(validateProject(JSON.parse(json)).ok, 'exported JSON validates as a project');
  ok(exportBaseName({ name: 'My Dream House!' }) === 'my-dream-house', 'base name is filesystem-safe');
  ok(exportBaseName({ name: '   ' }) === 'home', 'blank name → home');
})();

// ===== the export mutates nothing (save byte-identical) =====
(() => {
  const p = sampleProject();
  const before = serialize(p);
  exportObj(p); exportObj(p, { slabThickness: 0.2 }); exportProjectJson(p); buildMtl(p.materials, new Set(['wall']));
  ok(serialize(p) === before, 'export leaves the project byte-identical (no mutation)');
})();

// ---- summary ----
console.log(`\nexport-obj: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
