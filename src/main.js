import { createViewer } from './viewer/viewer.js';
import { buildScene, sceneBounds } from './build/sceneBuilder.js';
import { sampleHome } from './templates/sampleHome.js';
import { serialize, deserialize, validateProject, projectCounts } from './core/model.js';
import { createAppState, availableTools, MODE } from './app/state.js';
import { formatLength } from './core/units.js';

const spike = { booted: false, built: false, sceneMeshes: 0, roundTripOk: false, counts: null, error: null };
window.__app = spike;
const statusEl = document.getElementById('status');
const setStatus = (html) => { if (statusEl) statusEl.innerHTML = html; };

(async () => {
  try {
    const app = createAppState({ mode: MODE.SIMPLE });
    const project = sampleHome();

    // --- validate + save/load round-trip self-test (proves the save format) ---
    const v = validateProject(project);
    if (!v.ok) throw new Error('invalid project: ' + v.errors.join('; '));
    const json = serialize(project);
    const reloaded = deserialize(json);
    spike.roundTripOk = validateProject(reloaded).ok && serialize(reloaded) === json;
    spike.counts = projectCounts(project);

    // --- build the scene from the model ---
    const viewer = createViewer(document.getElementById('app'));
    const home = await buildScene(project);
    viewer.scene.add(home);
    viewer.frame(sceneBounds(home), 1.4);
    viewer.start();
    spike.built = true;
    spike.sceneMeshes = home.children.length;
    window.__viewer = viewer; window.__home = home; // handles for the verification harness

    const c = spike.counts;
    setStatus(
      `<span class="ok">✓</span> model → scene (${spike.sceneMeshes} objects)<br>` +
      `<span class="ok">✓</span> ${c.walls} walls · ${c.openings} openings · ${c.rooms} rooms · ${c.furniture} object<br>` +
      `<span class="ok">✓</span> save/load round-trip ${spike.roundTripOk ? 'lossless' : 'FAILED'}<br>` +
      `<span class="muted">mode:</span> ${app.mode} · ${availableTools(app.mode).length} tools · wall ${formatLength(0.12, app.units)} · ceiling ${formatLength(project.levels[0].height, app.units)}`
    );
    spike.booted = true;

    // expose a manual round-trip checker for the harness
    window.__selftest = () => {
      const j1 = serialize(project);
      const p2 = deserialize(j1);
      return { valid: validateProject(p2).ok, lossless: serialize(p2) === j1, counts: projectCounts(p2) };
    };
  } catch (e) {
    spike.error = String(e && e.stack || e);
    setStatus(`<span class="err">✗</span> ${String(e && e.message || e)}`);
    console.error('[phase1] fatal', e);
  }
})();
