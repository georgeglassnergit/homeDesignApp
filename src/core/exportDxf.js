// Engine-independent 2D floor-plan export — pure model → DXF text (no Three.js).
//
// E3 (PHASE-3-PLAN.md) activated the `ifc-export` seam with 3D-massing formats (OBJ, glTF)
// and the lossless JSON save. Those all describe the building in 3D. What a professional
// drafter, an architect, or an estimator actually opens first is a **2D CAD floor plan** —
// and DXF (AutoCAD Drawing Interchange) is the universal 2D interchange every CAD tool reads
// (AutoCAD, LibreCAD, QCAD, DraftSight, Illustrator, …). This is the format the D2 "Outsource
// — have your home drawn for you" path most wants to travel with the design brief: the drafter
// gets a real, layer-organised vector plan to trace, detail, and redraw to scale.
//
// We emit **DXF R12 (AC1009) ASCII** — the lowest-common-denominator version that every reader
// accepts — organised into layers (walls, openings, rooms, room labels) per storey. Everything
// here is pure plan geometry, so it is fully unit-testable without a browser or renderer.
//
// Deliberate scope (kept honest, same spirit as exportObj.js):
//   • Walls are drawn as their true-thickness plan footprint (the mitred quad from wallJoin,
//     REUSED so the 2D plan and the 3D view can't drift), as a closed polyline per wall.
//   • Openings (doors/windows) are drawn as a rectangle marking the hole in the wall on their
//     own layer — the drafter sees exactly where each door/window sits, to detail properly.
//   • Rooms are drawn as a closed boundary polyline + a TEXT label (name + area) at the centroid.
//   • Roofs and external-GLB furniture are 3D/asset concerns and are reported as a header note,
//     not drawn into the 2D plan (same as OBJ's massing scope).
//   • DXF is 2D, so all storeys are emitted at a shared origin on per-storey layers (freeze the
//     layers you don't want) — no data is dropped.
//
// Coordinate mapping: the app's plan is x-right / z-down (see model.js shoelace). DXF Y is up,
// so we map world (x, z) → DXF (x, -z): what reads as "up" on the plan canvas stays up in CAD,
// and the drawing is not mirrored.

import { joinWalls } from './wallJoin.js';
import { polygonArea, polygonCentroid, wallLength } from './model.js';
import { UNIT, formatArea } from './units.js';

// ---- number / string formatting -------------------------------------------

// Compact decimal for a DXF coordinate: fixed 6dp, trailing zeros trimmed (matches exportObj's
// fmt). DXF real group codes want a plain decimal with a '.'; NaN/∞ collapse to 0.
function fmt(v) {
  return Number.isFinite(v) ? parseFloat(v.toFixed(6)).toString() : '0';
}

// DXF R12 ASCII group codes are single-byte; keep entity text to plain printable ASCII so no
// reader chokes. Map the m² glyph to "m2", drop anything else non-ASCII. Never empty.
export function dxfText(str) {
  const s = String(str == null ? '' : str)
    .replace(/²/g, '2')            // m² → m2
    .replace(/[^\x20-\x7e]/g, '')       // strip remaining non-ASCII
    .trim();
  return s;
}

