// E3 · glTF 2.0 export — engine-independent verification (plain Node, no Three.js).
// Run: node src/test/export-gltf.test.mjs
//
// Proves the pure exporter in src/core/exportGltf.js:
//   • emits a structurally valid glTF 2.0 document (asset/scene/nodes/meshes/materials/…)
//   • the embedded base64 buffer decodes; POSITION accessors carry the real vertices with
//     correct spec-required min/max; index accessors reference in-range, valid vertices
//   • the glTF massing matches the OBJ massing element-for-element (same wall boxes + floor
//     slabs) — the two exporters share exportObj.js's mesh helpers and cannot drift
//   • PBR materials come from the project's material map (baseColorFactor + roughnessFactor)
//   • bufferViews stay 4-byte aligned; buffers[0].byteLength matches the payload
//   • the portable base64 encoder matches Node's Buffer oracle exactly (incl. padding cases)
//   • purity: exporting mutates NOTHING, adds NO save field, the save stays byte-identical
//   • malformed / partial / empty projects never throw; an empty model is a valid minimal doc
// Lives in its own file so it composes with in-flight work (the roof/room suites' approach).
import {
  createProject, createLevel, createWall, createOpening, createRoom, createRoof,
  serialize, deserialize, _resetIds, defaultMaterials, materialDef,
} from '../core/model.js';
import { exportObj, wallMesh, roomSlabMesh, hexToRgb01 } from '../core/exportObj.js';
import { exportGltf, bytesToBase64, gltfBaseName } from '../core/exportGltf.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;

// Decode the buffer of a glTF result into a Node Buffer (independent base64 oracle).
function decodeBuffer(res) {
  const uri = res.json.buffers[0].uri;
  const b64 = uri.replace(/^data:[^,]*,/, '');
  return Buffer.from(b64, 'base64');
}
// Read a VEC3-float POSITION accessor's vertices back out of the buffer.
function readPositions(res, buf, accessorIndex) {
  const acc = res.json.accessors[accessorIndex];
  const bv = res.json.bufferViews[acc.bufferView];
  const base = bv.byteOffset + (acc.byteOffset || 0);
  const verts = [];
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * 12;
    verts.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)]);
  }
  return verts;
}
function readIndices(res, buf, accessorIndex) {
  const acc = res.json.accessors[accessorIndex];
  const bv = res.json.bufferViews[acc.bufferView];
  const base = bv.byteOffset + (acc.byteOffset || 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) out.push(buf.readUInt32LE(base + i * 4));
  return out;
}

// A representative one-storey home: 4 walls forming a room, a door + window, a gable roof.
function sampleProject() {
  _resetIds();
  const lvl = createLevel({ name: 'Ground', height: 2.7 });
  const w1 = createWall({ x: 0, z: 0 }, { x: 4, z: 0 });
  const w2 = createWall({ x: 4, z: 0 }, { x: 4, z: 3 });
  const w3 = createWall({ x: 4, z: 3 }, { x: 0, z: 3 });
  const w4 = createWall({ x: 0, z: 3 }, { x: 0, z: 0 });
  lvl.walls.push(w1, w2, w3, w4);
  lvl.openings.push(createOpening(w1.id, 'door', { width: 0.9, height: 2.1 }));
  lvl.openings.push(createOpening(w2.id, 'window', { width: 1.2, height: 1.2, sill: 0.9 }));
  lvl.rooms.push(createRoom(
    [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }],
    { name: 'Living', material: 'oak' },
  ));
  lvl.roof = createRoof({ type: 'gable' });
  // Register the 'oak' finish into the project's material map exactly as the app's
  // setElementMaterial does when a library material is first applied — copying the render
  // fields (not the id/label) — so the export resolves its real colour, not the fallback.
  const oak = materialDef('oak');
  const materials = { ...defaultMaterials(), oak: { color: oak.color, roughness: oak.roughness } };
  return createProject({ name: 'Test Home', levels: [lvl], materials });
}

