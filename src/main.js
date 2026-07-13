import { createViewer } from './viewer/viewer.js';
import { buildScene, sceneBounds, rebuildGeometry } from './build/sceneBuilder.js';
import { serialize, deserialize, validateProject, projectCounts } from './core/model.js';
import { createAppState, availableTools, MODE, TOOL } from './app/state.js';
import { formatLength } from './core/units.js';
import { History } from './edit/history.js';
import { ToolController } from './edit/tools.js';
import { createPlanView } from './edit/planView.js';
import { raycast, eventToNDC } from './edit/picking.js';
import { createPlanCanvas } from './app/planCanvas.js';
import { STARTERS } from './templates/starters.js';
import { loadTemplate } from './edit/commands.js';

const spike = { booted: false, built: false, sceneMeshes: 0, roundTripOk: false, counts: null, error: null };
window.__app = spike;
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const setStatus = (html) => { if (statusEl) statusEl.innerHTML = html; };
const hint = (t) => { const h = $('toolhint'); if (h) h.textContent = t; };

(async () => {
  try {
    const app = createAppState({ mode: MODE.SIMPLE });
    // Start from the two-room sample home so the app opens on something to edit
    // (matches the Phase 1 verification scene). A starter dropdown swaps it live.
    let project = STARTERS.find((s) => s.id === 'two').build();

    // --- validate + lossless save/load round-trip self-test (proves the save format) ---
    const runRoundTrip = () => {
      const json = serialize(project);
      const reloaded = deserialize(json);
      spike.roundTripOk = validateProject(reloaded).ok && serialize(reloaded) === json;
      spike.counts = projectCounts(project);
      return spike.roundTripOk;
    };
    const v = validateProject(project);
    if (!v.ok) throw new Error('invalid project: ' + v.errors.join('; '));
    runRoundTrip();

    // --- 3D viewer + scene from the model ---
    const viewer = createViewer($('app'));
    let home = await buildScene(project);
    viewer.scene.add(home);
    viewer.frame(sceneBounds(home), 1.4);
    viewer.start();

    // --- edit stack: history + tool controller + plan surface ---
    const history = new History(project, { limit: 200 });
    const planCanvasEl = $('plan');
    const planView = createPlanView({ width: planCanvasEl.clientWidth || 400, height: planCanvasEl.clientHeight || 400, pxPerMeter: 40 });

    const controller = new ToolController({
      state: app, history, project, planView,
      levelId: project.levels[0].id,
      rebuild: () => refresh(),        // set below (function hoisted)
    });

    const plan = createPlanCanvas(planCanvasEl, { project, controller, planView, state: app, levelId: project.levels[0].id });

    // A model edit re-derives the 3D geometry and redraws the plan + status. The model
    // is the single source of truth; both views are pure functions of it.
    function refresh() {
      rebuildGeometry(home, project);
      plan.draw();
      runRoundTrip();
      updateStatus();
    }

    function updateStatus() {
      const c = spike.counts;
      spike.sceneMeshes = home.children.length;
      setStatus(
        `<span class="ok">✓</span> ${c.walls} walls · ${c.openings} openings · ${c.rooms} rooms<br>` +
        `<span class="ok">✓</span> save/load round-trip ${spike.roundTripOk ? 'lossless' : '<span class="err">FAILED</span>'}<br>` +
        `<span class="muted">tool:</span> ${app.activeTool} · <span class="muted">mode:</span> ${app.mode} · ${availableTools(app.mode).length} tools · undo ${history.undoStack.length}`
      );
    }

    // --- toolbar wiring ---
    const toolButtons = [...document.querySelectorAll('#tools button')];
    const syncToolButtons = () => toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === app.activeTool));
    const HINTS = {
      [TOOL.SELECT]: 'Click a wall to select · drag a corner to move it',
      [TOOL.DRAW_WALL]: 'Click each corner to draw walls · Esc or right-click ends the run',
      [TOOL.PLACE_DOOR]: 'Click a wall to drop a door',
      [TOOL.PLACE_WINDOW]: 'Click a wall to drop a window',
    };
    toolButtons.forEach((b) => b.addEventListener('click', () => {
      controller.setTool(b.dataset.tool); syncToolButtons(); hint(HINTS[app.activeTool] || ''); updateStatus();
    }));

    $('delete').addEventListener('click', () => controller.deleteSelection());
    $('undo').addEventListener('click', () => controller.undo());
    $('redo').addEventListener('click', () => controller.redo());

    // --- starter dropdown (drives the existing loadTemplate command) ---
    const tpl = $('tpl');
    for (const s of STARTERS) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.label; tpl.appendChild(o); }
    tpl.value = 'two';
    tpl.addEventListener('change', () => {
      const s = STARTERS.find((x) => x.id === tpl.value); if (!s) return;
      history.execute(loadTemplate(s.build()));
      controller.levelId = project.levels[0].id;
      app.selection = null;
      refresh();
      plan.frameModel();
      viewer.frame(sceneBounds(home), 1.4);
    });

    // --- 3D-view selection via raycasting (VIEW-LAYER-CONTRACT §2) ---
    viewer.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (app.activeTool !== TOOL.SELECT) return;   // don't fight orbit while drawing
      const hitObj = raycast(eventToNDC(e, viewer.renderer.domElement), viewer.camera, home);
      app.selection = hitObj && hitObj.modelId ? { kind: hitObj.kind === 'floor' ? 'room' : hitObj.kind, id: hitObj.modelId } : null;
      plan.draw(); updateStatus();
    });

    // --- keyboard: Esc ends a wall run, Del removes selection, Ctrl+Z/Y undo/redo ---
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { controller.finishChain(); plan.draw(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { controller.deleteSelection(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? controller.redo() : controller.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); controller.redo(); }
    });

    addEventListener('resize', () => plan.resize());

    plan.resize();
    plan.frameModel();
    syncToolButtons();
    updateStatus();
    spike.built = true; spike.booted = true;

    // handles for the headless verification harness
    Object.assign(window, { __viewer: viewer, __home: home, __project: () => project, __controller: controller, __plan: plan, __planView: planView, __history: history, __state: app });
    window.__selftest = () => { const j = serialize(project); const p = deserialize(j); return { valid: validateProject(p).ok, lossless: serialize(p) === j, counts: projectCounts(p) }; };
  } catch (e) {
    spike.error = String((e && e.stack) || e);
    setStatus(`<span class="err">✗</span> ${String((e && e.message) || e)}`);
    console.error('[phase2] fatal', e);
  }
})();
