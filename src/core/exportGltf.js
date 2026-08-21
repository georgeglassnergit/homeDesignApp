// Engine-independent glTF 2.0 export — pure data → interchange (no Three.js).
//
// E3 (PHASE-3-PLAN.md) names three interchange formats: "a simpler glTF/OBJ/JSON export
// first." OBJ + JSON already landed (core/exportObj.js). This adds the third, glTF 2.0 —
// the modern, near-universal 3D interchange: it opens in Blender, three.js (GLTFLoader),
// Google model-viewer, Windows 3D Viewer, Babylon, Godot, and most DCC/web tools, and
// unlike OBJ it carries PBR materials (base colour + roughness/metalness) natively.
//
// It exports the SAME building MASSING as the OBJ path — walls as solid boxes, room floors
// as thin slabs — by REUSING the exact mesh helpers from exportObj.js, so the two exporters
// can never drift apart. The output is a single self-contained `.gltf` file: one JSON
// document whose binary geometry buffer is embedded as a base64 `data:` URI, so there is no
// companion `.bin` to keep alongside it (the most portable single-file form).
//
// Deliberate scope (identical to the OBJ export, kept honest):
//   • Openings are NOT cut — the CSG cut lives in the Three.js view layer; a pure export
//     ships the clean watertight primitives (the massing) the CSG consumes. Reported as a note.
//   • Roof shells and external-GLB furniture are not baked in (roof math is in roofShape.js;
//     furniture is a referenced asset). Both are reported as warnings.
//
// Purity / save contract: reads the plan model only, returns a string + counts, mutates
// nothing, adds no save field, never throws on a malformed/partial project. No Three.js, and
// no Node-only APIs (base64 is encoded by a portable table below, not Buffer/btoa), so it runs
// identically under Node (the test suite) and in the browser (the app).

import { wallMesh, roomSlabMesh, hexToRgb01 } from './exportObj.js';

// ---- portable base64 (no Buffer, no btoa — identical in Node and the browser) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Encode a Uint8Array to a base64 string. Standard MIME base64 with '=' padding.
export function bytesToBase64(bytes) {
  let out = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const w = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(w >> 18) & 63] + B64[(w >> 12) & 63] + B64[(w >> 6) & 63] + B64[w & 63];
  }
  const rem = n - i;
  if (rem === 1) {
    const w = bytes[i] << 16;
    out += B64[(w >> 18) & 63] + B64[(w >> 12) & 63] + '==';
  } else if (rem === 2) {
    const w = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(w >> 18) & 63] + B64[(w >> 12) & 63] + B64[(w >> 6) & 63] + '=';
  }
  return out;
}

// ---- glTF numeric constants -------------------------------------------------

const FLOAT = 5126;           // accessor componentType — 32-bit float
const UNSIGNED_INT = 5125;    // accessor componentType — 32-bit unsigned index
const ARRAY_BUFFER = 34962;   // bufferView target — vertex attributes
const ELEMENT_ARRAY_BUFFER = 34963; // bufferView target — indices
const TRIANGLES = 4;          // mesh primitive mode

// ---- level base elevations (mirrors exportObj.levelBases — export never mutates) ----

function levelBases(levels) {
  const out = [];
  let y = 0;
  for (let i = 0; i < levels.length; i++) {
    out.push(i === 0 ? 0 : y);
    y = (i === 0 ? 0 : y) + ((levels[i] && levels[i].height) || 0);
  }
  return out;
}

const sanitize = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]+/g, '_') || 'x';

// Every vertex component must be finite for a valid buffer/accessor min-max.
function meshIsFinite(mesh) {
  for (const v of mesh.verts) if (!(Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]))) return false;
  return true;
}

// ---- the exporter -----------------------------------------------------------