// ── 1. Valid glTF 2.0 skeleton ────────────────────────────────────────────────
{
  const res = exportGltf(sampleProject());
  const g = res.json;
  ok(g.asset && g.asset.version === '2.0', 'asset.version is "2.0"');
  ok(g.scene === 0 && Array.isArray(g.scenes) && g.scenes.length === 1, 'a single default scene at index 0');
  ok(Array.isArray(g.nodes) && g.nodes.length === 5, 'five nodes (4 walls + 1 floor)');
  ok(Array.isArray(g.meshes) && g.meshes.length === 5, 'five meshes (one per element)');
  ok(g.scenes[0].nodes.length === 5, 'the scene references all five nodes');
  ok(g.buffers.length === 1 && typeof g.buffers[0].uri === 'string', 'one embedded buffer with a data URI');
  ok(/^data:application\/octet-stream;base64,/.test(g.buffers[0].uri), 'buffer uri is a base64 octet-stream data URI');
  ok(JSON.parse(res.gltf).asset.version === '2.0', 'res.gltf is the JSON string of the same doc');
  // every primitive has POSITION + indices + a material + TRIANGLES mode
  ok(g.meshes.every(m => m.primitives.every(p =>
    p.attributes && Number.isInteger(p.attributes.POSITION) &&
    Number.isInteger(p.indices) && Number.isInteger(p.material) && p.mode === 4)),
    'every primitive has POSITION, indices, a material, and TRIANGLES mode');
}

// ── 2. Buffer + accessors decode to the real geometry ─────────────────────────
{
  const proj = sampleProject();
  const res = exportGltf(proj);
  const buf = decodeBuffer(res);
  ok(buf.length === res.json.buffers[0].byteLength, 'decoded buffer length matches buffers[0].byteLength');
  ok(buf.length === res.counts.byteLength, 'counts.byteLength matches the real buffer size');

  // The first mesh is Ground wall w1 — its POSITION accessor must equal wallMesh(w1).
  const w1 = proj.levels[0].walls[0];
  const posAcc = res.json.meshes[0].primitives[0].attributes.POSITION;
  const verts = readPositions(res, buf, posAcc);
  const expected = wallMesh(w1, 0).verts;
  ok(verts.length === expected.length && expected.length === 8, 'wall mesh has 8 vertices');
  let allMatch = true;
  for (let i = 0; i < expected.length; i++) for (let k = 0; k < 3; k++) if (!near(verts[i][k], expected[i][k])) allMatch = false;
  ok(allMatch, 'decoded wall vertices equal wallMesh(w1) exactly');

  // Index accessor: 12 triangles × 3, all in range [0,8).
  const idxAcc = res.json.meshes[0].primitives[0].indices;
  const idx = readIndices(res, buf, idxAcc);
  ok(idx.length === 36, 'wall has 12 triangles (36 indices)');
  ok(idx.every(v => v >= 0 && v < 8), 'all wall indices are in range [0,8)');

  // accessor min/max are the true bounds of the decoded positions.
  const acc = res.json.accessors[posAcc];
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); }
  ok([0, 1, 2].every(k => near(acc.min[k], mn[k]) && near(acc.max[k], mx[k])), 'POSITION accessor min/max bound the vertices');
}

// ── 3. Floor slab mesh round-trips too ────────────────────────────────────────
{
  const proj = sampleProject();
  const res = exportGltf(proj);
  const buf = decodeBuffer(res);
  const room = proj.levels[0].rooms[0];
  const floorMeshIdx = 4; // after 4 walls
  const posAcc = res.json.meshes[floorMeshIdx].primitives[0].attributes.POSITION;
  const verts = readPositions(res, buf, posAcc);
  const expected = roomSlabMesh(room, 0, 0.05).verts;
  ok(verts.length === expected.length, 'floor slab vertex count matches roomSlabMesh');
  let match = true;
  for (let i = 0; i < expected.length; i++) for (let k = 0; k < 3; k++) if (!near(verts[i][k], expected[i][k])) match = false;
  ok(match, 'decoded floor vertices equal roomSlabMesh exactly');
}

