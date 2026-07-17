// app/planCanvas.js — the 2D top-down PLAN surface (browser view code).
// Draws the model with the Canvas 2D API and forwards pointer gestures to the
// ToolController. Uses NO Three.js and stores NO geometry: it reads the plain
// model + planView mapping, and every edit goes through the controller's commands.
import { wallLength } from '../core/model.js';

export function createPlanCanvas(canvas, { project, controller, planView, state, levelId, onSelect }) {
  const ctx = canvas.getContext('2d');
  const notifySelect = () => { if (onSelect) onSelect(); };
  const level = () => project.levels.find((l) => l.id === levelId) || project.levels[0];

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
    if (lv) { drawWalls(lv); drawOpenings(lv); drawVertices(lv); }
    drawPreview();
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

  return { draw, resize, frameModel };
}
