// Engine-independent model export — pure data → interchange text (no Three.js).
//
// E3 (PHASE-3-PLAN.md): "Engine-independent model → interchange. Consider a pure
// JSON/OBJ export before full IFC." This activates the dormant `ifc-export` seam with
// the simplest genuinely-useful formats first:
//   • OBJ  — the building MASSING (walls as solid boxes, room floors as thin slabs),
//            grouped per element, with a companion MTL carrying the project's colours.
//            Opens in Blender / SketchUp / most CAD & DCC tools.
//   • JSON — the project's own lossless save (re-loadable here).
//
// Deliberate scope (kept honest, not a framing spec):
//   • Openings are NOT cut into the OBJ walls — the app's CSG cut lives in the Three.js
//     view layer; a pure export exports clean solid primitives (the massing), same
//     watertight boxes the CSG consumes. Doors/windows are recorded as a comment count.
//   • Roof shells and external-GLB furniture are not baked into the OBJ (roof math lives
//     in roofShape.js; furniture is a referenced asset). Both are reported as warnings.
// Everything here is pure geometry on the plan model, so it is fully unit-testable
// without a browser or renderer.

// ---- small helpers ---------------------------------------------------------

// #rrggbb (or #rgb) → [r,g,b] in 0..1 for an MTL Kd line. Unknown → mid-grey.
export function hexToRgb01(hex) {
  if (typeof hex !== 'string') return [0.8, 0.8, 0.8];
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0.8, 0.8, 0.8];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Signed area of a plan polygon of {x,z} (XZ plane). >0 is CCW in the x-right / z-down
// convention the app's shoelace uses; sign lets us normalise winding before clipping.
function signedArea(points) {
  let s = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

// True if point p is inside triangle (a,b,c) in the XZ plane (barycentric sign test).
function pointInTri(p, a, b, c) {
  const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (d === 0) return false;
  const u = ((b.z - c.z) * (p.x - c.x) + (c.x - b.x) * (p.z - c.z)) / d;
  const v = ((c.z - a.z) * (p.x - c.x) + (a.x - c.x) * (p.z - c.z)) / d;
  const w = 1 - u - v;
  return u >= 0 && v >= 0 && w >= 0;
}

// Ear-clipping triangulation of a SIMPLE polygon of {x,z} points. Returns triangles as
// index triples into the ORIGINAL points array. Winding-normalised (works CW or CCW);
// falls back to a fan for a degenerate/failed clip so the caller always gets a surface.
export function triangulate(points) {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  // work on a CCW copy of the index ring
  let idx = points.map((_, i) => i);
  if (signedArea(points) < 0) idx.reverse();
  const tris = [];
  let guard = 0;
  const limit = n * n + 4;
  while (idx.length > 3 && guard++ < limit) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ai = idx[(i + idx.length - 1) % idx.length];
      const bi = idx[i];
      const ci = idx[(i + 1) % idx.length];
      const a = points[ai], b = points[bi], c = points[ci];
      // convex corner? (cross of (b-a)x(c-b) positive for CCW)
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      if (cross <= 0) continue;
      // no other vertex inside this ear
      let hasInside = false;
      for (let j = 0; j < idx.length; j++) {
        const pj = idx[j];
        if (pj === ai || pj === bi || pj === ci) continue;
        if (pointInTri(points[pj], a, b, c)) { hasInside = true; break; }
      }
      if (hasInside) continue;
      tris.push([ai, bi, ci]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate — fall back below
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  // safety fallback: if clipping stalled, fan the remaining ring
  if (idx.length > 3) {
    for (let i = 1; i < idx.length - 1; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
  }
  return tris;
}

// ---- per-element meshes (local, 0-indexed) ---------------------------------

// A wall as a solid rectangular prism: its centreline a→b extruded ±thickness/2 in plan
// and from baseY up by its height. 8 verts, 12 triangles. Same clean box the CSG consumes.
export function wallMesh(wall, baseY = 0) {
  const { a, b } = wall;
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = (-dz / len) * (wall.thickness / 2);
  const nz = (dx / len) * (wall.thickness / 2);
  const y0 = baseY, y1 = baseY + wall.height;
  // base ring (0..3) then top ring (4..7)
  const verts = [
    [a.x + nx, y0, a.z + nz], [a.x - nx, y0, a.z - nz],
    [b.x - nx, y0, b.z - nz], [b.x + nx, y0, b.z + nz],
    [a.x + nx, y1, a.z + nz], [a.x - nx, y1, a.z - nz],
    [b.x - nx, y1, b.z - nz], [b.x + nx, y1, b.z + nz],
  ];
  const tris = [
    [0, 2, 1], [0, 3, 2],           // bottom
    [4, 5, 6], [4, 6, 7],           // top
    [0, 1, 5], [0, 5, 4],           // side a
    [1, 2, 6], [1, 6, 5],           // side (b-)
    [2, 3, 7], [2, 7, 6],           // side b
    [3, 0, 4], [3, 4, 7],           // side (a+)
  ];
  return { verts, tris };
}

// A room floor as a thin slab: the polygon triangulated as a top cap at baseY, an
// identical bottom cap at baseY-thickness, and vertical quads around the perimeter.
export function roomSlabMesh(room, baseY = 0, thickness = 0.05) {
  const pts = room.points;
  const n = pts.length;
  if (n < 3) return { verts: [], tris: [] };
  const top = baseY, bot = baseY - thickness;
  const verts = [];
  for (const p of pts) verts.push([p.x, top, p.z]);   // 0 .. n-1  top ring
  for (const p of pts) verts.push([p.x, bot, p.z]);   // n .. 2n-1 bottom ring
  const capTris = triangulate(pts);
  const tris = [];
  for (const [i, j, k] of capTris) tris.push([i, j, k]);                 // top cap (up)
  for (const [i, j, k] of capTris) tris.push([n + i, n + k, n + j]);     // bottom cap (down)
  for (let i = 0; i < n; i++) {                                          // perimeter walls
    const j = (i + 1) % n;
    tris.push([i, j, n + j], [i, n + j, n + i]);
  }
  return { verts, tris };
}

// ---- OBJ assembly ----------------------------------------------------------

function fmt(v) {
  // compact but lossless-enough for interchange; trims trailing zeros
  return Number.isFinite(v) ? parseFloat(v.toFixed(6)).toString() : '0';
}

// Cumulative storey base elevations WITHOUT mutating the project (mirrors stackElevations
// but returns a plain array — an export must never touch the model).
function levelBases(levels) {
  const out = [];
  let y = 0;
  for (let i = 0; i < levels.length; i++) {
    out.push(i === 0 ? 0 : y);
    y = (i === 0 ? 0 : y) + (levels[i].height || 0);
  }
  return out;
}

const sanitize = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]+/g, '_') || 'x';

// Export the whole project as Wavefront OBJ (+ companion MTL). Pure: returns strings and
// counts, mutates nothing. opts: { slabThickness=0.05, mtlName='roomclip.mtl', name }.
export function exportObj(project, opts = {}) {
  const slabThickness = opts.slabThickness ?? 0.05;
  const mtlName = opts.mtlName || 'roomclip.mtl';
  const materials = (project && project.materials) || {};
  const levels = (project && Array.isArray(project.levels)) ? project.levels : [];
  const bases = levelBases(levels);

  const lines = [];
  const usedMaterials = new Set();
  let vbase = 0;                 // running global vertex count (OBJ is 1-indexed)
  let objects = 0, groups = 0, faceCount = 0, openingCount = 0;

  lines.push(`# Roomclip export — ${(project && project.name) || 'Untitled home'}`);
  lines.push('# Wavefront OBJ · units: metres · Y up · building massing (walls + floors)');
  lines.push(`mtllib ${mtlName}`);

  const emit = (name, material, mesh) => {
    if (!mesh.verts.length) return;
    lines.push(`o ${name}`);
    objects++;
    const mtl = materials[material] ? material : 'default';
    usedMaterials.add(mtl);
    lines.push(`usemtl ${sanitize(mtl)}`);
    groups++;
    for (const [x, y, z] of mesh.verts) lines.push(`v ${fmt(x)} ${fmt(y)} ${fmt(z)}`);
    for (const [i, j, k] of mesh.tris) {
      lines.push(`f ${vbase + i + 1} ${vbase + j + 1} ${vbase + k + 1}`);
      faceCount++;
    }
    vbase += mesh.verts.length;
  };

  for (let li = 0; li < levels.length; li++) {
    const lvl = levels[li];
    const baseY = bases[li];
    const tag = sanitize(lvl.name || lvl.id || `L${li}`);
    for (const w of (lvl.walls || [])) emit(`${tag}__wall_${sanitize(w.id)}`, w.material || 'wall', wallMesh(w, baseY));
    for (const r of (lvl.rooms || [])) emit(`${tag}__floor_${sanitize(r.id)}`, r.material || 'floor', roomSlabMesh(r, baseY, slabThickness));
    openingCount += (lvl.openings || []).length;
  }

  const warnings = [];
  if (openingCount) warnings.push(`${openingCount} opening(s) left uncut (massing export — openings are a view-layer CSG cut)`);
  if (levels.some((l) => l.roof)) warnings.push('roof shell(s) not exported (massing export — walls + floors only)');
  if (project && Array.isArray(project.furniture) && project.furniture.length) {
    warnings.push(`${project.furniture.length} furniture item(s) not exported (external GLB assets)`);
  }
  for (const w of warnings) lines.push(`# note: ${w}`);

  const obj = lines.join('\n') + '\n';
  const mtl = buildMtl(materials, usedMaterials);
  return {
    obj,
    mtl,
    counts: { objects, groups, vertices: vbase, faces: faceCount, materials: usedMaterials.size, openings: openingCount },
    warnings,
  };
}

// Companion MTL: one `newmtl` per material actually used, coloured from the project map.
export function buildMtl(materials, used) {
  const ids = used && used.size ? [...used] : ['default'];
  const out = ['# Roomclip materials'];
  for (const id of ids) {
    const def = (materials && materials[id]) || { color: '#cccccc', roughness: 0.9 };
    const [r, g, b] = hexToRgb01(def.color);
    out.push(`newmtl ${sanitize(id)}`);
    out.push(`Kd ${fmt(r)} ${fmt(g)} ${fmt(b)}`);
    out.push('Ka 0 0 0');
    out.push('d 1');
    out.push('illum 1');
  }
  return out.join('\n') + '\n';
}

// The project's own lossless JSON save, as an export payload. Re-loadable in the app.
export function exportProjectJson(project) {
  return JSON.stringify(project, null, 2);
}

// Suggest a filesystem-safe base filename from the project name (no extension).
export function exportBaseName(project) {
  const raw = (project && project.name) || 'home';
  const safe = String(raw).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return safe || 'home';
}