// ── 4. glTF massing == OBJ massing (shared helpers, no drift) ─────────────────
{
  const proj = sampleProject();
  const g = exportGltf(proj);
  const o = exportObj(proj);
  ok(g.counts.vertices === o.counts.vertices, 'glTF vertex total equals the OBJ vertex total');
  ok(g.counts.triangles === o.counts.faces, 'glTF triangle total equals the OBJ face total');
  ok(g.counts.meshes === o.counts.objects, 'glTF mesh count equals the OBJ object count');
  ok(g.counts.openings === o.counts.openings, 'both report the same opening count');
}

// ── 5. PBR materials from the project material map ────────────────────────────
{
  const proj = sampleProject();
  const res = exportGltf(proj);
  const g = res.json;
  ok(g.materials.length >= 2, 'at least the wall + floor materials are emitted');
  // the floor room uses 'oak' → baseColorFactor from hexToRgb01('#b9a58c')
  const floorPrim = g.meshes[4].primitives[0];
  const floorMat = g.materials[floorPrim.material];
  const [r, gg, b] = hexToRgb01('#b9a58c');
  const bc = floorMat.pbrMetallicRoughness.baseColorFactor;
  ok(near(bc[0], r) && near(bc[1], gg) && near(bc[2], b) && bc[3] === 1, 'oak floor baseColorFactor matches the palette colour');
  ok(near(floorMat.pbrMetallicRoughness.roughnessFactor, 0.95), 'oak floor roughnessFactor comes from the material def');
  // a wall uses 'wall' → warm off-white
  const wallMat = g.materials[g.meshes[0].primitives[0].material];
  const [wr] = hexToRgb01('#f3ece1');
  ok(near(wallMat.pbrMetallicRoughness.baseColorFactor[0], wr), 'wall baseColorFactor matches the wall colour');
  // materials are deduped: the four identical walls share one glTF material
  const wallMatIdxs = new Set([0, 1, 2, 3].map(i => g.meshes[i].primitives[0].material));
  ok(wallMatIdxs.size === 1, 'the four identical-material walls share ONE glTF material (deduped)');
}

// ── 6. bufferView alignment + buffer integrity ────────────────────────────────
{
  const res = exportGltf(sampleProject());
  const g = res.json;
  ok(g.bufferViews.every(bv => bv.byteOffset % 4 === 0 && bv.byteLength % 4 === 0), 'every bufferView is 4-byte aligned');
  const sum = g.bufferViews.reduce((s, bv) => s + bv.byteLength, 0);
  ok(sum === g.buffers[0].byteLength, 'bufferView byteLengths sum to the buffer byteLength');
  ok(g.bufferViews.every(bv => bv.buffer === 0), 'all bufferViews point at the single buffer');
  // targets are set correctly (POSITION → ARRAY_BUFFER 34962, indices → 34963)
  ok(g.bufferViews.some(bv => bv.target === 34962) && g.bufferViews.some(bv => bv.target === 34963), 'both bufferView targets present');
}

// ── 7. Portable base64 == Node Buffer oracle (incl. padding remainders) ───────
{
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([0, 255]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([255, 254, 253, 252, 251]),
    new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
  ];
  let allEq = true;
  for (const c of cases) if (bytesToBase64(c) !== Buffer.from(c).toString('base64')) allEq = false;
  ok(allEq, 'bytesToBase64 matches Node Buffer base64 across 0/1/2-byte remainders and a full 0..255 sweep');
}