// Export the whole project as a single self-contained glTF 2.0 document (string).
// Pure: returns { gltf, json, counts, warnings }; mutates nothing.
//   opts: { slabThickness=0.05, name }
//
// One mesh + node per element (wall / room floor), each referencing a PBR material derived
// from the project's material map. All geometry shares ONE binary buffer, embedded as a
// base64 data URI so the result is a single portable file.
export function exportGltf(project, opts = {}) {
  const slabThickness = opts.slabThickness ?? 0.05;
  const materials = (project && project.materials) || {};
  const levels = (project && Array.isArray(project.levels)) ? project.levels : [];
  const bases = levelBases(levels);

  // glTF collections we accumulate into.
  const gltfMaterials = [];
  const materialIndex = new Map();        // project material id -> glTF materials[] index
  const meshes = [];
  const nodes = [];
  const nodeIndices = [];
  const accessors = [];
  const bufferViews = [];
  const chunks = [];                       // { bytes: Uint8Array } in buffer order
  let byteLength = 0;                      // running buffer length (kept 4-byte aligned)

  let vertexTotal = 0, triangleTotal = 0, openingCount = 0;

  // Resolve (or lazily create) the glTF material index for a project material id.
  const materialFor = (id) => {
    const key = materials[id] ? id : 'default';
    if (materialIndex.has(key)) return materialIndex.get(key);
    const def = materials[key] || { color: '#cccccc', roughness: 0.9 };
    const [r, g, b] = hexToRgb01(def.color);
    const idx = gltfMaterials.length;
    gltfMaterials.push({
      name: sanitize(key),
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 1],
        metallicFactor: Number.isFinite(def.metalness) ? def.metalness : 0,
        roughnessFactor: Number.isFinite(def.roughness) ? def.roughness : 0.9,
      },
    });
    materialIndex.set(key, idx);
    return idx;
  };

  // Append a typed array to the single buffer as a bufferView; return its index.
  // Float32Array and Uint32Array are both 4-byte-aligned by construction, so the running
  // offset stays 4-aligned with no padding — satisfying glTF's alignment rules.
  const addBufferView = (typed, target) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const view = { buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target };
    bufferViews.push(view);
    chunks.push(bytes);
    byteLength += bytes.length;
    return bufferViews.length - 1;
  };

  // Emit one element mesh as a glTF mesh/node with POSITION + indices accessors.
  const emit = (name, materialId, mesh) => {
    if (!mesh.verts.length || !mesh.tris.length || !meshIsFinite(mesh)) return;

    // POSITION accessor (VEC3 float) with the spec-required min/max.
    const positions = new Float32Array(mesh.verts.length * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.verts.length; i++) {
      const v = mesh.verts[i];
      for (let k = 0; k < 3; k++) {
        positions[i * 3 + k] = v[k];
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
    }
    const posView = addBufferView(positions, ARRAY_BUFFER);
    const posAccessor = accessors.length;
    accessors.push({
      bufferView: posView, componentType: FLOAT, count: mesh.verts.length,
      type: 'VEC3', min, max,
    });

    // Index accessor (SCALAR uint32).
    const indices = new Uint32Array(mesh.tris.length * 3);
    for (let i = 0; i < mesh.tris.length; i++) {
      indices[i * 3] = mesh.tris[i][0];
      indices[i * 3 + 1] = mesh.tris[i][1];
      indices[i * 3 + 2] = mesh.tris[i][2];
    }
    const idxView = addBufferView(indices, ELEMENT_ARRAY_BUFFER);
    const idxAccessor = accessors.length;
    accessors.push({
      bufferView: idxView, componentType: UNSIGNED_INT, count: indices.length, type: 'SCALAR',
    });

    const meshIdx = meshes.length;
    meshes.push({
      name,
      primitives: [{
        attributes: { POSITION: posAccessor },
        indices: idxAccessor,
        material: materialFor(materialId),
        mode: TRIANGLES,
      }],
    });
    nodes.push({ name, mesh: meshIdx });
    nodeIndices.push(nodes.length - 1);

    vertexTotal += mesh.verts.length;
    triangleTotal += mesh.tris.length;
  };

  for (let li = 0; li < levels.length; li++) {
    const lvl = levels[li];
    if (!lvl) continue;
    const baseY = bases[li];
    const tag = sanitize(lvl.name || lvl.id || `L${li}`);
    for (const w of (lvl.walls || [])) { if (!w || !w.a || !w.b) continue; emit(`${tag}__wall_${sanitize(w.id)}`, w.material || 'wall', wallMesh(w, baseY)); }
    for (const r of (lvl.rooms || [])) { if (!r || !Array.isArray(r.points)) continue; emit(`${tag}__floor_${sanitize(r.id)}`, r.material || 'floor', roomSlabMesh(r, baseY, slabThickness)); }
    openingCount += (lvl.openings || []).length;
  }

  // Concatenate every chunk into the single binary buffer, embedded as a data URI.
  const buf = new Uint8Array(byteLength);
  let off = 0;
  for (const bytes of chunks) { buf.set(bytes, off); off += bytes.length; }
  const bufferUri = byteLength
    ? `data:application/octet-stream;base64,${bytesToBase64(buf)}`
    : undefined;

  const warnings = [];
  if (openingCount) warnings.push(`${openingCount} opening(s) left uncut (massing export — openings are a view-layer CSG cut)`);
  if (levels.some((l) => l && l.roof)) warnings.push('roof shell(s) not exported (massing export — walls + floors only)');
  if (project && Array.isArray(project.furniture) && project.furniture.length) {
    warnings.push(`${project.furniture.length} furniture item(s) not exported (external GLB assets)`);
  }

  const doc = {
    asset: { version: '2.0', generator: 'Roomclip glTF export' },
    scene: 0,
    scenes: [{ name: sanitize((project && project.name) || 'home'), nodes: nodeIndices }],
    nodes,
    meshes,
    materials: gltfMaterials,
    accessors,
    bufferViews,
    buffers: byteLength ? [{ byteLength, uri: bufferUri }] : [],
  };

  // A model with no geometry has no buffer, so drop the now-empty buffer-dependent arrays
  // to keep the document strictly valid (glTF forbids empty accessors/bufferViews arrays only
  // when present-but-empty is meaningless; an empty scene of nodes is legal).
  if (!byteLength) {
    delete doc.accessors;
    delete doc.bufferViews;
  }

  const json = JSON.stringify(doc, null, 2);
  return {
    gltf: json,
    json: doc,
    counts: {
      meshes: meshes.length, nodes: nodes.length, materials: gltfMaterials.length,
      vertices: vertexTotal, triangles: triangleTotal, byteLength, openings: openingCount,
    },
    warnings,
  };
}

// Suggest a filesystem-safe base filename (no extension) — mirrors exportObj.exportBaseName
// so the OBJ/JSON/glTF downloads share one naming convention.
export function gltfBaseName(project) {
  const raw = (project && project.name) || 'home';
  const safe = String(raw).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return safe || 'home';
}
