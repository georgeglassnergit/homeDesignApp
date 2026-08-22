// app/planCanvas.js — the 2D top-down PLAN surface (browser view code).
// Draws the model with the Canvas 2D API and forwards pointer gestures to the
// ToolController. Uses NO Three.js and stores NO geometry: it reads the plain
// model + planView mapping, and every edit goes through the controller's commands.
import { wallLength, polygonArea, polygonCentroid, roomAtPoint, pointInPolygon } from '../core/model.js';
import { measureDistance } from '../edit/measure.js';
import { formatLength, formatArea } from '../core/units.js';
import { underlayWorldRect } from '../core/underlay.js';
import { TOOL } from './state.js';

// A2 — which room should read as "hovered" for a given plan point + active tool.
// Pure resolution (no DOM, no model mutation, no command): a room only warms on hover while
// the SELECT tool is active, so hovering never clutters wall-drawing / door-placing. Returns
// the room id to highlight, or null. Exported so the hover rule is unit-testable without a
// canvas — the pointer wiring below is the only impure part and just calls this + redraws.
export function hoverRoomId(level, point, tool) {
  if (tool !== TOOL.SELECT) return null;
  const room = roomAtPoint(level, point);
  return room ? room.id : null;
}

// A4 — which detected-room candidate (if any) sits under a plan point. Candidates are the
// derived-on-read polygons from detectNewRooms (pure view state — never saved); clicking one
// adds it as a real room. Pure resolution (no DOM, no mutation): returns the index of the
// smallest-area candidate containing the point (so a nested candidate wins over the room that
// encloses it, mirroring roomAtPoint's tie-break), or -1 when the point is over none. Exported
// so the hit-test is unit-testable without a canvas.
export function candidateAtPoint(candidates, point) {
  if (!Array.isArray(candidates)) return -1;
  let best = -1, bestArea = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const pts = candidates[i] && candidates[i].points;
    if (!Array.isArray(pts) || pts.length < 3) continue;
    if (!pointInPolygon(point, pts)) continue;
    const a = polygonArea(pts);
    if (a < bestArea) { bestArea = a; best = i; }
  }
  return best;
}

