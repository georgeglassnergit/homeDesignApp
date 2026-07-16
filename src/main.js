import { createViewer } from './viewer/viewer.js';
import { createWalkController } from './viewer/walkCamera.js';
import { buildScene, sceneBounds, rebuildGeometry } from './build/sceneBuilder.js';
import { serialize, deserialize, validateProject, projectCounts } from './core/model.js';
import { createAppState, availableTools, MODE, TOOL, VIEW, CAMERA } from './app/state.js';
import { cutawayHiddenWalls } from './viewer/cutaway.js';
import { formatLength } from './core/units.js';
import { History } from './edit/history.js';
import { ToolController } from './edit/tools.js';
import { createPlanView } from './edit/planView.js';
import { raycast, eventToNDC } from './edit/picking.js';
import { createPlanCanvas } from './app/planCanvas.js';
import { STARTERS } from './templates/starters.js';
import { loadTemplate, setView } from './edit/commands.js';
import { createDirtyTracker } from './app/dirty.js';
import { planThumbnailSVG } from './app/thumbnail.js';

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
      // keep the view seam in sync (undo/redo/template-load may change meta.view)
      app.view = (project.meta && project.meta.view) || VIEW.EXTERIOR;
      syncViewButtons();
      updateStatus();
    }

    // S5: exterior <-> cutaway. View is a display pref (project.meta.view); the per-frame
    // hook re-applies visibility every frame so the cutaway self-corrects as the camera
    // orbits. It only toggles mesh.visible — geometry (and object count) is never mutated.
    function applyView() {
      const cutaway = ((project.meta && project.meta.view) || VIEW.EXTERIOR) === VIEW.CUTAWAY;
      const hidden = cutaway
        ? cutawayHiddenWalls(project.levels.flatMap((l) => l.walls), { x: viewer.camera.position.x, z: viewer.camera.position.z })
        : null;
      for (const obj of home.children) {
        const k = obj.userData.kind;
        if (k === 'roof') obj.visible = !cutaway;
        else if (k === 'wall') obj.visible = !(cutaway && hidden.has(obj.userData.modelId));
        // floors, ground and furniture stay visible in both views
      }
    }
    viewer.onFrame(applyView);

    function updateStatus() {
      const c = spike.counts;
      spike.sceneMeshes = home.children.length;
      setStatus(
        `<span class="ok">✓</span> ${c.walls} walls · ${c.openings} openings · ${c.rooms} rooms<br>` +
        `<span class="ok">✓</span> save/load round-trip ${spike.roundTripOk ? 'lossless' : '<span class="err">FAILED</span>'}<br>` +
        `<span class="muted">tool:</span> ${app.activeTool} · <span class="muted">cam:</span> ${app.camera} · <span class="muted">mode:</span> ${app.mode} · ${availableTools(app.mode).length} tools · undo ${history.undoStack.length}`
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

    // --- exterior / cutaway view toggle (S5) — an undoable, persisted display pref ---
    const viewButtons = [...document.querySelectorAll('#views button')];
    function syncViewButtons() { viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === app.view)); }
    viewButtons.forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.view;
      if (v === app.view) return;
      history.execute(setView(v));   // do() writes project.meta.view; refresh() re-syncs app.view + buttons
      refresh();
    }));

    // --- orbit / walk-through camera toggle (S6) — pure view state, no model fields ---
    // Walk drives the same perspective camera at eye height; orbit input is suspended while
    // walking and restored (with a fresh framing) on exit. Esc also exits walk.
    const walk = createWalkController(viewer);
    const cameraButtons = [...document.querySelectorAll('#cameras button')];
    function syncCameraButtons() { cameraButtons.forEach((b) => b.classList.toggle('active', b.dataset.camera === app.camera)); }
    function setCamera(mode) {
      if (mode === app.camera) return;
      if (mode === CAMERA.WALK) {
        walk.enable(project.levels.flatMap((l) => l.walls), project.levels[0]);
        app.camera = CAMERA.WALK;
        hint('Walk: WASD / arrows to move · drag to look · Esc to exit');
      } else {
        walk.disable();
        viewer.frame(sceneBounds(home), 1.4);   // hand a sensible view back to orbit
        app.camera = CAMERA.ORBIT;
      }
      syncCameraButtons();
      updateStatus();
    }
    cameraButtons.forEach((b) => b.addEventListener('click', () => setCamera(b.dataset.camera)));

    // --- S4 template picker: a start screen (shown on boot) + a reopenable overlay ---
    // Loading a starter swaps the whole project via the undoable loadTemplate command,
    // reframes both views, and resets the "clean" baseline (a freshly loaded template is
    // not dirty). Reopening after edits confirms before discarding unsaved work. "Dirty"
    // is pure model identity — the current serialized project vs. the last clean baseline —
    // so it needs no flags scattered through the edit layer (see app/dirty.js).
    const dirty = createDirtyTracker(serialize(project));

    function loadStarter(s) {
      if (app.camera === CAMERA.WALK) setCamera(CAMERA.ORBIT);   // walls change → leave walk cleanly
      history.execute(loadTemplate(s.build()));
      controller.levelId = project.levels[0].id;
      app.selection = null;
      refresh();
      dirty.markClean(serialize(project));   // a freshly loaded template is the new clean baseline
      plan.frameModel();
      viewer.frame(sceneBounds(home), 1.4);
    }

    const pickerEl = $('picker');
    const noteEl = $('picker-note');
    let pickerInitial = false;
    const isDirty = () => dirty.isDirty(serialize(project));
    function openPicker(initial = false) {
      pickerInitial = initial;
      noteEl.textContent = (!initial && isDirty()) ? 'You have unsaved changes — loading a template will discard them.' : '';
      pickerEl.classList.add('open');
    }
    function closePicker() { pickerEl.classList.remove('open'); }

    // confirmDiscard is injectable so the headless harness can drive the flow deterministically
    let confirmDiscard = (name) => confirm(`Discard unsaved changes and load "${name}"?`);
    function pick(id) {
      const s = STARTERS.find((x) => x.id === id);
      if (!s) return false;
      // the initial start screen has nothing to lose; a re-open after edits confirms first
      if (!pickerInitial && isDirty() && !confirmDiscard(s.label)) return false;   // keep current
      loadStarter(s);
      closePicker();
      return true;
    }

    // Build the template cards once. Each thumbnail is a pure function of the starter's
    // model (app/thumbnail.js) — novices pick a shape, not a name.
    const grid = $('picker-grid');
    for (const s of STARTERS) {
      const card = document.createElement('button');
      card.className = 'tpl-card'; card.dataset.id = s.id; card.title = s.desc;
      card.innerHTML = `<div class="thumb">${planThumbnailSVG(s.build())}</div>`
        + `<div class="name">${s.label}</div><div class="desc">${s.desc}</div>`;
      card.addEventListener('click', () => pick(s.id));
      grid.appendChild(card);
    }
    // Deferred onboarding tiles — RoomSketcher's blank / template / import / outsource
    // pattern; import + outsource are Phase 3+, shown disabled so the roadmap reads.
    for (const soon of [
      { label: 'Import a plan', desc: 'Trace an uploaded floor plan.' },
      { label: 'Outsource',     desc: 'Have your home drawn for you.' },
    ]) {
      const card = document.createElement('button');
      card.className = 'tpl-card'; card.disabled = true;
      card.innerHTML = `<div class="thumb">${planThumbnailSVG({ levels: [] })}</div>`
        + `<div class="name">${soon.label}</div><div class="desc">${soon.desc}</div><div class="soon">Coming soon</div>`;
      grid.appendChild(card);
    }

    $('new').addEventListener('click', () => openPicker(false));
    $('picker-close').addEventListener('click', closePicker);

    // --- 3D-view selection via raycasting (VIEW-LAYER-CONTRACT §2) ---
    viewer.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (app.camera === CAMERA.WALK) return;        // in walk mode drag = look, not select
      if (app.activeTool !== TOOL.SELECT) return;   // don't fight orbit while drawing
      const hitObj = raycast(eventToNDC(e, viewer.renderer.domElement), viewer.camera, home);
      app.selection = hitObj && hitObj.modelId ? { kind: hitObj.kind === 'floor' ? 'room' : hitObj.kind, id: hitObj.modelId } : null;
      plan.draw(); updateStatus();
    });

    // --- keyboard: Esc closes the picker / ends a wall run, Del removes, Ctrl+Z/Y undo/redo ---
    addEventListener('keydown', (e) => {
      if (pickerEl.classList.contains('open')) { if (e.key === 'Escape') closePicker(); return; }
      if (e.key === 'Escape') { if (app.camera === CAMERA.WALK) setCamera(CAMERA.ORBIT); else { controller.finishChain(); plan.draw(); } }
      else if (e.key === 'Delete' || e.key === 'Backspace') { controller.deleteSelection(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? controller.redo() : controller.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); controller.redo(); }
    });

    addEventListener('resize', () => plan.resize());

    plan.resize();
    plan.frameModel();
    syncToolButtons();
    syncViewButtons();
    syncCameraButtons();
    updateStatus();
    spike.built = true; spike.booted = true;

    // Open the template picker as the start screen. The sample home is already built
    // behind it, so "Keep current" simply dismisses to it; picking a card swaps in.
    openPicker(true);

    // handles for the headless verification harness
    Object.assign(window, {
      __viewer: viewer, __home: home, __project: () => project, __controller: controller,
      __plan: plan, __planView: planView, __history: history, __state: app, __applyView: applyView,
      __setView: (v) => { history.execute(setView(v)); refresh(); }, __walk: walk, __setCamera: setCamera,
      // S4 picker handles
      __picker: pickerEl, __openPicker: openPicker, __closePicker: closePicker, __pick: pick,
      __isDirty: isDirty, __setConfirm: (fn) => { confirmDiscard = fn; },
    });
    window.__selftest = () => { const j = serialize(project); const p = deserialize(j); return { valid: validateProject(p).ok, lossless: serialize(p) === j, counts: projectCounts(p) }; };
  } catch (e) {
    spike.error = String((e && e.stack) || e);
    setStatus(`<span class="err">✗</span> ${String((e && e.message) || e)}`);
    console.error('[phase2] fatal', e);
  }
})();
