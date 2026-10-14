// Engine-independent 2D floor-plan export — pure model → SVG text (no Three.js).
//
// E3 (PHASE-3-PLAN.md) activated the `ifc-export` seam with 3D-massing formats (OBJ, glTF), the
// lossless JSON save, and a 2D DXF plan (exportDxf.js). DXF is the *professional* 2D interchange:
// it is exactly what a drafter opens, but it needs CAD software (AutoCAD, LibreCAD, QCAD…) to see
// at all. A novice — the person this app is built for — has none of that. What they actually want
// when they say "show me my floor plan" is a **picture they can open anywhere**: preview it, drop
// it in an email, paste it into a doc, or print it. SVG is that picture: every browser, phone,
// image viewer, word processor, and slide tool renders it directly, and because it is vector it
// prints crisp at any size.
//
// So this is the novice-first companion to the drafter-first DXF: the *same* plan geometry, drawn
// as a clean, self-contained, human-readable image instead of a CAD interchange.
//
// Deliberate scope (kept honest, same spirit as exportDxf.js / exportObj.js):
//   • Walls are drawn as their true-thickness plan footprint (the mitred quad from wallJoin,
//     REUSED via the shared join engine so the 2D plan and the 3D view can't drift), filled as
//     solid "poché" the way a real floor plan reads.
//   • Openings (doors/windows) are drawn as a gap punched through the wall poché — REUSING the
//     exact same `openingRect` the DXF export and the CSG cut use — so a door/window reads as an
//     opening in the wall, not a separate box.
//   • Rooms are drawn as a filled boundary + a centroid label (name + area).
//   • Multiple storeys are laid out side by side, each under its own title, at one shared scale.
//   • Roofs and external-GLB furniture are 3D/asset concerns and are reported as a header note,
//     not drawn into the 2D plan (same as DXF's / OBJ's massing scope).
//
// Coordinate mapping: the app's plan is x-right / z-down (see model.js shoelace). SVG's Y axis is
// ALSO down, so world (x, z) maps straight to SVG (x, z) with no flip — what reads as "down" on
// the plan canvas stays down in the image, and the drawing is never mirrored.
//
// Everything here is pure plan geometry + string composition, so it is fully unit-testable
// without a browser or renderer.

import { joinWalls } from './wallJoin.js';
import { polygonArea, polygonCentroid } from './model.js';
import { UNIT, formatArea, formatLength } from './units.js';
import { openingRect } from './exportDxf.js';

// ---- formatting / escaping -------------------------------------------------

// Compact SVG coordinate: 2dp, trailing zeros trimmed; non-finite collapses to 0 so a malformed
// point can never emit "NaN"/"Infinity" into the markup (which would break the whole image).
function fmt(v) {
  return Number.isFinite(v) ? parseFloat(v.toFixed(2)).toString() : '0';
}

// Escape text for an SVG/XML text node or attribute value. SVG is UTF-8, so unlike DXF we keep
// the real characters (m², accents, CJK) — we only neutralise the five XML-significant ones.
export function svgEscape(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A warm, print-friendly palette that echoes the app's own UI (index.html) so an exported plan
// looks like it came from Roomclip. Colours are plain hex so the SVG is self-contained.
const STYLE = Object.freeze({
  page: '#faf7f1',       // page background (warm cream)
  wall: '#3a3128',       // wall poché (dark warm)
  roomFill: '#f0e9dc',   // room floor tint
  roomStroke: '#c3b39c', // room boundary
  opening: '#2f6f9f',    // door/window accent (matches DXF's blue openings layer)
  ink: '#4a4034',        // labels
  faint: '#8a7c6c',      // secondary text (scale, disclaimer)
});

// ---- geometry gathering ----------------------------------------------------

// Pull the drawable plan geometry out of one level, in world {x,z}. No rendering yet — this is the
// pure model→geometry step the tests assert against, kept separate from the SVG string building.
function gatherLevel(lvl) {
  const walls = Array.isArray(lvl && lvl.walls) ? lvl.walls : [];
  const joined = joinWalls(walls);
  const quadById = new Map(joined.map((j) => [j.id, j.quad]));
  const wallQuads = [];
  for (const w of walls) {
    const quad = quadById.get(w.id);
    if (quad && quad.length === 4) wallQuads.push(quad);
  }

  const wallById = new Map(walls.map((w) => [w.id, w]));
  const openingRects = [];
  for (const op of (Array.isArray(lvl && lvl.openings) ? lvl.openings : [])) {
    const w = wallById.get(op.wallId);
    if (!w) continue;
    const rect = openingRect(w, op);
    if (rect.length === 4) openingRects.push(rect);
  }

  const rooms = [];
  for (const room of (Array.isArray(lvl && lvl.rooms) ? lvl.rooms : [])) {
    const pts = Array.isArray(room.points) ? room.points : [];
    if (pts.length < 3) continue;
    rooms.push({
      points: pts,
      name: room.name || 'Room',
      area: polygonArea(pts),
      centroid: polygonCentroid(pts),
    });
  }

  return { wallQuads, openingRects, rooms };
}

// Grow a mutable bbox {minX,minZ,maxX,maxZ} by one finite point.
function grow(box, p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
  if (p.x < box.minX) box.minX = p.x;
  if (p.x > box.maxX) box.maxX = p.x;
  if (p.z < box.minZ) box.minZ = p.z;
  if (p.z > box.maxZ) box.maxZ = p.z;
}

// The plan-space bounding box of one gathered level, or null if it has no drawable geometry.
function levelBox(g) {
  const box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const q of g.wallQuads) for (const p of q) grow(box, p);
  for (const r of g.openingRects) for (const p of r) grow(box, p);
  for (const room of g.rooms) for (const p of room.points) grow(box, p);
  if (!Number.isFinite(box.minX)) return null;
  return box;
}