export function createPlanCanvas(canvas, { project, controller, planView, state, levelId, onSelect, onRoomActivate, onDetectAdd }) {
  const ctx = canvas.getContext('2d');
  const notifySelect = () => { if (onSelect) onSelect(); };
  let activeLevelId = levelId;                    // retargetable so the plan follows the active storey
  let hoveredId = null;                           // A2: room under the plan cursor (view state — never saved)
  // A4 — detected-room candidates currently offered on the plan: derived-on-read polygons the
  // user can click to add as real rooms. Pure DISPLAY state — never serialized. Cleared whenever
  // the model changes shape under them (level switch, template load) so no stale outline lingers.
  let candidates = [];
  // D1 — the imported floor-plan underlay: a descriptor (core/underlay.js) + the loaded image.
  // Pure DISPLAY state — it is drawn beneath the walls to trace over and NEVER reaches the save.
  let underlay = null;         // frozen underlay descriptor or null
  let underlayImg = null;      // the HTMLImageElement to drawImage(), or null
  // D1 — scale calibration capture: the user clicks two points over a known dimension. Held here
  // (view state) while capturing; on the second click we hand the two WORLD points back and exit.
  let calibrate = null;        // { a:{x,z}|null, cursor:{x,z}|null, onComplete:(a,b)=>void } or null
  const level = () => project.levels.find((l) => l.id === activeLevelId) || project.levels[0];
  // Point the plan surface at a different storey (multi-level editing). The plan only ever
  // draws one level at a time — the storey the user is editing.
  const setLevel = (id) => { activeLevelId = id; candidates = []; };

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    planView.setViewport({ width: w, height: h });
    draw();
  }

  // Center + zoom the plan on the current model footprint (called on load/template swap).
  function frameModel() {
    const lv = level();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    let minX = -3, maxX = 3, minZ = -3, maxZ = 3;
    const pts = lv ? lv.walls.flatMap((wl) => [wl.a, wl.b]) : [];
    if (pts.length) {
      minX = Math.min(...pts.map((p) => p.x)); maxX = Math.max(...pts.map((p) => p.x));
      minZ = Math.min(...pts.map((p) => p.z)); maxZ = Math.max(...pts.map((p) => p.z));
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 4) + 3; // meters visible, with margin
    planView.setViewport({ width: w, height: h, center: { x: cx, z: cz }, pxPerMeter: Math.min(w, h) / span });
    draw();
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#efe9df'; ctx.fillRect(0, 0, w, h);
    drawUnderlay();                 // D1: the traced floor plan sits beneath everything editable
    drawGrid(w, h);
    const lv = level();
    if (lv) { drawRooms(lv); drawWalls(lv); drawOpenings(lv); drawVertices(lv); }
    drawCandidates();               // A4: detected-room outlines float above the walls, click to add
    drawPreview();
    drawMeasure();
    drawCalibrate();
  }

  // A4 — paint the auto-detected room candidates as dashed teal outlines with an "+ Add room"
  // chip at each centroid, so the user sees exactly what a click will create. Pure view: reads
  // the derived candidate polygons (never the save) and draws them ABOVE the walls. No candidate
  // is ever a command until the user clicks it (see the pointerdown handler).
  function drawCandidates() {
    if (!candidates.length) return;
    ctx.save();
    for (const cand of candidates) {
      const pts = cand && cand.points;
      if (!Array.isArray(pts) || pts.length < 3) continue;
      ctx.beginPath();
      pts.forEach((pt, i) => {
        const s = planView.worldToScreen(pt);
        i === 0 ? ctx.moveTo(s.px, s.py) : ctx.lineTo(s.px, s.py);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(46,125,107,.12)';               // soft teal wash — distinct from room amber
      ctx.fill();
      ctx.setLineDash([7, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(46,125,107,.85)';
      ctx.stroke();
      ctx.setLineDash([]);
      // "+ Add room" chip at the centroid
      const c = planView.worldToScreen(polygonCentroid(pts));
      const label = '+ Add room';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width, pad = 6;
      const bx = c.px - tw / 2 - pad, by = c.py - 9, bw = tw + pad * 2, bh = 18, r = 5;
      ctx.beginPath();
      ctx.moveTo(bx + r, by); ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, r); ctx.arcTo(bx, by + bh, bx, by, r);
      ctx.arcTo(bx, by, bx + bw, by, r); ctx.closePath();
      ctx.fillStyle = 'rgba(46,125,107,.92)'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(label, c.px, c.py);
    }
    ctx.restore();
  }

  // D1 — paint the imported floor plan as an axis-aligned underlay. The descriptor gives the
  // image's world rectangle (core/underlay.js); we project its corners through the SAME planView
  // the walls use, so the underlay pans/zooms locked to the model. Drawn at the descriptor's
  // opacity so wall centrelines stay readable on top. No model read, no save touch.
  function drawUnderlay() {
    if (!underlay || !underlayImg) return;
    const r = underlayWorldRect(underlay);
    const tl = planView.worldToScreen({ x: r.minX, z: r.minZ });
    const wpx = r.widthM * planView.vp.pxPerMeter;
    const hpx = r.heightM * planView.vp.pxPerMeter;
    if (!(wpx > 0) || !(hpx > 0)) return;
    ctx.save();
    ctx.globalAlpha = underlay.opacity;
    try { ctx.drawImage(underlayImg, tl.px, tl.py, wpx, hpx); } catch { /* image not decodable yet */ }
    ctx.restore();
  }

  // D1 — calibration overlay: a dashed rubber-band from the first click to the cursor (or the
  // second click). Pure view feedback while the user marks a known dimension; issues no command.
  function drawCalibrate() {
    if (!calibrate || !calibrate.a) return;
    const to = calibrate.b || calibrate.cursor;
    if (!to) return;
    const a = planView.worldToScreen(calibrate.a), b = planView.worldToScreen(to);
    ctx.save();
    ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.strokeStyle = '#2f6db0';
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.px, p.py, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#2f6db0'; ctx.fill(); }
    ctx.restore();
  }

  // Room floors as subtle plan fills, each labelled with its computed floor area at the room
  // centroid (following the display units). The selected room reads warmer with a highlight
  // stroke. Pure view: reads the model's room polygons and derives area/centroid on the fly
  // (core/model.js), stores no geometry and mutates no model. This mirrors the inspector's
  // read-only room readout, surfaced on the plan so every room shows its size at a glance.
  // Drawn UNDER the walls so wall centerlines stay crisp on top of the fill.
  function drawRooms(lv) {
    const sel = state.selection;
    for (const room of lv.rooms || []) {
      if (!room.points || room.points.length < 3) continue;
      const selected = sel && sel.kind === 'room' && sel.id === room.id;
      const hovered = !selected && hoveredId === room.id;   // A2: warm (but not selected) fill on hover
      ctx.beginPath();
      room.points.forEach((pt, i) => {
        const s = planView.worldToScreen(pt);
        i === 0 ? ctx.moveTo(s.px, s.py) : ctx.lineTo(s.px, s.py);
      });
      ctx.closePath();
      ctx.fillStyle = selected ? 'rgba(197,106,44,.18)' : hovered ? 'rgba(197,106,44,.10)' : 'rgba(140,114,86,.10)';
      ctx.fill();
      if (selected) {
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(197,106,44,.55)'; ctx.stroke();
      } else if (hovered) {
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(197,106,44,.30)'; ctx.stroke();
      }
      // area label chip at the centroid
      const c = planView.worldToScreen(polygonCentroid(room.points));
      const label = formatArea(polygonArea(room.points), state.units);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width, pad = 4;
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      ctx.fillRect(c.px - tw / 2 - pad, c.py - 8, tw + pad * 2, 16);
      ctx.fillStyle = selected ? '#7a3d12' : hovered ? '#8a5a2e' : '#6b5946';
      ctx.fillText(label, c.px, c.py);
    }
  }

  function drawGrid(w, h) {
    const step = planView.vp.pxPerMeter; // 1 m
    if (step < 6) return;
    const o = planView.worldToScreen({ x: 0, z: 0 });
    ctx.lineWidth = 1; ctx.strokeStyle = '#e3dccf';
    ctx.beginPath();
    for (let x = o.px % step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = o.py % step; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    // origin axes
    ctx.strokeStyle = '#d3c6b3'; ctx.beginPath();
    ctx.moveTo(o.px, 0); ctx.lineTo(o.px, h); ctx.moveTo(0, o.py); ctx.lineTo(w, o.py); ctx.stroke();
  }

  function drawWalls(lv) {
    const sel = state.selection;
    for (const wall of lv.walls) {
      const a = planView.worldToScreen(wall.a), b = planView.worldToScreen(wall.b);
      const selected = sel && sel.kind === 'wall' && sel.id === wall.id;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(3, wall.thickness * planView.vp.pxPerMeter);
      ctx.strokeStyle = selected ? '#c56a2c' : '#5c4a38';
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    }
  }

  function drawOpenings(lv) {
    for (const op of lv.openings) {
      const wall = lv.walls.find((wl) => wl.id === op.wallId);
      if (!wall) continue;
      const len = wallLength(wall) || 1;
      const dx = (wall.b.x - wall.a.x) / len, dz = (wall.b.z - wall.a.z) / len;
      const s = { x: wall.a.x + dx * op.offset, z: wall.a.z + dz * op.offset };
      const e = { x: wall.a.x + dx * (op.offset + op.width), z: wall.a.z + dz * (op.offset + op.width) };
      const sp = planView.worldToScreen(s), ep = planView.worldToScreen(e);
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(3, wall.thickness * planView.vp.pxPerMeter) + 2;
      ctx.strokeStyle = '#efe9df'; // knock a gap in the wall
      ctx.beginPath(); ctx.moveTo(sp.px, sp.py); ctx.lineTo(ep.px, ep.py); ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = op.kind === 'door' ? '#2e7d6b' : '#3a6ea5';
      ctx.beginPath(); ctx.moveTo(sp.px, sp.py); ctx.lineTo(ep.px, ep.py); ctx.stroke();
    }
  }

  function drawVertices(lv) {
    ctx.fillStyle = '#8a7256';
    const seen = new Set();
    for (const wall of lv.walls) for (const end of ['a', 'b']) {
      const v = wall[end]; const key = v.x.toFixed(3) + ',' + v.z.toFixed(3);
      if (seen.has(key)) continue; seen.add(key);
      const p = planView.worldToScreen(v);
      ctx.beginPath(); ctx.arc(p.px, p.py, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawPreview() {
    const seg = controller.previewSegment();
    if (!seg) return;
    const a = planView.worldToScreen(seg.from), b = planView.worldToScreen(seg.to);
    ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.strokeStyle = '#c56a2c';
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Ruler overlay (Pro-seam measure tool): a dimension line with end ticks and a
  // distance label at the midpoint. Dashed while the second point is being placed,
  // solid once committed. Reads controller view-state only — mutates nothing.
  function drawMeasure() {
    if (!controller.measureSegment) return;
    const seg = controller.measureSegment();
    if (!seg) return;
    const a = planView.worldToScreen(seg.from), b = planView.worldToScreen(seg.to);
    ctx.save();
    ctx.lineWidth = 2; ctx.strokeStyle = '#c56a2c';
    ctx.setLineDash(seg.complete ? [] : [6, 5]);
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    // end ticks perpendicular to the line
    ctx.setLineDash([]);
    const dx = b.px - a.px, dy = b.py - a.py, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * 6, ny = dx / len * 6;
    ctx.beginPath();
    ctx.moveTo(a.px - nx, a.py - ny); ctx.lineTo(a.px + nx, a.py + ny);
    ctx.moveTo(b.px - nx, b.py - ny); ctx.lineTo(b.px + nx, b.py + ny);
    ctx.stroke();
    // distance label on a rounded chip at the midpoint
    const label = formatLength(measureDistance(seg.from, seg.to), state.units);
    const mx = (a.px + b.px) / 2, my = (a.py + b.py) / 2;
    ctx.font = '600 12px system-ui, sans-serif';
    const tw = ctx.measureText(label).width, pad = 5;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.strokeStyle = '#c56a2c'; ctx.lineWidth = 1;
    const bx = mx - tw / 2 - pad, by = my - 9, bw = tw + pad * 2, bh = 18, r = 5;
    ctx.beginPath();
    ctx.moveTo(bx + r, by); ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, r); ctx.arcTo(bx, by + bh, bx, by, r);
    ctx.arcTo(bx, by, bx + bw, by, r); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7a3d12'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, my + 1);
    ctx.restore();
  }

  // A2: recompute which room the cursor is over (SELECT tool only). Pure view state — issues
  // no command, mutates no model, touches no save. Returns true when the hover target changed
  // so the caller can decide to redraw; callers here always redraw anyway (pointermove).
  function updateHover(world) {
    const id = hoverRoomId(level(), world, state.activeTool);
    if (id === hoveredId) return false;
    hoveredId = id;
    return true;
  }
  function clearHover() {
    if (hoveredId === null) return false;
    hoveredId = null;
    return true;
  }

  // D1 — begin calibrating the underlay's scale. The next two plan clicks mark a known dimension;
  // on the second we hand both WORLD points to onComplete (main.js asks for the real length and
  // rescales the underlay). Pure view capture — no command, no model touch. Returns false if
  // there is nothing to calibrate (no underlay imported yet).
  function startCalibrate(onComplete) {
    if (!underlay) return false;
    calibrate = { a: null, b: null, cursor: null, onComplete };
    return true;
  }
  function cancelCalibrate() { const was = !!calibrate; calibrate = null; if (was) draw(); return was; }
  function isCalibrating() { return !!calibrate; }
  // Feed one world point into the active calibration; returns true once two points are captured.
  function calibratePoint(world) {
    if (!calibrate) return false;
    if (!calibrate.a) { calibrate.a = { x: world.x, z: world.z }; return false; }
    calibrate.b = { x: world.x, z: world.z };
    const { a, b, onComplete } = calibrate;
    calibrate = null;                       // exit capture before firing the callback
    if (onComplete) onComplete(a, b);
    return true;
  }

  // --- pointer wiring: DOM event -> world coords -> controller ---
  const worldAt = (e) => {
    const r = canvas.getBoundingClientRect();
    return planView.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  };
  canvas.addEventListener('pointerdown', (e) => {
    const w = worldAt(e);
    // While calibrating, plan clicks mark the known dimension instead of editing the model.
    if (calibrate) { canvas.setPointerCapture(e.pointerId); calibratePoint(w); draw(); return; }
    // A4: with detected-room candidates showing under the SELECT tool, clicking one adds it as a
    // real room (via onDetectAdd) and takes priority over selection — so the click that says
    // "yes, this is a room" never also starts a drag or reselects a wall underneath it.
    if (candidates.length && state.activeTool === TOOL.SELECT && onDetectAdd) {
      const idx = candidateAtPoint(candidates, w);
      if (idx >= 0) { canvas.setPointerCapture(e.pointerId); onDetectAdd(candidates[idx], idx); return; }
    }
    canvas.setPointerCapture(e.pointerId); controller.pointerDown(w); draw(); notifySelect();
  });
  canvas.addEventListener('pointermove', (e) => {
    const w = worldAt(e);
    if (calibrate) { calibrate.cursor = w; draw(); return; }
    updateHover(w); controller.pointerMove(w); draw();
  });
  canvas.addEventListener('pointerup', (e) => { if (calibrate) return; controller.pointerUp(worldAt(e)); draw(); notifySelect(); });
  // Drop the hover highlight when the cursor leaves the plan so no room stays warm off-canvas.
  canvas.addEventListener('pointerleave', () => { if (clearHover()) draw(); });
  // Double-click ends a wall chain (as before). When the SELECT tool is active it is ALSO the
  // plan-side entry to renaming a room: the wiring layer (main.js) resolves the room under the
  // cursor and opens an inline name editor. finishChain() first keeps a mid-draw dbl-click from
  // both ending the chain and opening an editor; onRoomActivate no-ops unless a room is hit.
  canvas.addEventListener('dblclick', (e) => {
    controller.finishChain();
    if (onRoomActivate) onRoomActivate(worldAt(e));
    draw();
  });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); controller.finishChain(); draw(); });

  return {
    draw, resize, frameModel, setLevel,
    // A2 hooks (also used by the headless harness): drive/read the hover highlight.
    updateHover, clearHover, getHoveredId: () => hoveredId,
    // D1 underlay hooks: set/clear the traced floor plan + drive scale calibration (view state only).
    setUnderlay: (descriptor, img) => { underlay = descriptor || null; if (img !== undefined) underlayImg = img || null; draw(); },
    clearUnderlay: () => { underlay = null; underlayImg = null; if (calibrate) calibrate = null; draw(); },
    getUnderlay: () => underlay,
    hasUnderlay: () => !!(underlay && underlayImg),
    startCalibrate, cancelCalibrate, isCalibrating, calibratePoint,
    // A4 detected-room hooks: offer/read/clear the click-to-add candidate outlines (view state only).
    setCandidates: (polys) => { candidates = Array.isArray(polys) ? polys : []; draw(); return candidates.length; },
    getCandidates: () => candidates,
    clearCandidates: () => { const had = candidates.length; candidates = []; if (had) draw(); return had; },
    candidateAt: (world) => candidateAtPoint(candidates, world),
  };
}