// ── 8. Purity — export mutates nothing, adds no save field ─────────────────────
{
  const proj = sampleProject();
  const before = serialize(proj);
  const res = exportGltf(proj);
  ok(res.counts.vertices > 0, 'the sample actually produced geometry (engine ran)');
  const after = serialize(proj);
  ok(before === after, 'exportGltf mutates NOTHING — project serializes byte-identically');
  const rt = serialize(deserialize(after));
  ok(rt === before, 'serialize→deserialize→serialize stays byte-identical (Phase 1 lossless preserved)');
  ok(!/gltf|accessor|bufferView|baseColorFactor/i.test(after), 'no glTF/export field leaks into the saved project');
}

// ── 9. Warnings mirror the OBJ export scope ───────────────────────────────────
{
  const proj = sampleProject();
  proj.furniture = [{ id: 'f1', src: 'chair.glb' }];
  const res = exportGltf(proj);
  ok(res.warnings.some(w => /opening/.test(w)), 'openings-uncut warning present');
  ok(res.warnings.some(w => /roof/.test(w)), 'roof-not-exported warning present');
  ok(res.warnings.some(w => /furniture/.test(w)), 'furniture-not-exported warning present');
}

// ── 10. Malformed / partial / empty never throws ──────────────────────────────
{
  const bad = [undefined, null, {}, { levels: null }, { levels: [null, {}] },
    { levels: [{ name: 'x', height: 2.7, walls: [null, { id: 'w', a: { x: 0, z: 0 }, b: { x: 0, z: 0 }, thickness: 0.2, height: 2.4, material: 'wall' }], rooms: [{ id: 'r', points: [] }] }] }];
  let threw = false;
  for (const b of bad) { try { const r = exportGltf(b); if (typeof r.gltf !== 'string') threw = true; JSON.parse(r.gltf); } catch { threw = true; } }
  ok(!threw, 'malformed/partial projects never throw and always yield parseable glTF');

  // an empty project → a valid minimal doc with no buffer
  const empty = exportGltf(createProject({ name: 'Empty' }));
  ok(empty.json.buffers.length === 0, 'empty project → no buffer');
  ok(empty.json.nodes.length === 0 && empty.json.meshes.length === 0, 'empty project → no nodes/meshes');
  ok(empty.json.asset.version === '2.0' && JSON.parse(empty.gltf), 'empty project is still valid glTF 2.0');
  ok(empty.counts.byteLength === 0, 'empty project reports zero buffer bytes');
}

// ── 11. Multi-level stacking uses the same base elevations as OBJ ─────────────
{
  _resetIds();
  const l1 = createLevel({ name: 'Ground', height: 3 });
  l1.walls.push(createWall({ x: 0, z: 0 }, { x: 2, z: 0 }));
  const l2 = createLevel({ name: 'Upper', height: 3 });
  l2.walls.push(createWall({ x: 0, z: 0 }, { x: 2, z: 0 }));
  const proj = createProject({ name: 'TwoStorey', levels: [l1, l2] });
  const res = exportGltf(proj);
  const buf = decodeBuffer(res);
  // upper wall (mesh index 1) should sit at baseY = 3 (ground height)
  const upperVerts = readPositions(res, buf, res.json.meshes[1].primitives[0].attributes.POSITION);
  const minY = Math.min(...upperVerts.map(v => v[1]));
  ok(near(minY, 3), 'the upper-storey wall is lifted to the ground-storey height (base elevation)');
}

// ── 12. Filename helper ───────────────────────────────────────────────────────
{
  ok(gltfBaseName({ name: 'My House!' }) === 'my-house', 'gltfBaseName slugifies the project name');
  ok(gltfBaseName({}) === 'home' && gltfBaseName(null) === 'home', 'gltfBaseName falls back to "home"');
}

// ── summary ───────────────────────────────────────────────────────────────────
if (fail === 0) console.log(`\nALL PASS — ${pass} passed, 0 failed`);
else { console.log(`\nFAILED — ${pass} passed, ${fail} failed`); for (const f of fails) console.log('  · ' + f); process.exit(1); }
