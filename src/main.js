import { createViewer } from './viewer/viewer.js';
import { createWalkController } from './viewer/walkCamera.js';
import { buildScene, sceneBounds, rebuildGeometry } from './build/sceneBuilder.js';
import { serialize, deserialize, validateProject, projectCounts, createLevel, createRoof, findLevel, roomAtPoint, polygonCentroid, createRoom } from './core/model.js';
import { detectNewRooms } from './core/roomDetect.js';
import { roofOverhangs } from './core/roofShape.js';
import { createAppState, availableTools, isAvailable, MODE, TOOL, VIEW, CAMERA } from './app/state.js';
import { cutawayHiddenWalls } from './viewer/cutaway.js';
import { formatLength, UNIT } from './core/units.js';
import { describeSelection, describeHomeSummary, buildDimensionEdit, buildRoomRename, buildElementLabel, buildSetMaterial } from './app/inspector.js';
import { History } from './edit/history.js';
import { ToolController } from './edit/tools.js';
import { createPlanView } from './edit/planView.js';
import { raycast, eventToNDC } from './edit/picking.js';
import { createPlanCanvas } from './app/planCanvas.js';
import { createUnderlay, calibrateUnderlay, withOpacity } from './core/underlay.js';
import { parseLength } from './core/units.js';
import { STARTERS } from './templates/starters.js';
import { loadTemplate, setView, addLevel, removeLevel, renameLevel, setLevelHeight, setLevelRoof, setRoofType, composite, addRoom } from './edit/commands.js';
import { createDirtyTracker } from './app/dirty.js';
import { planThumbnailSVG } from './app/thumbnail.js';
import { exportObj, exportProjectJson, exportBaseName } from './core/exportObj.js';
import { exportGltf, gltfBaseName } from './core/exportGltf.js';
import { runAdvisoryChecks, advisorySummary, ADVISORY_DISCLAIMER } from './core/advisoryChecks.js';
import { buildProjectBrief, formatBriefText, createOutsourceRequest, validateOutsourceRequest, outsourceRequestJson, SERVICE_LEVELS, OUTSOURCE_DISCLAIMER } from './core/outsourceRequest.js';

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

    const plan = createPlanCanvas(planCanvasEl, {
      project, controller, planView, state: app, levelId: app.activeLevelId,
      onSelect: () => renderInspector(),
      onRoomActivate: (world) => beginPlanRoomRename(world),
      onDetectAdd: (candidate) => addDetectedRoom(candidate),
    });

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

    // The inspector renders descriptor strings (titles, the editable room name) via innerHTML.
    // Room names are now user-typed, so escape any string that lands in HTML to keep a name like
    // `<img onerror=...>` inert — a real edit path can no longer inject markup into the panel.
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function renderInspector() {
      if (!insBox) return;
      // Nothing selected → show the whole-home floor-area summary instead of a dead empty
      // state (a read-only overview: total GFA + per-storey breakdown + room count, per units).
      const desc = describeSelection(project, app.selection, { mode: app.mode, units: app.units })
        || describeHomeSummary(project, { units: app.units });
      if (!desc) {
        insBox.className = '';
        insBox.innerHTML = '<div class="ins-empty">No selection — click a wall, opening or room</div>';
        return;
      }
      // A room in Pro carries a `rename` slot: an editable NAME input, distinct from the numeric
      // dimension fields (it commits a renameRoom command, not a parsed length). Rendered as the
      // first row so the name reads as the heading of the readout beneath it.
      const nameRow = desc.rename
        ? `<label class="ins-row"><span>${desc.rename.label}</span>`
          + `<input class="ins-field ins-name" data-rename="1" value="${esc(desc.rename.value)}" `
          + (desc.rename.placeholder ? `placeholder="${esc(desc.rename.placeholder)}" ` : '')
          + `maxlength="40" spellcheck="false" autocomplete="off"></label>`
        : '';
      const rows = desc.fields.map((f) => desc.editable
        ? `<label class="ins-row"><span>${f.label}</span>`
          + `<input class="ins-field" data-key="${f.key}" value="${f.text}" spellcheck="false" autocomplete="off"></label>`
        : `<div class="ins-row"><span>${f.label}</span><b>${f.text}</b></div>`).join('');
      // E1 materials swatch: a Simple-tier row of clickable finish swatches for a wall/floor. The
      // current finish is marked selected; clicking one commits setElementMaterial (undoable).
      const matRow = desc.materials
        ? `<div class="ins-row ins-mat"><span>${desc.materials.label}</span>`
          + `<div class="ins-swatches">`
          + desc.materials.options.map((o) =>
              `<button type="button" class="ins-swatch${o.id === desc.materials.current ? ' sel' : ''}" `
              + `data-material="${esc(o.id)}" style="--sw:${esc(o.color)}" `
              + `title="${esc(o.label)}" aria-label="${esc(o.label)}"></button>`).join('')
          + `</div></div>`
        : '';
      const foot = desc.editable
        ? `<div class="ins-hint">Type an exact size (e.g. 3.2m or 10'6") and press Enter</div>`
        : `<div class="ins-hint">${desc.hint || 'Switch to <b>Pro</b> to edit exact dimensions'}</div>`;
      insBox.className = desc.editable ? 'editable' : '';
      insBox.innerHTML = `<div class="ins-title">${esc(desc.title)}</div>${nameRow}${rows}${matRow}${foot}<div class="ins-msg" id="ins-msg"></div>`;
      if (desc.editable) {
        insBox.querySelectorAll('.ins-field:not(.ins-name)').forEach((inp) => {
          inp.addEventListener('keydown', (e) => {
            e.stopPropagation();   // keep Del/Ctrl-Z etc. from firing while typing a size
            if (e.key === 'Enter') { e.preventDefault(); commitField(inp.dataset.key, inp.value); }
          });
          inp.addEventListener('blur', () => commitField(inp.dataset.key, inp.value));
        });
      }
      if (desc.rename) {
        const nameInp = insBox.querySelector('.ins-name');
        if (nameInp) {
          nameInp.addEventListener('keydown', (e) => {
            e.stopPropagation();   // keep Del/Ctrl-Z etc. from firing while typing the name
            if (e.key === 'Enter') { e.preventDefault(); nameInp.blur(); }
          });
          // The rename slot serves both the room-name edit and (A3) the wall/opening label edit;
          // dispatch on the current selection so each commits through its own builder.
          nameInp.addEventListener('blur', () => commitRename(nameInp.value));
        }
      }
      if (desc.materials) {
        insBox.querySelectorAll('.ins-swatch').forEach((btn) => {
          btn.addEventListener('click', (e) => { e.preventDefault(); commitMaterial(btn.dataset.material); });
        });
      }
    }

    // Commit a material-finish change through history (E1 materials-swatch seam). A no-op (the
    // finish already applied) pushes nothing; setElementMaterial only repoints the element's
    // existing `material` key (and registers a library finish on first use), so no re-validate/
    // rollback dance is needed. refresh() rebuilds geometry, so the new colour shows immediately.
    function commitMaterial(materialId) {
      const res = buildSetMaterial(project, app.selection, materialId);
      if (res.unchanged) return;
      const msg = $('ins-msg');
      if (res.error) { if (msg) msg.textContent = res.error; return; }
      history.execute(res.command);
      refresh();                     // re-derive materials registry + re-render the swatch state
    }

    // Dispatch a rename-slot commit to the right builder for the current selection: a room
    // commits a name (non-empty, via commitRoomName), a wall/opening commits an optional label.
    function commitRename(raw) {
      if (app.selection && app.selection.kind === 'room') commitRoomName(raw);
      else commitElementLabel(raw);
    }

    // Commit a wall/opening label edit through history (A3 Pro-seam). Like commitRoomName it is a
    // pure metadata edit — it only writes/removes the element's optional `label`, never geometry —
    // so no re-validate/rollback dance is needed. An unchanged value pushes nothing to undo.
    function commitElementLabel(raw) {
      if (committingField) return;   // re-render on commit blurs the input; don't loop
      committingField = true;
      try {
        const res = buildElementLabel(project, app.selection, raw);
        if (res.unchanged) return;
        const msg = $('ins-msg');
        if (res.error) { if (msg) msg.textContent = res.error; return; }
        history.execute(res.command);
        refresh();                   // re-render inspector title (now reflects the label)
      } finally { committingField = false; }
    }

    // Commit a room-name edit through history (Pro-seam). A no-op (name unchanged) pushes nothing
    // to the undo stack; a rename only rewrites the room's existing `name` field, so unlike a
    // dimension edit it can never invalidate geometry — no re-validate/rollback dance is needed.
    function commitRoomName(raw) {
      if (committingField) return;   // re-render on commit blurs the input; don't loop
      committingField = true;
      try {
        const res = buildRoomRename(project, app.selection, raw);
        if (res.unchanged) return;
        const msg = $('ins-msg');
        if (res.error) { if (msg) msg.textContent = res.error; return; }
        history.execute(res.command);
        refresh();                   // rebuild plan (room labels) + re-render inspector title
      } finally { committingField = false; }
    }

    // --- A1: rename a room by double-clicking it on the plan (Pro-seam room-rename) ----------
    // A plan-side entry to the SAME renameRoom command the inspector uses (via commitRoomName +
    // buildRoomRename), so it inherits the identical trim/validate/lossless/undo guarantees. The
    // hit-test (roomAtPoint) and label placement (polygonCentroid) are the already-tested pure
    // core functions; this wiring just opens a floating <input> over the room's centroid and
    // feeds its value back through the shared command path. It stores no geometry and, being a
    // rename, never touches the save schema.
    const planPanel = $('plan-panel');
    let roomEditor = null;           // the active floating <input>, or null when idle

    function closeRoomLabelEditor() {
      if (roomEditor) { roomEditor.remove(); roomEditor = null; }
    }

    // Open the inline name editor centered on a room's plan centroid, pre-filled with its name.
    // Enter/blur commits through commitRoomName (shared with the inspector); Escape cancels with
    // no history push. The editor is a plain DOM input laid over #plan-panel (position:relative),
    // so it self-positions from the same worldToScreen mapping the plan renderer uses.
    function openRoomLabelEditor(room) {
      closeRoomLabelEditor();
      if (!planPanel) return null;
      const c = planView.worldToScreen(polygonCentroid(room.points));
      const input = document.createElement('input');
      input.className = 'plan-name-editor';
      input.value = room.name || '';
      input.setAttribute('maxlength', '60');
      input.style.left = `${c.px}px`;
      input.style.top = `${c.py}px`;
      planPanel.appendChild(input);
      roomEditor = input;
      input.focus();
      input.select();
      let done = false;                                  // guard: commit-then-blur must fire once
      const commit = () => { if (done) return; done = true; const v = input.value; closeRoomLabelEditor(); commitRoomName(v); };
      const cancel = () => { if (done) return; done = true; closeRoomLabelEditor(); };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();          // keep Del/Ctrl-Z/tool hotkeys from firing while typing a name
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
      input.addEventListener('blur', commit);
      return input;
    }

    // Resolve the room under a plan double-click and, in Pro, open its inline name editor. Only
    // acts under the SELECT tool so a double-click that ends a wall chain never also renames. In
    // Simple the room is still selected (surfacing its read-only readout) but not editable — the
    // room-rename seam gates the edit exactly as the inspector does. Returns the room, or null.
    function beginPlanRoomRename(world) {
      closeRoomLabelEditor();
      if (app.activeTool !== TOOL.SELECT) return null;
      const lvl = findLevel(project, app.activeLevelId);
      const room = lvl ? roomAtPoint(lvl, world) : null;
      if (!room) return null;
      app.selection = { kind: 'room', id: room.id };
      renderInspector();
      updateStatus();
      if (!isAvailable('room-rename', app.mode)) { hint('Switch to Pro to rename a room'); return room; }
      openRoomLabelEditor(room);
      return room;
    }

    // --- A4: find + add auto-detected rooms on the plan (un-tiered read + add) ------------------
    // The pure detector (core/roomDetect.detectNewRooms) turns closed wall loops into candidate
    // polygons that aren't already covered by a saved room. This wiring surfaces them on the plan
    // as click-to-add outlines; a click commits an undoable addRoom command (createRoom builds a
    // plain model room from the polygon — no new save field). Detection stores nothing, and the
    // candidate outlines are pure view state that never reach the save.
    const currentLevel = () => findLevel(project, app.activeLevelId) || project.levels[0];

    // Toggle the detected-room overlay: off → run detection and offer the candidates; on → clear.
    function runDetect() {
      if (plan.getCandidates().length) { plan.clearCandidates(); hint('Detected-room overlay cleared.'); return 0; }
      const lvl = currentLevel();
      const found = lvl ? detectNewRooms(lvl) : [];
      plan.setCandidates(found);
      if (!found.length) hint('No new rooms found — draw walls that fully enclose a space, then find rooms again.');
      else hint(`${found.length} room${found.length === 1 ? '' : 's'} found — click a highlighted area to add it.`);
      return found.length;
    }

    // Commit one detected candidate as a real "Room" (undoable). Rolls the insert back if it would
    // somehow invalidate the model, then re-detects so the just-added room drops out of the offer.
    function addDetectedRoom(candidate) {
      if (!candidate || !Array.isArray(candidate.points) || candidate.points.length < 3) return null;
      const lvl = currentLevel();
      if (!lvl) return null;
      const room = createRoom(candidate.points, { name: 'Room' });
      const cmd = history.execute(addRoom(lvl.id, room));
      if (!validateProject(project).ok) { cmd.undo(project); history.undoStack.pop(); refresh(); return null; }
      app.selection = { kind: 'room', id: room.id };
      refresh();                                  // rebuild 3D floor + redraw plan + inspector (clears candidates)
      const remaining = detectNewRooms(lvl);      // the added room is now "covered" — offer only the rest
      plan.setCandidates(remaining);
      hint(remaining.length
        ? `Room added — ${remaining.length} more found. ${isAvailable('room-rename', app.mode) ? 'Double-click to rename.' : 'Switch to Pro to rename.'}`
        : `Room added. ${isAvailable('room-rename', app.mode) ? 'Double-click the label to rename.' : 'Switch to Pro to rename it.'}`);
      return room;
    }
    const detectBtn = $('detect-btn');
    if (detectBtn) detectBtn.addEventListener('click', () => runDetect());

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
    const roofRidgeRow = $('roof-ridge-row');
    const roofRidgeButtons = [...document.querySelectorAll('#roof-ridges button')];
    // B2 per-slope overhangs — sliders read/write in centimetres; the model stores metres.
    const roofEaveRow = $('roof-eave-row'), roofEaveInp = $('roof-eave'), roofEaveVal = $('roof-eave-val');
    const roofRakeRow = $('roof-rake-row'), roofRakeInp = $('roof-rake'), roofRakeVal = $('roof-rake-val');
    const cm = (m) => Math.round(m * 100);            // metres → whole cm (for the sliders)

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
      const ridge = (roof && roof.ridge) || 'auto';
      roofTypeButtons.forEach((b) => b.classList.toggle('active', b.dataset.roof === type));
      if (roofPitchInp) { roofPitchInp.value = pitch; roofPitchInp.disabled = !pitched; }
      if (roofPitchVal) roofPitchVal.textContent = pitched ? `${pitch}°` : '—';
      // Ridge direction only means something for a pitched roof — show/enable it only then.
      if (roofRidgeRow) roofRidgeRow.classList.toggle('hidden', !pitched);
      roofRidgeButtons.forEach((b) => { b.classList.toggle('active', b.dataset.ridge === ridge); b.disabled = !pitched; });
      // Per-slope overhangs are a pitched-roof concept too (a flat slab keeps its uniform
      // overhang). Show the effective eave/rake — backfilled from the legacy `overhang`.
      const { eave, rake } = roofOverhangs(roof || {});
      if (roofEaveRow) roofEaveRow.classList.toggle('hidden', !pitched);
      if (roofRakeRow) roofRakeRow.classList.toggle('hidden', !pitched);
      if (roofEaveInp) { roofEaveInp.value = cm(eave); roofEaveInp.disabled = !pitched; }
      if (roofEaveVal) roofEaveVal.textContent = pitched ? `${cm(eave)}` : '—';
      if (roofRakeInp) { roofRakeInp.value = cm(rake); roofRakeInp.disabled = !pitched; }
      if (roofRakeVal) roofRakeVal.textContent = pitched ? `${cm(rake)}` : '—';
      roofBtn.classList.toggle('armed', pitched);
      roofBtn.disabled = !roof;
    }

    roofTypeButtons.forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); applyRoof({ type: b.dataset.roof }); }));
    roofRidgeButtons.forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); applyRoof({ ridge: b.dataset.ridge }); }));
    if (roofPitchInp) {
      roofPitchInp.addEventListener('keydown', (e) => e.stopPropagation());
      roofPitchInp.addEventListener('input', () => { if (roofPitchVal) roofPitchVal.textContent = `${roofPitchInp.value}°`; });
      roofPitchInp.addEventListener('change', () => applyRoof({ pitch: parseFloat(roofPitchInp.value) }));
    }
    if (roofEaveInp) {
      roofEaveInp.addEventListener('keydown', (e) => e.stopPropagation());
      roofEaveInp.addEventListener('input', () => { if (roofEaveVal) roofEaveVal.textContent = roofEaveInp.value; });
      roofEaveInp.addEventListener('change', () => applyRoof({ eaveOverhang: parseInt(roofEaveInp.value, 10) / 100 }));
    }
    if (roofRakeInp) {
      roofRakeInp.addEventListener('keydown', (e) => e.stopPropagation());
      roofRakeInp.addEventListener('input', () => { if (roofRakeVal) roofRakeVal.textContent = roofRakeInp.value; });
      roofRakeInp.addEventListener('change', () => applyRoof({ rakeOverhang: parseInt(roofRakeInp.value, 10) / 100 }));
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

    // --- Export (Pro seam: 'ifc-export') — pure model → interchange, downloaded client-side.
    // OBJ (building massing + companion MTL) for other 3D tools, and the project's own lossless
    // JSON save. All the geometry math is pure core/exportObj.js; this just wires the download.
    const exportGroup = $('export-group'), exportBtn = $('export-btn'), exportPanel = $('export-panel');
    // Trigger a client-side download of some text as a file (Blob + object URL + transient anchor).
    function downloadText(filename, text, mime = 'text/plain') {
      const blob = new Blob([text], { type: `${mime};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    function doExportObj() {
      const base = exportBaseName(project);
      const { obj, mtl } = exportObj(project, { mtlName: `${base}.mtl` });
      downloadText(`${base}.obj`, obj, 'model/obj');
      downloadText(`${base}.mtl`, mtl, 'text/plain');
      toggleExportPanel(false);
    }
    function doExportJson() {
      downloadText(`${exportBaseName(project)}.json`, exportProjectJson(project), 'application/json');
      toggleExportPanel(false);
    }
    // E3+: glTF 2.0 — the third named interchange format. Same building massing as the OBJ path
    // (shared helpers in core/exportGltf.js), but a single self-contained .gltf that carries PBR
    // materials natively (opens in Blender, model-viewer, Windows 3D Viewer, Babylon, Godot…).
    function doExportGltf() {
      const { gltf } = exportGltf(project);
      downloadText(`${gltfBaseName(project)}.gltf`, gltf, 'model/gltf+json');
      toggleExportPanel(false);
    }
    function positionExportPanel() {
      const r = exportBtn.getBoundingClientRect();
      exportPanel.style.left = Math.max(8, Math.min(r.left, innerWidth - 266)) + 'px';
      exportPanel.style.top = (r.bottom + 6) + 'px';
    }
    function toggleExportPanel(force) {
      const open = force === undefined ? !exportPanel.classList.contains('open') : force;
      if (open) positionExportPanel();
      exportPanel.classList.toggle('open', open);
    }
    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleExportPanel(); });
    exportPanel.addEventListener('click', (e) => e.stopPropagation());
    addEventListener('click', () => toggleExportPanel(false));   // click-away closes
    $('export-obj').addEventListener('click', (e) => { e.stopPropagation(); doExportObj(); });
    $('export-gltf').addEventListener('click', (e) => { e.stopPropagation(); doExportGltf(); });
    $('export-json').addEventListener('click', (e) => { e.stopPropagation(); doExportJson(); });
    function syncExportSeam() {
      const on = isAvailable('ifc-export', app.mode);
      exportGroup.classList.toggle('on', on);
      if (!on) toggleExportPanel(false);
    }

    // --- D2: outsource intake (un-tiered seam: 'outsource') ------------------------------------
    // The "Outsource" onboarding tile opens a LOCAL, no-backend modal: it derives a shareable
    // brief from the live design (pure core/outsourceRequest.js) and lets the user copy/download
    // it to hand a drafting service of their choice. Nothing is uploaded; no API key (constraint
    // #7). Every action is derived-on-read — it reads the model and never touches the save.
    const osEl = $('outsource'), osServiceSel = $('os-service'), osBriefBox = $('os-brief');
    const osName = $('os-name'), osEmail = $('os-email'), osNotes = $('os-notes'), osNote = $('os-note');
    // Populate the service dropdown once from the pure catalog.
    for (const s of SERVICE_LEVELS) {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = `${s.label} — ${s.desc}`;
      osServiceSel.appendChild(opt);
    }
    $('os-disc').textContent = OUTSOURCE_DISCLAIMER;
    function osSetNote(msg, cls) { osNote.textContent = msg || ''; osNote.className = cls || ''; }
    function osBriefText() { return formatBriefText(buildProjectBrief(project, { units: app.units })); }
    function refreshOutsourceBrief() { osBriefBox.value = osBriefText(); }
    function osCurrentRequest() {
      return createOutsourceRequest(project,
        { name: osName.value, email: osEmail.value, notes: osNotes.value },
        { service: osServiceSel.value, units: app.units, createdAt: new Date().toISOString() });
    }
    function openOutsource() { refreshOutsourceBrief(); osSetNote(''); osEl.classList.add('open'); }
    function closeOutsource() { osEl.classList.remove('open'); }
    osServiceSel.addEventListener('change', () => osSetNote(''));
    $('os-copy').addEventListener('click', async () => {
      const text = osBriefText();
      try { await navigator.clipboard.writeText(text); osSetNote('Brief copied to clipboard.', 'ok'); }
      catch { osBriefBox.focus(); osBriefBox.select(); osSetNote('Press Ctrl/Cmd+C to copy the selected brief.', ''); }
    });
    $('os-dl-brief').addEventListener('click', () => {
      downloadText(`${exportBaseName(project)}-brief.txt`, osBriefText(), 'text/plain');
      osSetNote('Brief downloaded.', 'ok');
    });
    $('os-dl-req').addEventListener('click', () => {
      const req = osCurrentRequest();
      const v = validateOutsourceRequest(req);
      if (!v.ok) { osSetNote(v.errors[0], 'err'); return; }
      downloadText(`${exportBaseName(project)}-outsource-request.json`, outsourceRequestJson(req), 'application/json');
      osSetNote('Request downloaded — attach it to an email to your drafter.', 'ok');
    });
    $('outsource-close').addEventListener('click', closeOutsource);
    osEl.addEventListener('click', (e) => { if (e.target === osEl) closeOutsource(); });

    // --- E2: advisory checks (Pro seam: 'code-checks') ----------------------------------------
    // A read-only "Checks" panel that runs the pure advisory engine (core/advisoryChecks.js) over
    // the live project and lists the approximate residential rules-of-thumb it doesn't meet. EVERY
    // finding is ADVISORY only — never code-compliant or engineer-certified (constraint #6) — so the
    // panel always shows ADVISORY_DISCLAIMER. Clicking a finding selects the element it names
    // (switching storey if needed) so the user can go and adjust it. No command, no model mutation.
    const checksGroup = $('checks-group'), checksBtn = $('checks-btn'), checksPanel = $('checks-panel');
    const checksBody = $('checks-body');
    let checksFindings = [];

    // Resolve a finding's `ref` to a selection + visible storey. Returns the selection (or null for a
    // whole-storey finding). Pure view state — never a command, never a save touch.
    function selectFromCheck(ref) {
      if (!ref) return null;
      if (ref.levelId && ref.levelId !== app.activeLevelId) switchLevel(ref.levelId);
      if (ref.kind === 'room') {
        app.selection = { kind: 'room', id: ref.id };
      } else if (ref.kind === 'opening') {
        const lvl = findLevel(project, ref.levelId) || currentLevel();
        const op = lvl && (lvl.openings || []).find((o) => o.id === ref.id);
        app.selection = op ? { kind: op.kind, id: op.id } : null;
      } else {
        app.selection = null;   // a whole-storey finding — surfacing the storey is enough
      }
      plan.draw(); renderInspector(); updateStatus();
      return app.selection;
    }

    function renderChecksPanel() {
      const result = runAdvisoryChecks(project);
      checksFindings = result.findings;
      const n = result.counts.advisory;
      let html = '<div class="cp-title">Advisory checks</div>';
      html += `<div class="cp-summary">${n === 0 ? 'Nothing flagged — no advisories.' : `${esc(advisorySummary(result))} found.`}</div>`;
      if (n > 0) {
        html += '<div class="cp-list">';
        result.findings.forEach((f, i) => {
          const where = (f.ref && f.ref.where) || '';
          html += `<button class="cp-item" data-idx="${i}">`
            + (where ? `<span class="cp-where">${esc(where)}</span>` : '')
            + `<span class="cp-msg">${esc(f.message)}</span></button>`;
        });
        html += '</div>';
      }
      html += `<div class="cp-disc">${esc(result.disclaimer)}</div>`;
      checksBody.innerHTML = html;
    }
    function positionChecksPanel() {
      const r = checksBtn.getBoundingClientRect();
      checksPanel.style.left = Math.max(8, Math.min(r.left, innerWidth - 316)) + 'px';
      checksPanel.style.top = (r.bottom + 6) + 'px';
    }
    function toggleChecksPanel(force) {
      const open = force === undefined ? !checksPanel.classList.contains('open') : force;
      if (open) { renderChecksPanel(); positionChecksPanel(); }
      checksPanel.classList.toggle('open', open);
    }
    checksBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleChecksPanel(); });
    checksPanel.addEventListener('click', (e) => e.stopPropagation());
    addEventListener('click', () => toggleChecksPanel(false));   // click-away closes
    // One delegated handler for the (re-rendered) finding buttons: select the element it names.
    checksBody.addEventListener('click', (e) => {
      const item = e.target.closest('.cp-item');
      if (!item) return;
      const f = checksFindings[Number(item.dataset.idx)];
      if (f) { selectFromCheck(f.ref); hint(`Selected — ${(f.ref && f.ref.where) || 'see the flagged element'}.`); }
    });
    function syncChecksSeam() {
      const on = isAvailable('code-checks', app.mode);
      checksGroup.classList.toggle('on', on);
      if (!on) toggleChecksPanel(false);
    }

    // --- D1: import a plan (trace an uploaded floor plan) --------------------------------------
    // A raster floor plan is loaded as a plan-canvas UNDERLAY to draw walls over. It is pure
    // DISPLAY state (never saved with the geometry) — main.js holds the current descriptor + the
    // loaded image + the object URL to revoke; the plan surface draws it and captures calibration
    // clicks. Import is un-tiered ('plan-import'); calibration is Pro ('plan-calibrate').
    const underlayGroup = $('underlay-group'), underlayBtn = $('underlay-btn'), underlayPanel = $('underlay-panel');
    const underlayFile = $('plan-file');
    const underlayOpacity = $('underlay-opacity'), underlayOpacityVal = $('underlay-opacity-val');
    const underlayCalibrateBtn = $('underlay-calibrate'), underlayRemoveBtn = $('underlay-remove');
    let underlayDesc = null;      // the current underlay descriptor (core/underlay.js) or null
    let underlayImg = null;       // the loaded HTMLImageElement or null
    let underlayUrl = null;       // the object URL backing underlayImg (revoked on replace/remove)

    // Turn a loaded image into an underlay centred on the current plan viewport (so it lands where
    // the user is looking), default ~10 m wide until they calibrate. Replaces any prior underlay.
    function importUnderlayFromImage(img) {
      underlayImg = img;
      underlayDesc = createUnderlay({
        imgWidth: img.naturalWidth || img.width, imgHeight: img.naturalHeight || img.height,
        center: { x: planView.vp.center.x, z: planView.vp.center.z },
        opacity: underlayOpacity ? Number(underlayOpacity.value) / 100 : 0.5,
      });
      plan.setUnderlay(underlayDesc, underlayImg);
      syncUnderlaySeam();
      toggleUnderlayPanel(true);
      hint('Floor plan imported — trace walls over it. Use “Plan image…” to calibrate its scale.');
    }
    // Load an image from a URL (object URL in the app; a data: URL from the headless harness).
    function loadUnderlayUrl(url, revokePrev = true) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          if (revokePrev && underlayUrl) { try { URL.revokeObjectURL(underlayUrl); } catch { /* data URL */ } }
          underlayUrl = url;
          importUnderlayFromImage(img);
          resolve(underlayDesc);
        };
        img.onerror = () => reject(new Error('could not load image'));
        img.src = url;
      });
    }
    function openUnderlayPicker() { if (underlayFile) underlayFile.click(); }
    if (underlayFile) underlayFile.addEventListener('change', () => {
      const f = underlayFile.files && underlayFile.files[0];
      if (!f) return;
      loadUnderlayUrl(URL.createObjectURL(f)).catch(() => hint('Sorry — that image could not be loaded.'));
      underlayFile.value = '';   // allow re-importing the same file
    });

    function removeUnderlay() {
      plan.clearUnderlay();
      if (underlayUrl) { try { URL.revokeObjectURL(underlayUrl); } catch { /* data URL */ } }
      underlayDesc = null; underlayImg = null; underlayUrl = null;
      cancelCalibrate();
      syncUnderlaySeam();
      toggleUnderlayPanel(false);
    }

    // Apply a finished calibration: two world clicks over a feature of known real length -> rescale
    // the underlay (anchored at the first click so traced content stays put). Pure math; display only.
    function applyCalibration(a, b, knownMeters) {
      if (!underlayDesc || !(knownMeters > 0)) return null;
      underlayDesc = calibrateUnderlay(underlayDesc, a, b, knownMeters);
      plan.setUnderlay(underlayDesc, underlayImg);
      return underlayDesc;
    }
    function armCalibrate() {
      if (!plan.hasUnderlay() || !isAvailable('plan-calibrate', app.mode)) return false;
      const ok = plan.startCalibrate((a, b) => {
        underlayCalibrateBtn.classList.remove('armed');
        const raw = (typeof prompt === 'function')
          ? prompt('How long is that dimension in real life? (e.g. 3.6 m or 12\')') : null;
        const meters = raw != null ? parseLength(raw, app.units) : NaN;
        if (meters > 0) { applyCalibration(a, b, meters); hint('Scale calibrated to the imported plan.'); }
        else { plan.draw(); hint('Calibration cancelled.'); }
      });
      if (ok) { underlayCalibrateBtn.classList.add('armed'); toggleUnderlayPanel(false); hint('Click two points on a dimension you know (e.g. a doorway), then type its real length.'); }
      return ok;
    }
    function cancelCalibrate() {
      if (underlayCalibrateBtn) underlayCalibrateBtn.classList.remove('armed');
      return plan.cancelCalibrate();
    }

    if (underlayOpacity) {
      underlayOpacity.addEventListener('keydown', (e) => e.stopPropagation());
      underlayOpacity.addEventListener('input', () => {
        if (underlayOpacityVal) underlayOpacityVal.textContent = `${underlayOpacity.value}%`;
        if (underlayDesc) { underlayDesc = withOpacity(underlayDesc, Number(underlayOpacity.value) / 100); plan.setUnderlay(underlayDesc, underlayImg); }
      });
    }
    if (underlayCalibrateBtn) underlayCalibrateBtn.addEventListener('click', (e) => { e.stopPropagation(); armCalibrate(); });
    if (underlayRemoveBtn) underlayRemoveBtn.addEventListener('click', (e) => { e.stopPropagation(); removeUnderlay(); });

    function positionUnderlayPanel() {
      const r = underlayBtn.getBoundingClientRect();
      underlayPanel.style.left = Math.max(8, Math.min(r.left, innerWidth - 256)) + 'px';
      underlayPanel.style.top = (r.bottom + 6) + 'px';
    }
    function toggleUnderlayPanel(force) {
      const open = force === undefined ? !underlayPanel.classList.contains('open') : force;
      if (open) { renderUnderlayPanel(); positionUnderlayPanel(); }
      underlayPanel.classList.toggle('open', open);
    }
    underlayBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleUnderlayPanel(); });
    underlayPanel.addEventListener('click', (e) => e.stopPropagation());
    addEventListener('click', () => toggleUnderlayPanel(false));   // click-away closes

    function renderUnderlayPanel() {
      if (underlayDesc && underlayOpacity) {
        underlayOpacity.value = String(Math.round(underlayDesc.opacity * 100));
        if (underlayOpacityVal) underlayOpacityVal.textContent = `${underlayOpacity.value}%`;
      }
      // calibration is the Pro part of D1 — hide the button in Simple (the seam).
      if (underlayCalibrateBtn) underlayCalibrateBtn.classList.toggle('hidden', !isAvailable('plan-calibrate', app.mode));
    }
    // The "Plan image…" group only appears once a plan is imported (nothing to adjust before then).
    function syncUnderlaySeam() {
      const on = plan.hasUnderlay();
      underlayGroup.classList.toggle('on', on);
      if (on) renderUnderlayPanel();
      else toggleUnderlayPanel(false);
    }

    // --- Simple / Pro mode toggle (the single gate the whole UI reads from) ---
    const modeButtons = [...document.querySelectorAll('#modes button')];
    const syncModeButtons = () => modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === app.mode));
    modeButtons.forEach((b) => b.addEventListener('click', () => {
      app.setMode(b.dataset.mode); syncModeButtons(); syncSnapSeam(); syncLevelSeam(); syncRoofSeam(); syncMeasureSeam(); syncExportSeam(); syncChecksSeam(); syncUnderlaySeam(); renderInspector(); updateStatus();
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
    // Onboarding tiles — RoomSketcher's blank / template / import / outsource pattern.
    // D1: "Import a plan" is LIVE (loads a floor-plan underlay to trace over). D2: "Outsource"
    // is now LIVE too — a local, no-backend intake that turns the current design into a brief
    // to hand a drafting service. Both tiles are wired; nothing is "coming soon" here anymore.
    {
      const imp = document.createElement('button');
      imp.className = 'tpl-card'; imp.id = 'tpl-import'; imp.title = 'Import a floor plan image and trace over it';
      imp.innerHTML = `<div class="thumb">${planThumbnailSVG({ levels: [] })}</div>`
        + `<div class="name">Import a plan</div><div class="desc">Trace an uploaded floor plan.</div>`;
      imp.addEventListener('click', () => { closePicker(); openUnderlayPicker(); });
      grid.appendChild(imp);
    }
    {
      const out = document.createElement('button');
      out.className = 'tpl-card'; out.id = 'tpl-outsource'; out.title = 'Generate a brief to hand your design to a drafting service';
      out.innerHTML = `<div class="thumb">${planThumbnailSVG({ levels: [] })}</div>`
        + `<div class="name">Outsource</div><div class="desc">Have your home drawn for you.</div>`;
      out.addEventListener('click', () => { closePicker(); openOutsource(); });
      grid.appendChild(out);
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
      if (osEl.classList.contains('open')) { if (e.key === 'Escape') closeOutsource(); return; }
      if (pickerEl.classList.contains('open')) { if (e.key === 'Escape') closePicker(); return; }
      if (e.key === 'Escape') { if (plan.isCalibrating()) { cancelCalibrate(); hint('Calibration cancelled.'); } else if (app.camera === CAMERA.WALK) setCamera(CAMERA.ORBIT); else { controller.finishChain(); plan.draw(); } }
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
    syncExportSeam();
    syncChecksSeam();
    syncUnderlaySeam();
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
      __summary: () => describeHomeSummary(project, { units: app.units }),
      __inspectorText: () => (insBox ? insBox.textContent : ''),
      __commitField: (key, raw) => { commitField(key, raw); return $('ins-msg') ? $('ins-msg').textContent : ''; },
      __renameRoom: (raw) => {
        commitRoomName(raw);
        const loc = describeSelection(project, app.selection, { mode: app.mode, units: app.units });
        return { title: loc ? loc.title : null, msg: $('ins-msg') ? $('ins-msg').textContent : '' };
      },
      // A3: label the selected wall/opening (Pro element-label). Commits through the same builder
      // the inspector uses, then reports the resulting title (label or type name) + the element's
      // stored label so the harness can prove the model updated and stays view/save-correct.
      __labelElement: (raw) => {
        commitElementLabel(raw);
        const loc = describeSelection(project, app.selection, { mode: app.mode, units: app.units });
        return { title: loc ? loc.title : null, rename: loc ? loc.rename : null, msg: $('ins-msg') ? $('ins-msg').textContent : '' };
      },
      // E1: apply a material finish to the selected wall/floor. Commits through the same builder
      // the swatch UI uses, then reports the element's stored material + the descriptor slot so the
      // harness can prove the model updated (and that the finish was registered in project.materials).
      __setMaterial: (materialId) => {
        commitMaterial(materialId);
        const loc = describeSelection(project, app.selection, { mode: app.mode, units: app.units });
        const sel = app.selection;
        let stored = null;
        if (sel && sel.kind === 'wall') { for (const l of project.levels) { const w = l.walls.find((x) => x.id === sel.id); if (w) stored = w.material; } }
        else if (sel && sel.kind === 'room') { for (const l of project.levels) { const r = l.rooms.find((x) => x.id === sel.id); if (r) stored = r.material; } }
        return { stored, materials: loc ? loc.materials : null, registered: !!(project.materials && project.materials[materialId]), msg: $('ins-msg') ? $('ins-msg').textContent : '' };
      },
      __setMode: (m) => { app.setMode(m); syncModeButtons(); syncSnapSeam(); syncLevelSeam(); syncRoofSeam(); syncMeasureSeam(); syncExportSeam(); syncChecksSeam(); syncUnderlaySeam(); renderInspector(); updateStatus(); },
      __setUnits: (u) => { app.setUnits(u); syncUnitButtons(); renderInspector(); },
      // snapping/constraint seam handles (deterministic driving from the headless harness)
      __snap: () => app.snap, __setSnap: (partial) => { app.setSnap(partial); syncSnapControls(); plan.draw(); return app.snap; },
      __snapSeamVisible: () => snapGroup.classList.contains('on'),
      __select: (sel) => { app.selection = sel; plan.draw(); renderInspector(); updateStatus(); },
      // plan-click selection (S1 select tool): drive a plan pointer-down at world {x,z} the same
      // way the canvas handler does, then return the resulting selection (room hit-test included).
      __planClick: (x, z) => { controller.pointerDown({ x, z }); plan.draw(); renderInspector(); updateStatus(); return app.selection; },
      // A2: hover-highlight. Drive a plan pointer-move at world {x,z} (SELECT-tool only) and read
      // back the hovered room + proof it's view-only (undo depth + selection unchanged, no rebuild).
      __planHover: (x, z) => { plan.updateHover({ x, z }); plan.draw(); return { hover: plan.getHoveredId(), undo: history.undoStack.length, selection: app.selection }; },
      __planHoverClear: () => { plan.clearHover(); plan.draw(); return plan.getHoveredId(); },
      // A1: plan double-click room rename. __planDblClick resolves+selects the room and (in Pro)
      // opens the inline editor; __roomEditor reports its live state; __roomEditorCommit drives a
      // real Enter through the editor's own handler so the headless harness exercises the DOM path.
      __planDblClick: (x, z) => { const room = beginPlanRoomRename({ x, z }); return { room: room ? room.id : null, editing: !!roomEditor, value: roomEditor ? roomEditor.value : null, selection: app.selection }; },
      __roomEditor: () => (roomEditor ? { value: roomEditor.value } : null),
      __roomEditorCommit: (v) => { if (!roomEditor) return null; roomEditor.value = v; roomEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return { name: (project.levels.flatMap((l) => l.rooms || []).find((r) => app.selection && r.id === app.selection.id) || {}).name || null, editing: !!roomEditor }; },
      __roomEditorCancel: () => { if (!roomEditor) return false; roomEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return !roomEditor; },
      // A4: find/add auto-detected rooms. __findRooms toggles the overlay (returns the candidate
      // count + polygons); __addDetectedRoom(i) commits candidate i as a real room through the SAME
      // onDetectAdd path a plan click uses, then reports the new room count, the remaining offers,
      // and the undo depth so the harness can prove it's an undoable model edit, not view state.
      __findRooms: () => { const n = runDetect(); return { count: plan.getCandidates().length, candidates: plan.getCandidates(), seamVisible: !!(detectBtn && detectBtn.offsetParent !== null), toggled: n }; },
      __detectCandidates: () => plan.getCandidates(),
      __detectSeamVisible: () => !!(detectBtn && detectBtn.offsetParent !== null),
      __addDetectedRoom: (i) => {
        const cands = plan.getCandidates();
        const cand = cands[i];
        if (!cand) return null;
        const before = project.levels.flatMap((l) => l.rooms || []).length;
        const room = addDetectedRoom(cand);
        return { added: room ? room.id : null, rooms: project.levels.flatMap((l) => l.rooms || []).length, added_count: project.levels.flatMap((l) => l.rooms || []).length - before, remaining: plan.getCandidates().length, undo: history.undoStack.length, selection: app.selection };
      },
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
      __roof: () => { const r = (roofBearingLevel() || {}).roof; return r ? { levelId: roofBearingLevel().id, type: r.type, pitch: r.pitch, ridge: r.ridge, overhang: r.overhang, eaveOverhang: r.eaveOverhang, rakeOverhang: r.rakeOverhang } : null; },
      __setRoofType: (patch) => { applyRoof(patch); const r = (roofBearingLevel() || {}).roof; return r ? { type: r.type, pitch: r.pitch, ridge: r.ridge, overhang: r.overhang, eaveOverhang: r.eaveOverhang, rakeOverhang: r.rakeOverhang } : null; },
      __roofSeamVisible: () => roofGroup.classList.contains('on'),
      // export (Pro-seam 'ifc-export') handles — run the pure exporter over the live project and
      // report the OBJ/MTL text + counts + warnings so the harness can verify without downloading.
      __exportSeamVisible: () => exportGroup.classList.contains('on'),
      __exportObj: () => exportObj(project, { mtlName: `${exportBaseName(project)}.mtl` }),
      __exportJson: () => exportProjectJson(project),
      // E3+: glTF export (same Pro 'ifc-export' seam). Runs the pure exporter over the live project
      // and reports the doc + counts so the harness can verify without triggering a download.
      __exportGltf: () => exportGltf(project),
      // E2: advisory checks (Pro-seam 'code-checks'). __runChecks runs the pure engine over the live
      // project and returns the full result; __checksSeamVisible reports the group's Pro gate; the
      // panel-driven handles open it, read the rendered rows, and click a finding to prove select-to-fix.
      __checksSeamVisible: () => checksGroup.classList.contains('on'),
      __runChecks: () => runAdvisoryChecks(project),
      __openChecks: () => { toggleChecksPanel(true); return { open: checksPanel.classList.contains('open'), rows: checksBody.querySelectorAll('.cp-item').length, disclaimer: !!checksBody.querySelector('.cp-disc') }; },
      __checkSelect: (i) => {
        toggleChecksPanel(true);
        const items = checksBody.querySelectorAll('.cp-item');
        const el = items[i];
        if (!el) return null;
        el.click();
        return { selection: app.selection, activeLevel: app.activeLevelId, undo: history.undoStack.length };
      },
      // D2: outsource intake handles. __outsourceSeamVisible reports the tile is wired (un-tiered);
      // __openOutsource opens the modal and reports its rendered state; __outsourceBrief returns the
      // pure derived brief; __outsourceRequest builds + validates a request from given contact input.
      __outsourceSeamVisible: () => isAvailable('outsource', app.mode),
      __openOutsource: () => {
        const before = window.__project ? serialize(project) : null;
        openOutsource();
        return {
          open: osEl.classList.contains('open'),
          briefLen: osBriefBox.value.length,
          services: osServiceSel.querySelectorAll('option').length,
          disclaimer: $('os-disc').textContent,
          saveUntouched: before === serialize(project),
        };
      },
      __closeOutsource: () => { closeOutsource(); return !osEl.classList.contains('open'); },
      __outsourceBrief: () => buildProjectBrief(project, { units: app.units }),
      __outsourceRequest: (contact = {}, service = 'concept') => {
        const before = serialize(project);
        const req = createOutsourceRequest(project, contact, { service, units: app.units, createdAt: '2026-08-25' });
        return { req, valid: validateOutsourceRequest(req), saveUntouched: before === serialize(project), undo: history.undoStack.length };
      },
      // D1: import-a-plan underlay handles — deterministic driving from the headless harness.
      // A file dialog can't open headlessly, so __importUnderlay loads a data: URL directly (the
      // same code path the file-input change handler runs). Returns the descriptor + world rect.
      __importUnderlay: (dataUrl) => loadUnderlayUrl(dataUrl, false).then(() => window.__underlay()),
      __underlay: () => {
        if (!plan.hasUnderlay()) return null;
        const u = plan.getUnderlay();
        const rect = { widthM: u.imgWidth * u.metersPerPixel, heightM: u.imgHeight * u.metersPerPixel };
        return { imgWidth: u.imgWidth, imgHeight: u.imgHeight, metersPerPixel: u.metersPerPixel, center: u.center, opacity: u.opacity, widthM: rect.widthM, heightM: rect.heightM };
      },
      __underlayGroupVisible: () => underlayGroup.classList.contains('on'),
      __underlayCalibrateVisible: () => !!(underlayCalibrateBtn && !underlayCalibrateBtn.classList.contains('hidden')),
      __setUnderlayOpacity: (pct) => { if (!underlayOpacity) return null; underlayOpacity.value = String(pct); underlayOpacity.dispatchEvent(new Event('input')); return plan.getUnderlay() ? plan.getUnderlay().opacity : null; },
      __removeUnderlay: () => { removeUnderlay(); return { hasUnderlay: plan.hasUnderlay(), groupVisible: underlayGroup.classList.contains('on') }; },
      // Drive the real two-click calibration capture (bypassing the prompt): arm calibration with a
      // preset known length, then feed the two plan points the way the canvas handler does.
      __calibrateUnderlay: (ax, az, bx, bz, meters) => {
        if (!plan.hasUnderlay()) return null;
        plan.startCalibrate((a, b) => applyCalibration(a, b, meters));
        plan.calibratePoint({ x: ax, z: az });
        const captured = plan.calibratePoint({ x: bx, z: bz });
        const u = plan.getUnderlay();
        return { captured, metersPerPixel: u.metersPerPixel, center: u.center, undo: history.undoStack.length, selection: app.selection };
      },
      __calibrateWorldSpan: (px1, pv1, px2, pv2) => {
        // helper for the probe: world distance between two IMAGE pixels under the current underlay
        const u = plan.getUnderlay(); if (!u) return null;
        const toW = (px, pv) => ({ x: u.center.x + (px - u.imgWidth / 2) * u.metersPerPixel, z: u.center.z + (pv - u.imgHeight / 2) * u.metersPerPixel });
        const a = toW(px1, pv1), b = toW(px2, pv2);
        return Math.hypot(b.x - a.x, b.z - a.z);
      },
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
