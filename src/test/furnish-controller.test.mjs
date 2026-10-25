// Furnish controller — Phase-4 application-glue verification.
// Run: node src/test/furnish-controller.test.mjs
//
// Covers app/furnishController.js — the integration layer that turns a photo into a committed,
// UNDOABLE furniture record by sequencing the pure pipeline (runFurnishJob → toFurniture) and
// the edit layer (addFurniture → History). Every side effect is injected: a scripted fake
// transport, an instant sleep, a fake clock, and a fake GLB-load verifier — NEVER a live API
// call or a real GLB fetch. No Three.js import here — running under plain Node is itself the
// model/view separation guard (a stray `three` import in app/core/edit would fail to load this
// suite). Own file (pick-protocol §5) so it never collides with in-flight test work.
import {
  furnishFromImage, messageForError, FurnishPhase,
} from '../app/furnishController.js';
import { FurnishError, ERROR_CODES, JobStatus } from '../core/furnishPipeline.js';
import { createProject, createLevel, serialize, validateProject, _resetIds } from '../core/model.js';
import { History } from '../edit/history.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_1x1}`;
const GLB_URL = 'https://proxy.local/furnish/model.glb';

// Scripted fake transport (same shape as the pipeline suite): queued responses, in order.
// Throws if under-scripted so a mis-scripted test fails fast instead of spinning.
function fakeTransport(responses) {
  const q = responses.slice();
  const seen = [];
  const fn = async (req) => {
    seen.push(req);
    if (!q.length) throw new Error('fakeTransport: ran out of scripted responses');
    const r = q.shift();
    if (typeof r === 'function') return r(req);
    if (r.httpError) return { ok: false, status: r.status || 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r.json };
  };
  fn.seen = seen;
  return fn;
}
const okRes = (json) => ({ json });
const instantSleep = () => Promise.resolve();
const submitOK = () => okRes({ jobId: 'job-123' });
const statusSucceeded = (extra = {}) => okRes({ status: 'SUCCEEDED', glbUrl: GLB_URL, ...extra });

function freshProjectHistory() {
  const level = createLevel({ name: 'Ground' });
  const project = createProject({ name: 'Furnish test', levels: [level] });
  return { project, history: new History(project), levelId: level.id };
}

async function expectReject(promise, code, msg) {
  try { await promise; ok(false, `${msg} (expected throw ${code}, got resolve)`); }
  catch (e) { ok(e instanceof FurnishError && e.code === code, `${msg} (got ${e && e.code} / ${e && e.message})`); return e; }
  return null;
}