// A filesystem/layer-safe token (upper-case, CAD layer names are conventionally caps and avoid
// spaces/specials). Never empty.
function tag(str, fallback = 'X') {
  const s = String(str == null ? '' : str).toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

// ---- DXF writer ------------------------------------------------------------

// A tiny group-code accumulator: `.pair(code, value)` pushes one code/value line pair, the unit
// of a DXF file. Keeping every emit as an explicit (code,value) pair is what makes the output
// verifiable line-for-line in the test.
class DxfWriter {
  constructor() { this.lines = []; }
  pair(code, value) { this.lines.push(String(code)); this.lines.push(String(value)); return this; }
  // A closed R12 POLYLINE from plan points [{x,z}] on `layer` (heavy POLYLINE/VERTEX/SEQEND —
  // the form R12 readers universally accept; LWPOLYLINE is R13+).
  polyline(layer, points, closed = true) {
    if (!points || points.length < 2) return this;
    this.pair(0, 'POLYLINE').pair(8, layer).pair(66, 1).pair(70, closed ? 1 : 0);
    for (const p of points) {
      this.pair(0, 'VERTEX').pair(8, layer).pair(10, fmt(p.x)).pair(20, fmt(-p.z)).pair(30, '0');
    }
    this.pair(0, 'SEQEND');
    return this;
  }
  line(layer, a, b) {
    return this.pair(0, 'LINE').pair(8, layer)
      .pair(10, fmt(a.x)).pair(20, fmt(-a.z)).pair(30, '0')
      .pair(11, fmt(b.x)).pair(21, fmt(-b.z)).pair(31, '0');
  }
  text(layer, at, height, str) {
    const s = dxfText(str);
    if (!s) return this;
    return this.pair(0, 'TEXT').pair(8, layer)
      .pair(10, fmt(at.x)).pair(20, fmt(-at.z)).pair(30, '0')
      .pair(40, fmt(height)).pair(1, s);
  }
  toString() { return this.lines.join('\n') + '\n'; }
}

// Layer palette (ACI colour index): walls solid, openings blue, rooms grey, labels yellow.
const LAYER_COLOR = { WALLS: 7, OPENINGS: 5, ROOMS: 8, 'ROOM-LABELS': 2 };

// The four plan corners of an opening's hole: a rectangle `width` along the wall × the wall
// thickness across it, positioned at the opening's offset from endpoint a. Returns [] if the
// wall or opening is degenerate. Pure plan geometry — the same numbers the CSG cut uses.
export function openingRect(wall, opening) {
  const len = wallLength(wall);
  if (!(len > 1e-9)) return [];
  const dx = (wall.b.x - wall.a.x) / len, dz = (wall.b.z - wall.a.z) / len;  // unit along wall
  const nx = -dz, nz = dx;                                                    // unit across (left normal)
  const h = Math.max(0, wall.thickness) / 2;
  const o0 = Math.max(0, Math.min(len, opening.offset));                      // near edge, clamped onto the wall
  const o1 = Math.max(0, Math.min(len, opening.offset + opening.width));      // far edge, clamped
  const at = (o, s) => ({
    x: wall.a.x + dx * o + nx * s,
    z: wall.a.z + dz * o + nz * s,
  });
  return [at(o0, -h), at(o1, -h), at(o1, h), at(o0, h)];
}

// Export the whole project as a DXF R12 drawing. Pure: returns a string + counts/warnings and
// never touches the model. opts.units (UNIT.METRIC|IMPERIAL) only affects the area label text.
export function exportDxf(project, opts = {}) {
  const units = opts.units === UNIT.IMPERIAL ? UNIT.IMPERIAL : UNIT.METRIC;
  const levels = (project && Array.isArray(project.levels)) ? project.levels : [];
  const name = (project && project.name) || 'Untitled home';

  // Discover the layers we will actually use, per storey, so the LAYER table declares them all
  // up front (some strict readers reject entities on undeclared layers).
  const entities = new DxfWriter();
  const usedLayers = new Set();
  const use = (l) => { usedLayers.add(l); return l; };
  let wallCount = 0, openingCount = 0, roomCount = 0, roofCount = 0, furnitureCount = 0;

  const seenTags = new Map();  // guard against two storeys slugging to the same layer prefix
  levels.forEach((lvl, li) => {
    let base = tag(lvl.name || lvl.id || `L${li}`, `L${li}`);
    if (seenTags.has(base)) { const n = seenTags.get(base) + 1; seenTags.set(base, n); base = `${base}-${n}`; }
    else seenTags.set(base, 1);
    const LW = `${base}-WALLS`, LO = `${base}-OPENINGS`, LR = `${base}-ROOMS`, LL = `${base}-ROOM-LABELS`;

    // Walls as mitred plan footprints (reuse the shared join engine → 2D matches the 3D view).
    const walls = Array.isArray(lvl.walls) ? lvl.walls : [];
    const joined = joinWalls(walls);
    const quadById = new Map(joined.map((j) => [j.id, j.quad]));
    for (const w of walls) {
      const quad = quadById.get(w.id);
      if (quad && quad.length === 4) { entities.polyline(use(LW), quad, true); wallCount++; }
    }

    // Openings: a rectangle marking each hole, on the openings layer.
    const wallById = new Map(walls.map((w) => [w.id, w]));
    for (const op of (Array.isArray(lvl.openings) ? lvl.openings : [])) {
      const w = wallById.get(op.wallId);
      if (!w) continue;
      const rect = openingRect(w, op);
      if (rect.length === 4) { entities.polyline(use(LO), rect, true); openingCount++; }
    }

    // Rooms: boundary polyline + centroid label (name + area).
    for (const room of (Array.isArray(lvl.rooms) ? lvl.rooms : [])) {
      const pts = Array.isArray(room.points) ? room.points : [];
      if (pts.length < 3) continue;
      entities.polyline(use(LR), pts, true);
      const c = polygonCentroid(pts);
      const area = polygonArea(pts);
      const label = `${dxfText(room.name || 'Room')} ${formatArea(area, units)}`;
      entities.text(use(LL), c, 0.25, label);
      roomCount++;
    }

    if (lvl.roof) roofCount++;
  });

  if (project && Array.isArray(project.furniture)) furnitureCount = project.furniture.length;

  // ---- assemble the DXF document (HEADER · TABLES/LAYER · ENTITIES) ----
  const layerNames = [...usedLayers].sort();
  const doc = new DxfWriter();
  // HEADER: version + drawing units = metres.
  doc.pair(999, `Roomclip 2D plan export — ${dxfText(name)}`);
  doc.pair(0, 'SECTION').pair(2, 'HEADER');
  doc.pair(9, '$ACADVER').pair(1, 'AC1009');
  doc.pair(9, '$INSUNITS').pair(70, 6);          // 6 = metres
  doc.pair(0, 'ENDSEC');
  // TABLES: declare every layer we emitted onto.
  doc.pair(0, 'SECTION').pair(2, 'TABLES');
  doc.pair(0, 'TABLE').pair(2, 'LAYER').pair(70, layerNames.length || 1);
  const declare = (nm, color) => doc.pair(0, 'LAYER').pair(2, nm).pair(70, 0).pair(62, color).pair(6, 'CONTINUOUS');
  if (!layerNames.length) declare('0', 7);
  for (const nm of layerNames) {
    const suffix = nm.slice(nm.lastIndexOf('-') + 1);
    const base = LAYER_COLOR[suffix] != null ? suffix : (LAYER_COLOR[nm] != null ? nm : 'WALLS');
    declare(nm, LAYER_COLOR[base] != null ? LAYER_COLOR[base] : 7);
  }
  doc.pair(0, 'ENDTAB').pair(0, 'ENDSEC');
  // ENTITIES.
  doc.pair(0, 'SECTION').pair(2, 'ENTITIES');
  doc.lines.push(...entities.lines);
  doc.pair(0, 'ENDSEC');
  doc.pair(0, 'EOF');

  const warnings = [];
  if (openingCount) warnings.push(`${openingCount} opening(s) drawn as plan rectangles (a 2D plan marks the hole; the swing/leaf is left for the drafter)`);
  if (roofCount) warnings.push(`${roofCount} roof(s) not drawn (3D shell — a 2D plan shows the walls beneath)`);
  if (furnitureCount) warnings.push(`${furnitureCount} furniture item(s) not drawn (external 3D assets)`);

  return {
    dxf: doc.toString(),
    counts: { walls: wallCount, openings: openingCount, rooms: roomCount, layers: layerNames.length },
    warnings,
  };
}

// Suggest a base filename (no extension) for the .dxf, mirroring exportBaseName.
export function dxfBaseName(project) {
  const raw = (project && project.name) || 'home';
  const safe = String(raw).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return safe || 'home';
}