// ---- SVG string building ---------------------------------------------------

function polyPoints(pts, ox, oz, scale) {
  return pts.map((p) => `${fmt((p.x - ox) * scale)},${fmt((p.z - oz) * scale)}`).join(' ');
}

// Export the whole project as one self-contained SVG floor-plan image. Pure: returns a string +
// counts/warnings and never touches the model. opts.units (METRIC|IMPERIAL) drives area/scale
// labels; opts.scale is pixels-per-metre (default 50, clamped to a sane range).
export function exportSvg(project, opts = {}) {
  const units = opts.units === UNIT.IMPERIAL ? UNIT.IMPERIAL : UNIT.METRIC;
  const scale = Math.max(4, Math.min(400, Number.isFinite(opts.scale) ? opts.scale : 50));
  const levels = (project && Array.isArray(project.levels)) ? project.levels : [];
  const name = (project && project.name) || 'Untitled home';

  const PAD = 24;          // outer page margin (px)
  const HEADER_H = 40;     // title band
  const LEVEL_TITLE_H = 22;
  const GAP = 44;          // horizontal gap between storeys
  const FOOTER_H = 40;     // scale bar + disclaimer band

  // Gather + box every non-empty level, tracking counts as we go.
  let wallCount = 0, openingCount = 0, roomCount = 0, roofCount = 0, furnitureCount = 0;
  const blocks = [];
  levels.forEach((lvl, li) => {
    const g = gatherLevel(lvl);
    wallCount += g.wallQuads.length;
    openingCount += g.openingRects.length;
    roomCount += g.rooms.length;
    if (lvl && lvl.roof) roofCount++;
    const box = levelBox(g);
    if (!box) return;   // nothing drawable on this storey — skip its panel
    blocks.push({ title: (lvl && (lvl.name || lvl.id)) || `Level ${li + 1}`, g, box });
  });
  if (project && Array.isArray(project.furniture)) furnitureCount = project.furniture.length;

  const contentTop = PAD + HEADER_H;
  const parts = [];
  let cursorX = PAD;
  let maxBlockH = 0;

  for (const b of blocks) {
    const { box, g } = b;
    const wPx = (box.maxX - box.minX) * scale;
    const hPx = (box.maxZ - box.minZ) * scale;
    const gx = cursorX;
    const gy = contentTop + LEVEL_TITLE_H;
    const ox = box.minX, oz = box.minZ;

    const g_ = [];
    // 1) room floor fills, 2) room outlines (drawn first so walls sit on top).
    for (const room of g.rooms) {
      g_.push(`<polygon points="${polyPoints(room.points, ox, oz, scale)}" fill="${STYLE.roomFill}" stroke="${STYLE.roomStroke}" stroke-width="1" stroke-linejoin="round"/>`);
    }
    // 3) wall poché (solid true-thickness footprints).
    for (const q of g.wallQuads) {
      g_.push(`<polygon points="${polyPoints(q, ox, oz, scale)}" fill="${STYLE.wall}" stroke="${STYLE.wall}" stroke-width="0.5"/>`);
    }
    // 4) opening gaps: fill with the page colour to "erase" the wall, thin accent outline so the
    //    door/window is legible even against the room fill.
    for (const rect of g.openingRects) {
      g_.push(`<polygon points="${polyPoints(rect, ox, oz, scale)}" fill="${STYLE.page}" stroke="${STYLE.opening}" stroke-width="1"/>`);
    }
    // 5) room labels (name + area) at the centroid.
    for (const room of g.rooms) {
      const cx = fmt((room.centroid.x - ox) * scale);
      const cy = fmt((room.centroid.z - oz) * scale);
      const label = svgEscape(room.name);
      // Guard the area label ourselves: on the current model, formatArea does not sanitise a
      // non-finite input (it would print "NaN m²"), and a malformed room polygon can produce one.
      const area = svgEscape(Number.isFinite(room.area) ? formatArea(room.area, units) : '—');
      g_.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-family="Georgia, serif" font-size="12" fill="${STYLE.ink}"><tspan x="${cx}" dy="-1">${label}</tspan><tspan x="${cx}" dy="14" font-size="10" fill="${STYLE.faint}">${area}</tspan></text>`);
    }

    parts.push(
      `<text x="${fmt(gx)}" y="${fmt(contentTop + 15)}" font-family="Georgia, serif" font-size="14" font-weight="700" fill="${STYLE.ink}">${svgEscape(b.title)}</text>`,
      `<g transform="translate(${fmt(gx)},${fmt(gy)})">\n    ${g_.join('\n    ')}\n  </g>`,
    );

    if (hPx > maxBlockH) maxBlockH = hPx;
    cursorX = gx + Math.max(wPx, 1) + GAP;
  }

  // Overall canvas size. Fall back to a small friendly canvas when there is nothing to draw.
  const contentW = blocks.length ? (cursorX - GAP + PAD) : (PAD + 260 + PAD);
  const width = Math.max(contentW, PAD + 260 + PAD);
  const contentBottom = contentTop + (blocks.length ? LEVEL_TITLE_H + maxBlockH : 20);
  const height = contentBottom + FOOTER_H + PAD;

  // ---- assemble the document -------------------------------------------------
  const header = [
    `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="${STYLE.page}"/>`,
    `<text x="${PAD}" y="${PAD + 20}" font-family="Georgia, serif" font-size="20" font-weight="700" fill="${STYLE.ink}">${svgEscape(name)}</text>`,
    `<text x="${PAD}" y="${PAD + 36}" font-family="Georgia, serif" font-size="11" fill="${STYLE.faint}">Floor plan · approximate scale 1 m = ${fmt(scale)} px</text>`,
  ];

  // A scale bar in the footer: a labelled bar whose true length is a round number of metres.
  const barY = contentBottom + 16;
  const barMeters = 1;
  const barPx = barMeters * scale;
  const scaleBar = [
    `<line x1="${PAD}" y1="${fmt(barY)}" x2="${fmt(PAD + barPx)}" y2="${fmt(barY)}" stroke="${STYLE.ink}" stroke-width="2"/>`,
    `<line x1="${PAD}" y1="${fmt(barY - 4)}" x2="${PAD}" y2="${fmt(barY + 4)}" stroke="${STYLE.ink}" stroke-width="2"/>`,
    `<line x1="${fmt(PAD + barPx)}" y1="${fmt(barY - 4)}" x2="${fmt(PAD + barPx)}" y2="${fmt(barY + 4)}" stroke="${STYLE.ink}" stroke-width="2"/>`,
    `<text x="${fmt(PAD + barPx + 8)}" y="${fmt(barY + 4)}" font-family="Georgia, serif" font-size="11" fill="${STYLE.faint}">${svgEscape(formatLength(barMeters, units))}</text>`,
  ];

  const disclaimer = `<text x="${PAD}" y="${fmt(height - PAD)}" font-family="Georgia, serif" font-size="10" fill="${STYLE.faint}">Approximate 2D plan for visualization — not a surveyed, engineered, or fabrication drawing.</text>`;

  const empty = blocks.length ? [] : [
    `<text x="${PAD}" y="${fmt(contentTop + 24)}" font-family="Georgia, serif" font-size="13" fill="${STYLE.faint}">Nothing to draw yet — add walls and rooms, then export again.</text>`,
  ];

  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}" role="img" aria-label="${svgEscape(name)} floor plan">\n  ` +
    [...header, ...empty, ...parts, ...scaleBar, disclaimer].join('\n  ') +
    `\n</svg>\n`;

  const warnings = [];
  if (roofCount) warnings.push(`${roofCount} roof(s) not drawn (3D shell — a 2D plan shows the walls beneath)`);
  if (furnitureCount) warnings.push(`${furnitureCount} furniture item(s) not drawn (external 3D assets)`);

  return {
    svg,
    counts: { walls: wallCount, openings: openingCount, rooms: roomCount, levels: blocks.length },
    warnings,
  };
}

// Suggest a base filename (no extension) for the .svg, mirroring dxfBaseName/exportBaseName so all
// four exports name their files consistently.
export function svgBaseName(project) {
  const raw = (project && project.name) || 'home';
  const safe = String(raw).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return safe || 'home';
}
