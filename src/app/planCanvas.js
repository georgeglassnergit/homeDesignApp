// app/planCanvas.js — the 2D top-down PLAN surface (browser view code).
// Draws the model with the Canvas 2D API and forwards pointer gestures to the
// ToolController. Uses NO Three.js and stores NO geometry: it reads the plain
// model + planView mapping, and every edit goes through the controller's commands.
import { wallLength } from '../core/model.js';
import { measureDistance } from '../edit/measure.js';
import { formatLength } from '../core/units.js';
import { describeRoom } from '../core/roomMeasure.js';

export function createPlanCanvas(canvas, { project, controller, planView, state, levelId, onSelect }) {
  const ctx = canvas.getContext('2d');
  const notifySelect = () => { if (onSelect) onSelect(); };
  let activeLevelId = levelId;                    // retargetable so the plan follows the active storey
  const level = () => project.levels.find((l) => l.id === activeLevelId) || project.levels[0];
  // Point the plan surface at a different storey (multi-level editing). The plan only ever
  // draws one level at a time — the storey the user is editing.
  const setLevel = (id) => { activeLevelId = id; };

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
    drawGrid(w, h);
    const lv = level();
    if (lv) { drawRooms(lv); drawWalls(lv); drawOpenings(lv); drawVertices(lv); }
    drawPreview();
    drawMeasure();
  }

  // Room floors as subtle plan fills, each labelled with its computed floor area at the
  // room centroid (following the display units). The selected room reads warmer. This is
  // pure view: it reads the model's room polygons and derives measurements on the fly
  // (core/roomMeasure.js) — it stores no geometry and mutates no model. Drawn UNDER the
  // walls so wall centerlines stay crisp on top of the fill.
  function drawRooms(lv) {
    const sel = state.selection;
    for (const room of lv.rooms || []) {
      if (!room.points || room.points.length < 3) continue;
      const selected = sel && sel.kind === 'room' && sel.id === room.id;
      ctx.beginPath();
      room.points.forEach((pt, i) => {
        const s = planView.worldToScreen(pt);
        i === 0 ? ctx.moveTo(s.px, s.py) : ctx.lineTo(s.px, s.py);
      });
      ctx.closePath();
      ctx.fillStyle = selected ? 'rgba(197,106,44,.18)' : 'rgba(140,114,86,.10)';
      ctx.fill();
      if (selected) {
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(197,106,44,.55)'; ctx.stroke();
      }
      // area label chip at the centroid
      const info = describeRoom(room, state.units);
      if (!info) continue;
      const c = planView.worldToScreen(info.centroid);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = info.areaLabel;
      const tw = ctx.measureText(label).width, pad = 4;
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      ctx.fillRect(c.px - tw / 2 - pad, c.py - 8, tw + pad * 2, 16);
      ctx.fillStyle = selected ? '#7a3d12' : '#6b5946';
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

  // --- pointer wiring: DOM event -> world coords -> controller ---
  const worldAt = (e) => {
    const r = canvas.getBoundingClientRect();
    return planView.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  };
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); controller.pointerDown(worldAt(e)); draw(); notifySelect(); });
  canvas.addEventListener('pointermove', (e) => { controller.pointerMove(worldAt(e)); draw(); });
  canvas.addEventListener('pointerup', (e) => { controller.pointerUp(worldAt(e)); draw(); notifySelect(); });
  canvas.addEventListener('dblclick', () => { controller.finishChain(); draw(); });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); controller.finishChain(); draw(); });

  return { draw, resize, frameModel, setLevel };
}
