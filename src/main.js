import { createViewer } from './viewer/viewer.js';
import { createWalkController } from './viewer/walkCamera.js';
import { buildScene, sceneBounds, rebuildGeometry } from './build/sceneBuilder.js';
import { serialize, deserialize, validateProject, projectCounts, createLevel, createRoof } from './core/model.js';
import { createAppState, availableTools, isAvailable, MODE, TOOL, VIEW, CAMERA } from './app/state.js';
import { cutawayHiddenWalls } from './viewer/cutaway.js';
import { formatLength, UNIT } from './core/units.js';
import { describeSelection, buildDimensionEdit } from './app/inspector.js';
import { History } from './edit/history.js';
import { ToolController } from './edit/tools.js';
import { createPlanView } from './edit/planView.js';
import { raycast, eventToNDC } from './edit/picking.js';
import { createPlanCanvas } from './app/planCanvas.js';
import { STARTERS } from './templates/starters.js';
import { loadTemplate, setView, addLevel, removeLevel, renameLevel, setLevelHeight, setLevelRoof, setRoofType, composite } from './edit/commands.js';
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
    app.setActiveLevel(project.levels[0].id);   // storey being edited (multi-level, Pro seam)

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
      levelId: app.activeLevelId,
      rebuild: () => refresh(),        // set below (function hoisted)
    });

    const plan = createPlanCanvas(planCanvasEl, { project, controller, planView, state: app, levelId: app.activeLevelId, onSelect: () => renderInspector() });

    // A model edit re-derives the 3D geometry and redraws the plan + status. The model
    // is the single source of truth; both views are pure functions of it.
    // Keep the active storey valid after any model change (undo/redo may remove the level
    // being edited). Falls back to the ground floor and re-points the controller + plan.
    function reconcileActiveLevel() {
      if (!project.levels.some((l) => l.id === app.activeLevelId)) {
        app.setActiveLevel(project.levels[0] ? project.levels[0].id : null);
      }
      controller.levelId = app.activeLevelId;
      plan.setLevel(app.activeLevelId);
    }

    function refresh() {
      reconcileActiveLevel();
      rebuildGeometry(home, project);
      plan.draw();
      runRoundTrip();
      // keep the view seam in sync (undo/redo/template-load may change meta.view)
      app.view = (project.meta && project.meta.view) || VIEW.EXTERIOR;
      syncViewButtons();
      renderInspector();   // selection may have changed (undo/redo/delete/template swap)
      renderLevels();      // storeys may have changed (add/remove/rename/height, or undo/redo)
      renderRoof();        // roof type/pitch may have changed (undo/redo of a roof edit)
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

    // --- selection inspector + Pro-mode exact-dimension entry (the Simple/Pro seam, live) ---
    // The inspector is a pure descriptor of the selection's dimensions (app/inspector.js).
    // Simple mode shows a read-only measurement readout; Pro turns each field into an exact-
    // entry input parsed via units.js. A committed edit runs through history, is re-validated
    // (rejecting a value that no longer fits — e.g. an opening wider than its wall), and rolls
    // back cleanly on failure so the lossless save round-trip is never broken.
    const insBox = $('inspector');
    let committingField = false;   // guards the re-render blur from re-committing

    function renderInspector() {
      if (!insBox) return;
      const desc = describeSelection(project, app.selection, { mode: app.mode, units: app.units });
      if (!desc) {
        insBox.className = '';
        insBox.innerHTML = '<div class="ins-empty">No selection — click a wall, opening, or room floor</div>';
        return;
      }
      const rows = desc.fields.map((f) => desc.editable
        ? `<label class="ins-row"><span>${f.label}</span>`
          + `<input class="ins-field" data-key="${f.key}" value="${f.text}" spellcheck="false" autocomplete="off"></label>`
        : `<div class="ins-row"><span>${f.label}</span><b>${f.text}</b></div>`).join('');
      const foot = desc.editable
        ? `<div class="ins-hint">Type an exact size (e.g. 3.2m or 10'6") and press Enter</div>`
        : desc.measurement
          ? '<div class="ins-hint">Floor area &amp; perimeter, computed from the room shape</div>'
          : '<div class="ins-hint">Switch to <b>Pro</b> to edit exact dimensions</div>';
      insBox.className = desc.editable ? 'editable' : '';
      insBox.innerHTML = `<div class="ins-title">${desc.title}</div>${rows}${foot}<div class="ins-msg" id="ins-msg"></div>`;
      if (desc.editable) {
        insBox.querySelectorAll('.ins-field').forEach((inp) => {
          inp.addEventListener('keydown', (e) => {
            e.stopPropagation();   // keep Del/Ctrl-Z etc. from firing while typing a size
            if (e.key === 'Enter') { e.preventDefault(); commitField(inp.dataset.key, inp.value); }
          });
          inp.addEventListener('blur', () => commitField(inp.dataset.key, inp.value));
        });
      }
    }

    function commitField(key, raw) {
      if (committingField) return;   // re-render on commit blurs the input; don't loop
      committingField = true;
      try {
        const res = buildDimensionEdit(project, app.selection, key, raw, { units: app.units });
        const msg = $('ins-msg');
        if (res.error) { if (msg) msg.textContent = res.error; return; }
        history.execute(res.command);
        const val = validateProject(project);
        if (!val.ok) {                         // out of range (e.g. no longer fits) — roll back
          res.command.undo(project);
          history.undoStack.pop();             // drop it from history entirely
          refresh();
          const m2 = $('ins-msg'); if (m2) m2.textContent = val.errors[0];
          return;
        }
        refresh();                             // rebuild 3D + plan + re-render inspector
      } finally { committingField = false; }
    }

    // --- Pro-seam snapping / constraint settings (the "snapping-constraints" feature) ---
    // Before this, Simple grid-snapped and Pro used the raw point (no snap). Now all three
    // constraints (grid / vertex / angle) are data-driven settings in app.snap. The panel is
    // the single Simple/Pro gate — hidden in Simple, revealed in Pro — and edits app.snap
    // live, then redraws the plan. It's a view pref: nothing here touches the save format.
    const snapGroup = $('snap-group'), snapBtn = $('snap-btn'), snapPanel = $('snap-panel');
    const snapEls = {
      grid: $('snap-grid'), gridStep: $('snap-grid-step'),
      vertex: $('snap-vertex'), angle: $('snap-angle'), angleStep: $('snap-angle-step'),
    };
    function syncSnapControls() {
      const s = app.snap;
      snapEls.grid.checked = s.grid.on;
      snapEls.gridStep.value = s.grid.step;
      snapEls.gridStep.disabled = !s.grid.on;
      snapEls.vertex.checked = s.vertex.on;
      snapEls.angle.checked = s.angle.on;
      snapEls.angleStep.value = String(s.angle.stepDeg);
      snapEls.angleStep.disabled = !s.angle.on;
      // reflect any active constraint on the toolbar button
      snapBtn.classList.toggle('armed', s.grid.on || s.vertex.on || s.angle.on);
    }
    function applySnapFromControls() {
      app.setSnap({
        grid: { on: snapEls.grid.checked, step: parseFloat(snapEls.gridStep.value) },
        vertex: { on: snapEls.vertex.checked },
        angle: { on: snapEls.angle.checked, stepDeg: parseFloat(snapEls.angleStep.value) },
      });
      syncSnapControls();
      plan.draw();
    }
    Object.values(snapEls).forEach((el) => el.addEventListener('change', applySnapFromControls));
    function positionSnapPanel() {
      const r = snapBtn.getBoundingClientRect();
      snapPanel.style.left = Math.max(8, Math.min(r.left, innerWidth - 248)) + 'px';
      snapPanel.style.top = (r.bottom + 6) + 'px';
    }
    function toggleSnapPanel(force) {
      const open = force === undefined ? !snapPanel.classList.contains('open') : force;
      if (open) { syncSnapControls(); positionSnapPanel(); }
      snapPanel.classList.toggle('open', open);
    }
    snapBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSnapPanel(); });
    snapPanel.addEventListener('click', (e) => e.stopPropagation());
    addEventListener('click', () => toggleSnapPanel(false));   // click-away closes
    // The seam: the snap controls appear only when snapping-constraints is available (Pro).
    function syncSnapSeam() {
      const on = isAvailable('snapping-constraints', app.mode);
      snapGroup.classList.toggle('on', on);
      if (!on) toggleSnapPanel(false);
    }

    // --- Pro-seam multi-level (storey) editing (the "multi-level" feature) ---------------
    // The model has always carried Levels[] and the scene builder already stacks every level
    // by elevation; before this, the app hard-pinned levels[0]. Now a Pro user picks which
    // storey the plan edits, and can add / remove / rename storeys and set floor-to-floor
    // heights — each an undoable model command. The panel is the single Simple/Pro gate:
    // hidden in Simple, revealed in Pro. Adding a storey moves the roof to the new top so the
    // stack always caps cleanly. Storeys are pure model data — no new save fields.
    const levelGroup = $('level-group'), levelBtn = $('level-btn'), levelPanel = $('level-panel'), levelListEl = $('level-list');

    // Switch which storey the plan surface + draw tools target (no model change).
    function switchLevel(id) {
      if (id === app.activeLevelId) { toggleLevelPanel(false); return; }
      if (app.camera === CAMERA.WALK) setCamera(CAMERA.ORBIT);   // eye-height context changes
      app.setActiveLevel(id);
      controller.levelId = id;
      plan.setLevel(id);
      app.selection = null;
      plan.frameModel();
      plan.draw();
      renderInspector();
      renderLevels();
      updateStatus();
    }

    function addStorey() {
      const top = project.levels[project.levels.length - 1];
      const lvl = createLevel({ name: `Level ${project.levels.length + 1}`, height: top.height,
        roof: createRoof(top.roof || { type: 'flat' }) });   // new top gets the roof
      const cmds = [addLevel(lvl)];
      if (top.roof) cmds.push(setLevelRoof(top.id, null));    // old top no longer the cap
      history.execute(composite('Add storey', cmds));
      app.setActiveLevel(lvl.id);                             // jump to the storey you just made
      controller.levelId = lvl.id; plan.setLevel(lvl.id); app.selection = null;
      refresh();
      plan.frameModel();
    }

    function removeStorey(id) {
      if (project.levels.length <= 1) return;                 // a home needs a floor
      const idx = project.levels.findIndex((l) => l.id === id);
      if (idx < 0) return;
      const lvl = project.levels[idx];
      const isTop = idx === project.levels.length - 1;
      const cmds = [];
      if (isTop && lvl.roof) cmds.push(setLevelRoof(project.levels[idx - 1].id, createRoof(lvl.roof))); // roof drops down
      cmds.push(removeLevel(id));
      history.execute(composite('Remove storey', cmds));
      app.selection = null;
      refresh();                                              // reconcileActiveLevel re-points if we removed the active storey
      plan.frameModel();
    }

    function commitLevelName(id, raw) {
      const lvl = project.levels.find((l) => l.id === id);
      if (!lvl) return;
      const name = (raw || '').trim() || 'Level';
      if (name === lvl.name) return;
      history.execute(renameLevel(id, name));
      refresh();
    }

    function commitLevelHeight(id, raw) {
      const lvl = project.levels.find((l) => l.id === id);
      if (!lvl) return;
      const h = parseFloat(raw);
      if (!(h > 0)) { renderLevels(); return; }               // ignore invalid; restore shown value
      if (Math.abs(h - lvl.height) < 1e-9) return;
      const cmd = history.execute(setLevelHeight(id, h));
      if (!validateProject(project).ok) { cmd.undo(project); history.undoStack.pop(); }  // never leave the model invalid; drop it entirely
      refresh();
    }

    // Render the storey list top-to-bottom (upper floors first, as they stack in space).
    function renderLevels() {
      if (!levelListEl) return;
      const only = project.levels.length <= 1;
      levelListEl.innerHTML = '';
      for (let i = project.levels.length - 1; i >= 0; i--) {
        const lvl = project.levels[i];
        const row = document.createElement('div');
        row.className = 'lv-row' + (lvl.id === app.activeLevelId ? ' active' : '');
        const pick = document.createElement('button');
        pick.className = 'lv-pick'; pick.title = 'Edit this storey in the plan';
        const nameInp = document.createElement('input');
        nameInp.className = 'lv-name'; nameInp.value = lvl.name; nameInp.spellcheck = false; nameInp.autocomplete = 'off';
        const elev = document.createElement('div');
        elev.className = 'lv-elev'; elev.textContent = `floor ${lvl.elevation.toFixed(2)} m`;
        pick.append(nameInp, elev);
        const hInp = document.createElement('input');
        hInp.className = 'lv-h'; hInp.type = 'number'; hInp.min = '0.1'; hInp.step = '0.1'; hInp.value = lvl.height; hInp.title = 'Floor-to-floor height (m)';
        const del = document.createElement('button');
        del.className = 'lv-del'; del.textContent = '✕'; del.title = only ? 'A home needs at least one storey' : 'Remove this storey'; del.disabled = only;
        row.append(pick, hInp, del);
        levelListEl.appendChild(row);
        // wiring — clicking the pick area (not the name field being edited) switches storey
        pick.addEventListener('click', (e) => { if (e.target !== nameInp) switchLevel(lvl.id); });
        nameInp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); nameInp.blur(); } });
        nameInp.addEventListener('blur', () => commitLevelName(lvl.id, nameInp.value));
        hInp.addEventListener('keydown', (e) => e.stopPropagation());
        hInp.addEventListener('change', () => commitLevelHeight(lvl.id, hInp.value));
        del.addEventListener('click', (e) => { e.stopPropagation(); removeStorey(lvl.id); });
      }
      levelBtn.classList.toggle('armed', project.levels.length > 1);   // multi-storey reads at a glance
    }

    $('level-add').addEventListener('click', (e) => { e.stopPropagation(); addStorey(); });
    function positionLevelPanel() {
      const r = levelBtn.getBoundingClientRect();
      levelPanel.style.left = Math.max(8, Math.min(r.left, innerWidth - 284)) + 'px';
      levelPanel.style.top = (r.bottom + 6) + 'px';
    }
    function toggleLevelPanel(force) {
      const open = force === undefined ? !levelPanel.classList.contains('open') : force;
      if (open) { renderLevels(); positionLevelPanel(); }
      levelPanel.classList.toggle('open', open);
    }
    levelBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLevelPanel(); });
    levelPanel.addEventListener('click', (e) => e.stopPropagation());
    addEventListener('click', () => toggleLevelPanel(false));   // click-away closes
    // The seam: the storey controls appear only when multi-level is available (Pro). The
    // toolbar button also reflects a stacked home (armed) so a multi-storey project reads at a glance.
    function syncLevelSeam() {
      const on = isAvailable('multi-level', app.mode);
      levelGroup.classList.toggle('on', on);
      levelBtn.classList.toggle('armed', project.levels.length > 1);
      if (!on) toggleLevelPanel(false);
    }

    // --- Roof editor (Pro seam: 'roof-editor') — flat / gable / hip + pitch -----------
    // The pitched-roof SHAPE math is pure (core/roofShape.js, unit-tested); this only
    // dispatches an undoable setRoofType command on the roof-bearing (top) storey and
    // rebuilds. Hidden in Simple, revealed in Pro — the single isAvailable gate.
    const roofGroup = $('roof-group'), roofBtn = $('roof-btn'), roofPanel = $('roof-panel');
    const roofPitchInp = $('roof-pitch'), roofPitchVal = $('roof-pitch-val');
    const roofTypeButtons = [...document.querySelectorAll('#roof-types button')];

    // The roof caps the TOP storey (multi-level moves it up as storeys stack).
    function roofBearingLevel() {
      for (let i = project.levels.length - 1; i >= 0; i--) if (project.levels[i].roof) return project.levels[i];
      return null;
    }

    function applyRoof(patch) {
      const lvl = roofBearingLevel();
      if (!lvl) return;
      const cmd = history.execute(setRoofType(lvl.id, patch));
      if (!validateProject(project).ok) { cmd.undo(project); history.undoStack.pop(); renderRoof(); return; } // never leave the model invalid
      refresh();
    }

    function renderRoof() {
      const roof = (roofBearingLevel() || {}).roof;
      const type = (roof && roof.type) || 'flat';
      const pitched = type === 'gable' || type === 'hip';
      const pitch = (roof && roof.pitch != null) ? roof.pitch : 30;
      roofTypeButtons.forEach((b) => b.classList.toggle('active', b.dataset.roof === type));
      if (roofPitchInp) { roofPitchInp.value = pitch; roofPitchInp.disabled = !pitched; }
      if (roofPitchVal) roofPitchVal.textContent = pitched ? `${pitch}°` : '—';
      roofBtn.classList.toggle('armed', pitched);
      roofBtn.disabled = !roof;
    }

    roofTypeButtons.forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); applyRoof({ type: b.dataset.roof }); }));
    if (roofPitchInp) {
      roofPitchInp.addEventListener('keydown', (e) => e.stopPropagation());
      roofPitchInp.addEventListener('input', () => { if (roofPitchVal) roofPitchVal.textContent = `${roofPitchInp.value}°`; });
      roofPitchInp.addEventListener('change', () => applyRoof({ pitch: parseFloat(roofPitchInp.value) }));
    }
    function positionRoofPanel() {
      const r = roofBtn.getBoundingClientRect();
      roofPanel.style.left = Math.max(8, Math.min(r.left, innerWidth - 240)) + 'px';
      roofPanel.style.top = (r.bottom + 6) + 'px';
    }
    function toggleRoofPanel(force) {
      const open = force === undefined ? !roofPanel.classList.contains('open') : force;
      if (open) { renderRoof(); positionRoofPanel(); }
      roofPanel.classList.toggle('open', open);
    }
    roofBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleRoofPanel(); });
    roofPanel.addEventListener('click', (e) => e.stopPropagation());
    addEventListener('click', () => toggleRoofPanel(false));   // click-away closes
    function syncRoofSeam() {
      const on = isAvailable('roof-editor', app.mode);
      roofGroup.classList.toggle('on', on);
      if (on) renderRoof();
      else toggleRoofPanel(false);
    }

    // --- Simple / Pro mode toggle (the single gate the whole UI reads from) ---
    const modeButtons = [...document.querySelectorAll('#modes button')];
    const syncModeButtons = () => modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === app.mode));
    modeButtons.forEach((b) => b.addEventListener('click', () => {
      app.setMode(b.dataset.mode); syncModeButtons(); syncSnapSeam(); syncLevelSeam(); syncRoofSeam(); syncMeasureSeam(); renderInspector(); updateStatus();
    }));

    // --- display units toggle (m ↔ ft-in) — storage stays metric; this is display only ---
    const unitButtons = [...document.querySelectorAll('#units button')];
    const syncUnitButtons = () => unitButtons.forEach((b) => b.classList.toggle('active', b.dataset.units === app.units));
    unitButtons.forEach((b) => b.addEventListener('click', () => {
      app.setUnits(b.dataset.units); syncUnitButtons(); renderInspector();
    }));

    // --- toolbar wiring ---
    const toolButtons = [...document.querySelectorAll('#tools button')];
    const syncToolButtons = () => toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === app.activeTool));
    const HINTS = {
      [TOOL.SELECT]: 'Click a wall to select · drag a corner to move it',
      [TOOL.DRAW_WALL]: 'Click each corner to draw walls · Esc or right-click ends the run',
      [TOOL.PLACE_DOOR]: 'Click a wall to drop a door',
      [TOOL.PLACE_WINDOW]: 'Click a wall to drop a window',
      [TOOL.MEASURE]: 'Click two points to measure the distance · snaps to corners',
    };
    toolButtons.forEach((b) => b.addEventListener('click', () => {
      controller.setTool(b.dataset.tool); syncToolButtons(); hint(HINTS[app.activeTool] || ''); updateStatus();
      plan.draw();   // clearing/refreshing the ruler is a redraw, not a rebuild
    }));

    // The Measure tool is the Pro-seam 'measure-tool' row: its button shows only in Pro,
    // and leaving Pro (or switching tools) drops any active ruler back to Select. Single gate.
    const measureBtn = $('tool-measure');
    function syncMeasureSeam() {
      const on = isAvailable('measure-tool', app.mode);
      if (measureBtn) measureBtn.classList.toggle('on', on);
      if (!on && app.activeTool === TOOL.MEASURE) {
        controller.setTool(TOOL.SELECT); syncToolButtons(); hint(''); plan.draw();
      }
    }

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
        const activeLevel = project.levels.find((l) => l.id === app.activeLevelId) || project.levels[0];
        walk.enable(project.levels.flatMap((l) => l.walls), activeLevel);
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
      app.setActiveLevel(project.levels[0].id);
      controller.levelId = app.activeLevelId;
      plan.setLevel(app.activeLevelId);
      app.selection = null;
      refresh();
      renderLevels();
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
      plan.draw(); renderInspector(); updateStatus();
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
    syncModeButtons();
    syncUnitButtons();
    syncSnapSeam();
    syncLevelSeam();
    syncRoofSeam();
    syncMeasureSeam();
    renderLevels();
    renderInspector();
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
      // inspector / Simple-Pro seam handles (deterministic driving from the headless harness)
      __inspect: () => describeSelection(project, app.selection, { mode: app.mode, units: app.units }),
      __commitField: (key, raw) => { commitField(key, raw); return $('ins-msg') ? $('ins-msg').textContent : ''; },
      __setMode: (m) => { app.setMode(m); syncModeButtons(); syncSnapSeam(); syncLevelSeam(); syncRoofSeam(); syncMeasureSeam(); renderInspector(); updateStatus(); },
      __setUnits: (u) => { app.setUnits(u); syncUnitButtons(); renderInspector(); },
      // snapping/constraint seam handles (deterministic driving from the headless harness)
      __snap: () => app.snap, __setSnap: (partial) => { app.setSnap(partial); syncSnapControls(); plan.draw(); return app.snap; },
      __snapSeamVisible: () => snapGroup.classList.contains('on'),
      __select: (sel) => { app.selection = sel; plan.draw(); renderInspector(); updateStatus(); },
      // multi-level (storey) seam handles — deterministic driving from the headless harness
      __levels: () => project.levels.map((l) => ({ id: l.id, name: l.name, elevation: l.elevation, height: l.height, walls: l.walls.length, hasRoof: !!l.roof })),
      __activeLevel: () => app.activeLevelId,
      __levelSeamVisible: () => levelGroup.classList.contains('on'),
      __addStorey: () => { addStorey(); return app.activeLevelId; },
      __removeStorey: (id) => { removeStorey(id); return app.activeLevelId; },
      __switchLevel: (id) => { switchLevel(id); return app.activeLevelId; },
      __setLevelHeight: (id, h) => { commitLevelHeight(id, String(h)); return project.levels.find((l) => l.id === id)?.height; },
      __renameLevel: (id, name) => { commitLevelName(id, name); return project.levels.find((l) => l.id === id)?.name; },
      // roof-editor (gable/hip) seam handles — deterministic driving from the headless harness
      __roof: () => { const r = (roofBearingLevel() || {}).roof; return r ? { levelId: roofBearingLevel().id, type: r.type, pitch: r.pitch } : null; },
      __setRoofType: (patch) => { applyRoof(patch); const r = (roofBearingLevel() || {}).roof; return r ? { type: r.type, pitch: r.pitch } : null; },
      __roofSeamVisible: () => roofGroup.classList.contains('on'),
      // measure-tool (Pro-seam ruler) handles — deterministic driving from the headless harness
      __setTool: (t) => { controller.setTool(t); syncToolButtons(); hint(HINTS[app.activeTool] || ''); plan.draw(); return app.activeTool; },
      __measureSeamVisible: () => !!(measureBtn && measureBtn.classList.contains('on')),
      __measureClick: (x, z) => { controller.pointerDown({ x, z }); plan.draw(); return window.__measure(); },
      __measure: () => { const s = controller.measureSegment(); return s ? { from: s.from, to: s.to, complete: s.complete, meters: Math.hypot(s.to.x - s.from.x, s.to.z - s.from.z) } : null; },
    });
    window.__selftest = () => { const j = serialize(project); const p = deserialize(j); return { valid: validateProject(p).ok, lossless: serialize(p) === j, counts: projectCounts(p) }; };
  } catch (e) {
    spike.error = String((e && e.stack) || e);
    setStatus(`<span class="err">✗</span> ${String((e && e.message) || e)}`);
    console.error('[phase2] fatal', e);
  }
})();