async function main() {
  _resetIds();

  // ---- 1) happy path, no verifier: a photo becomes a committed, undoable record ------------
  {
    const { project, history, levelId } = freshProjectHistory();
    const phases = [];
    const transport = fakeTransport([submitOK(), statusSucceeded({ name: 'Sofa' })]);
    const out = await furnishFromImage(PNG_URL, {
      history, transport, levelId, position: { x: 2, z: 3 },
      sleep: instantSleep, onPhase: (p) => phases.push(p),
    });
    ok(out && out.furniture && out.furniture.id, '1a resolves with a furniture record');
    ok(out.furniture.src === GLB_URL, '1b the record carries the job GLB url as src');
    ok(out.furniture.name === 'Sofa', '1c name comes from the job result');
    ok(out.furniture.levelId === levelId, '1d levelId forwarded to the record');
    ok(out.furniture.position.x === 2 && out.furniture.position.z === 3, '1e position forwarded');
    ok(out.jobId === 'job-123', '1f jobId surfaced');
    ok(project.furniture.length === 1 && project.furniture[0].id === out.furniture.id, '1g committed into project.furniture');
    ok(history.canUndo() && history.labels().at(-1) === 'Add furniture', '1h committed through the History (undoable)');
    ok(validateProject(project).errors.length === 0, '1i the committed project still validates');
    ok(phases[0] === FurnishPhase.RUNNING && phases.at(-1) === FurnishPhase.COMMITTED, '1j phases run RUNNING → COMMITTED');
    ok(!phases.includes(FurnishPhase.VERIFYING), '1k no VERIFYING phase without a loadGlb verifier');
    // undo removes exactly the committed record (lossless)
    history.undo();
    ok(project.furniture.length === 0, '1l undo removes the furniture record');
  }

  // ---- 2) Phase-1 lossless round-trip survives commit→undo ---------------------------------
  {
    const { project, history, levelId } = freshProjectHistory();
    const before = serialize(project);
    const transport = fakeTransport([submitOK(), statusSucceeded()]);
    await furnishFromImage(PNG_URL, { history, transport, levelId, sleep: instantSleep });
    ok(serialize(project) !== before, '2a commit changes the serialized project');
    history.undo();
    ok(serialize(project) === before, '2b commit→undo is byte-identical (Phase-1 lossless contract)');
  }

  // ---- 3) verify path: loadGlb runs before commit; VERIFYING phase appears -----------------
  {
    const { project, history, levelId } = freshProjectHistory();
    const phases = []; let loadedSrc = null; let loadedBeforeCommit = null;
    const transport = fakeTransport([submitOK(), statusSucceeded()]);
    const loadGlb = async (src) => { loadedSrc = src; loadedBeforeCommit = project.furniture.length; };
    await furnishFromImage(PNG_URL, {
      history, transport, levelId, loadGlb, sleep: instantSleep, onPhase: (p) => phases.push(p),
    });
    ok(loadedSrc === GLB_URL, '3a loadGlb called with the result src');
    ok(loadedBeforeCommit === 0, '3b loadGlb runs BEFORE the record is committed');
    ok(project.furniture.length === 1, '3c record committed after a successful verify');
    ok(phases.includes(FurnishPhase.VERIFYING), '3d VERIFYING phase emitted');
    ok(phases.indexOf(FurnishPhase.VERIFYING) < phases.indexOf(FurnishPhase.COMMITTED), '3e VERIFYING precedes COMMITTED');
  }

  // ---- 4) a GLB that won't load is NOT committed (no phantom record) -----------------------
  {
    const { project, history, levelId } = freshProjectHistory();
    const phases = [];
    const transport = fakeTransport([submitOK(), statusSucceeded()]);
    const loadGlb = async () => { throw new Error('404 / not a GLB'); };
    const e = await expectReject(
      furnishFromImage(PNG_URL, { history, transport, levelId, loadGlb, sleep: instantSleep, onPhase: (p) => phases.push(p) }),
      ERROR_CODES.BAD_RESPONSE, '4a load failure rejects as BAD_RESPONSE',
    );
    ok(e && e.details && e.details.stage === 'glb-load', '4b error is tagged stage:glb-load (distinguishes from a bad poll body)');
    ok(project.furniture.length === 0, '4c nothing committed on a load failure');
    ok(!history.canUndo(), '4d undo history untouched on a load failure');
    ok(phases.at(-1) === FurnishPhase.ERROR, '4e ends in the ERROR phase');
    ok(e.userMessage && /loaded/i.test(e.userMessage), '4f carries the GLB-specific user message');
  }

  // ---- 5) upstream failures reject and commit nothing --------------------------------------
  {
    // invalid image — fails before any network call
    const a = freshProjectHistory();
    const ea = await expectReject(
      furnishFromImage('not-a-data-url', { history: a.history, transport: fakeTransport([]), sleep: instantSleep }),
      ERROR_CODES.INVALID_IMAGE, '5a invalid image rejects as INVALID_IMAGE',
    );
    ok(a.project.furniture.length === 0 && !a.history.canUndo(), '5b nothing committed on an invalid image');
    ok(ea.userMessage === messageForError({ code: ERROR_CODES.INVALID_IMAGE }), '5c invalid-image error carries the mapped user message');

    // job reported FAILED by the service
    const b = freshProjectHistory();
    await expectReject(
      furnishFromImage(PNG_URL, {
        history: b.history, sleep: instantSleep,
        transport: fakeTransport([submitOK(), okRes({ status: 'FAILED', error: 'bad geometry' })]),
      }),
      ERROR_CODES.JOB_FAILED, '5d a FAILED job rejects as JOB_FAILED',
    );
    ok(b.project.furniture.length === 0, '5e nothing committed on a failed job');

    // no transport injected
    const c = freshProjectHistory();
    await expectReject(
      furnishFromImage(PNG_URL, { history: c.history, sleep: instantSleep }),
      ERROR_CODES.NO_TRANSPORT, '5f a missing transport rejects as NO_TRANSPORT',
    );
    ok(c.project.furniture.length === 0, '5g nothing committed with no transport');
  }

  // ---- 6) timeout via a fake advancing clock (never waits on the real clock) ---------------
  {
    const { project, history } = freshProjectHistory();
    let t = 0; const now = () => t;
    // Submit succeeds, then every status poll stays PENDING; the clock jumps past the default
    // timeout so the loop ends with TIMEOUT rather than spinning.
    const transport = fakeTransport([submitOK(), ...Array.from({ length: 200 }, () => okRes({ status: 'PENDING' }))]);
    const slept = async () => { t += 60000; };   // each sleep advances 60s → crosses 180s budget fast
    await expectReject(
      furnishFromImage(PNG_URL, { history, transport, sleep: slept, now }),
      ERROR_CODES.TIMEOUT, '6a a never-terminal job rejects as TIMEOUT',
    );
    ok(project.furniture.length === 0, '6b nothing committed on a timeout');
  }

  // ---- 7) cancellation ----------------------------------------------------------------------
  {
    // (a) aborted up front — the pipeline rejects before submit
    const a = freshProjectHistory();
    const ea = await expectReject(
      furnishFromImage(PNG_URL, { history: a.history, transport: fakeTransport([]), signal: { aborted: true }, sleep: instantSleep }),
      ERROR_CODES.ABORTED, '7a an already-aborted signal rejects as ABORTED',
    );
    ok(a.project.furniture.length === 0, '7b nothing committed when aborted up front');
    ok(ea.userMessage === messageForError({ code: ERROR_CODES.ABORTED }), '7c aborted error carries the mapped user message');

    // (b) cancel requested DURING the job, caught by the controller's own guard before verify.
    //     onProgress flips the signal when it sees the terminal snapshot; runFurnishJob returns
    //     the result, then the controller's throwIfAborted(signal) fires before loadGlb runs.
    const b = freshProjectHistory();
    const signal = { aborted: false };
    let loadGlbCalled = false;
    await expectReject(
      furnishFromImage(PNG_URL, {
        history: b.history, sleep: instantSleep, signal,
        transport: fakeTransport([submitOK(), statusSucceeded()]),
        onProgress: (snap) => { if (snap.status === JobStatus.SUCCEEDED) signal.aborted = true; },
        loadGlb: async () => { loadGlbCalled = true; },
      }),
      ERROR_CODES.ABORTED, '7d a cancel during the job (before verify) rejects as ABORTED',
    );
    ok(loadGlbCalled === false, '7e the GLB verifier never runs once cancelled');
    ok(b.project.furniture.length === 0, '7f nothing committed on a mid-job cancel');
  }

  // ---- 8) messageForError mapping -----------------------------------------------------------
  {
    for (const code of Object.values(ERROR_CODES)) {
      ok(typeof messageForError({ code }) === 'string' && messageForError({ code }).length > 0, `8-${code} maps to a non-empty message`);
    }
    ok(messageForError(new Error('x')) === messageForError(null), '8y a plain Error falls back like null');
    ok(messageForError({ code: 'totally-unknown' }).length > 0, '8z an unknown code still yields the fallback message');
    const withOwn = Object.assign(new Error('x'), { userMessage: 'custom' });
    ok(messageForError(withOwn) === 'custom', '8w a pre-set .userMessage wins over the code map');
  }

  // ---- 9) a History is required (wiring-bug guard, not a user-facing furnish failure) ------
  {
    let threw = null;
    try { await furnishFromImage(PNG_URL, { transport: fakeTransport([]) }); }
    catch (e) { threw = e; }
    ok(threw instanceof TypeError, '9a a missing history throws a TypeError (programmer error)');
  }

  // ---- 10) a throwing onPhase callback never breaks the flow -------------------------------
  {
    const { project, history, levelId } = freshProjectHistory();
    const transport = fakeTransport([submitOK(), statusSucceeded()]);
    const out = await furnishFromImage(PNG_URL, {
      history, transport, levelId, sleep: instantSleep, onPhase: () => { throw new Error('UI blew up'); },
    });
    ok(out.furniture && project.furniture.length === 1, '10a commit still succeeds despite a throwing onPhase');
  }

  // ---- summary ------------------------------------------------------------------------------
  console.log('');
  if (fail === 0) {
    console.log(`furnish-controller: ${pass} passed, 0 failed`);
    console.log('  ✓ src/test/furnish-controller.test.mjs');
  } else {
    console.log(`furnish-controller: ${pass} passed, ${fail} FAILED`);
    for (const m of fails) console.log('    - ' + m);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
