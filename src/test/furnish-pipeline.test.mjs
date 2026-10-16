// Furnish (image→3D) pipeline — engine-independent orchestration verification.
// Run: node src/test/furnish-pipeline.test.mjs
//
// F1 (Phase 4 kickoff): the PURE logic of the Meshy image-to-3D pipeline — image
// validation, request construction, job-status parsing, and the submit→poll→result state
// machine — with every side effect (network, timers, cancellation) injected. This suite
// proves the real logic against SYNTHETIC responses only: a fake transport, a fake clock,
// an instant sleep — never a live API call (constraint: F1 "stays synthetic in CI"). It
// has no Three.js import — running under plain Node is itself the model/view separation
// guard. Own file (pick-protocol §5) so it never collides with in-flight test work.
//
// It also locks the SECRETS-SERVER-SIDE invariant (constraint #7): no request this client
// builds ever carries a provider credential, and no default points at a provider host or
// embeds a key — the same-origin proxy injects the key server-side.
import {
  JobStatus, normalizeStatus, FURNISH_DEFAULTS, FurnishError, ERROR_CODES,
  validateImageInput, buildSubmitRequest, buildStatusRequest,
  parseSubmitResponse, parseStatusResponse, runFurnishJob, toFurniture,
} from '../core/furnishPipeline.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// A valid 1x1 PNG as a base64 data URL (small, well-formed) — the stand-in "photo".
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_1x1}`;

// A scripted fake transport: returns queued responses in order, recording every request it
// sees (so we can assert the security invariant across the whole flow). Each scripted entry is
// either a function `(req) => fetchLikeResult` (full control) or a descriptor from one of the
// helpers below. It THROWS if a test under-scripts (runs out) — so a mis-scripted test fails
// fast instead of spinning, never waiting on the real clock.
function fakeTransport(responses) {
  const q = responses.slice();
  const seen = [];
  const fn = async (req) => {
    seen.push(req);
    if (!q.length) throw new Error('fakeTransport: ran out of scripted responses (under-scripted test)');
    const r = q.shift();
    if (typeof r === 'function') return r(req);
    if (r.httpError) return { ok: false, status: r.status || 500, json: async () => ({}) };
    if (r.jsonThrows) return { ok: true, status: 200, json: async () => { throw new Error('response was not JSON'); } };
    return { ok: true, status: 200, json: async () => r.json };
  };
  fn.seen = seen;
  return fn;
}
const okRes = (json) => ({ json });                 // a 200 carrying this JSON body
const httpError = (status) => ({ httpError: true, status });  // a non-2xx response
const jsonThrows = () => ({ jsonThrows: true });    // a 200 whose body fails to parse as JSON
const instantSleep = () => Promise.resolve();

// await a promise and assert it rejects with a FurnishError carrying `code`.
async function expectReject(promise, code, msg) {
  try { await promise; ok(false, `${msg} (expected throw ${code}, got resolve)`); }
  catch (e) { ok(e instanceof FurnishError && e.code === code, `${msg} (got ${e && e.code} / ${e && e.message})`); }
}

async function main() {
  // ---- 1) normalizeStatus -----------------------------------------------------------------
  {
    ok(normalizeStatus('PENDING') === JobStatus.PENDING, '1a PENDING → pending');
    ok(normalizeStatus('IN_PROGRESS') === JobStatus.RUNNING, '1b IN_PROGRESS → running');
    ok(normalizeStatus('processing') === JobStatus.RUNNING, '1c processing → running');
    ok(normalizeStatus('SUCCEEDED') === JobStatus.SUCCEEDED, '1d SUCCEEDED → succeeded');
    ok(normalizeStatus('completed') === JobStatus.SUCCEEDED, '1e completed → succeeded');
    ok(normalizeStatus('FAILED') === JobStatus.FAILED, '1f FAILED → failed');
    ok(normalizeStatus('canceled') === JobStatus.FAILED, '1g canceled → failed');
    ok(normalizeStatus('EXPIRED') === JobStatus.EXPIRED, '1h EXPIRED → expired');
    ok(normalizeStatus('something-new') === JobStatus.PENDING, '1i unknown → pending (keep polling, never strand terminal)');
    ok(normalizeStatus(null) === JobStatus.PENDING && normalizeStatus(42) === JobStatus.PENDING, '1j non-string → pending');
    ok(normalizeStatus(' Succeeded ') === JobStatus.SUCCEEDED, '1k trims + case-insensitive');
  }

  // ---- 2) validateImageInput --------------------------------------------------------------
  {
    const v = validateImageInput(PNG_URL);
    ok(v.mimeType === 'image/png' && v.base64 === PNG_1x1, '2a data URL → { mimeType, base64 }');
    ok(v.byteLength > 0 && v.byteLength < 200, '2b byteLength decoded from base64 (~tiny png)');
    ok(validateImageInput({ dataUrl: PNG_URL }).mimeType === 'image/png', '2c accepts { dataUrl }');
    ok(validateImageInput({ base64: PNG_1x1, mimeType: 'image/png' }).base64 === PNG_1x1, '2d accepts { base64, mimeType }');

    let threw = (fn, code) => { try { fn(); return false; } catch (e) { return e instanceof FurnishError && e.code === code; } };
    ok(threw(() => validateImageInput('not-a-data-url'), ERROR_CODES.INVALID_IMAGE), '2e bare string that is not a data URL → invalid-image');
    ok(threw(() => validateImageInput('data:image/png;base64,'), ERROR_CODES.INVALID_IMAGE), '2f empty data → invalid-image');
    ok(threw(() => validateImageInput('data:image/png;base64,****'), ERROR_CODES.INVALID_IMAGE), '2g non-base64 payload → invalid-image');
    ok(threw(() => validateImageInput(`data:image/gif;base64,${PNG_1x1}`), ERROR_CODES.INVALID_IMAGE), '2h unsupported type (gif) → invalid-image');
    ok(threw(() => validateImageInput(null), ERROR_CODES.INVALID_IMAGE), '2i null → invalid-image');
    ok(threw(() => validateImageInput({}), ERROR_CODES.INVALID_IMAGE), '2j object without image data → invalid-image');
    // oversize: a 10-byte limit rejects the little png.
    ok(threw(() => validateImageInput(PNG_URL, { maxImageBytes: 10 }), ERROR_CODES.INVALID_IMAGE), '2k over the byte limit → invalid-image');
    // custom accepted types.
    ok(validateImageInput(`data:image/webp;base64,${PNG_1x1}`).mimeType === 'image/webp', '2l webp accepted by default');
    ok(validateImageInput(`data:image/png;base64,${PNG_1x1}`, { acceptedTypes: ['image/png'] }).mimeType === 'image/png', '2m honors custom acceptedTypes');
    // whitespace inside base64 is tolerated (data URLs sometimes wrap).
    ok(validateImageInput(`data:image/png;base64,${PNG_1x1.slice(0, 8)}\n${PNG_1x1.slice(8)}`).base64 === PNG_1x1, '2n strips whitespace inside base64');
  }

  // ---- 3) buildSubmitRequest / buildStatusRequest (NO secrets) -----------------------------
  {
    const req = buildSubmitRequest(PNG_URL);
    ok(req.method === 'POST' && req.url === FURNISH_DEFAULTS.endpoint, '3a submit is POST to the configured endpoint');
    ok(typeof req.body === 'string' && JSON.parse(req.body).image.startsWith('data:image/png;base64,'), '3b submit body carries the image data URL');
    const hk = Object.keys(req.headers).map((k) => k.toLowerCase());
    ok(!hk.some((k) => /^(authorization|x-api-key|api-key|x-meshy-key)$/.test(k)), '3c submit request carries NO credential header (key stays server-side)');
    ok(req.headers['content-type'] === 'application/json', '3d submit sends JSON');

    const sreq = buildStatusRequest('task-123');
    ok(sreq.method === 'GET' && sreq.url === `${FURNISH_DEFAULTS.endpoint}/task-123`, '3e status GET composes endpoint/jobId');
    ok(buildStatusRequest('a/b?c').url.endsWith('/a%2Fb%3Fc'), '3f status jobId is URL-encoded');
    let threw = false; try { buildStatusRequest(''); } catch (e) { threw = e instanceof FurnishError; }
    ok(threw, '3g empty jobId → throws');
    // trailing slash on a custom endpoint is normalized away.
    ok(buildStatusRequest('x', { endpoint: 'https://app.example/api/furnish/' }).url === 'https://app.example/api/furnish/x', '3h trailing slash on endpoint normalized');
  }

  // ---- 4) parseSubmitResponse -------------------------------------------------------------
  {
    ok(parseSubmitResponse({ jobId: 'j1' }).jobId === 'j1', '4a normalized { jobId }');
    ok(parseSubmitResponse({ result: 'meshy-task-9' }).jobId === 'meshy-task-9', '4b raw Meshy { result } (task id)');
    ok(parseSubmitResponse({ id: 'id-7' }).jobId === 'id-7', '4c { id } fallback');
    ok(parseSubmitResponse({ task_id: 't_7' }).jobId === 't_7', '4d { task_id } fallback');
    let threw = (j) => { try { parseSubmitResponse(j); return false; } catch (e) { return e instanceof FurnishError && e.code === ERROR_CODES.BAD_RESPONSE; } };
    ok(threw({}), '4e no id → bad-response');
    ok(threw(null), '4f null → bad-response');
    ok(threw({ jobId: '   ' }), '4g blank id → bad-response');
  }

  // ---- 5) parseStatusResponse -------------------------------------------------------------
  {
    const s1 = parseStatusResponse({ status: 'SUCCEEDED', glbUrl: 'https://cdn/x.glb', progress: 100, name: 'Chair', thumbnail_url: 'https://cdn/t.png' });
    ok(s1.status === JobStatus.SUCCEEDED && s1.glbUrl === 'https://cdn/x.glb', '5a normalized success → glbUrl');
    ok(s1.progress === 1 && s1.name === 'Chair' && s1.thumbnailUrl === 'https://cdn/t.png', '5b progress 100 → 1.0, name + thumbnail carried');
    ok(s1.isTerminal === true, '5c SUCCEEDED is terminal');

    const s2 = parseStatusResponse({ status: 'SUCCEEDED', model_urls: { glb: 'https://cdn/raw.glb' } });
    ok(s2.glbUrl === 'https://cdn/raw.glb', '5d raw Meshy model_urls.glb picked up');

    const s3 = parseStatusResponse({ status: 'IN_PROGRESS', progress: 0.5 });
    ok(s3.status === JobStatus.RUNNING && s3.progress === 0.5 && s3.isTerminal === false, '5e running, progress 0.5 fraction, not terminal');

    const s4 = parseStatusResponse({ status: 'FAILED', task_error: { message: 'bad mesh' } });
    ok(s4.status === JobStatus.FAILED && s4.error === 'bad mesh', '5f raw Meshy task_error.message → error');
    ok(parseStatusResponse({ status: 'FAILED', task_error: 'flat string' }).error === 'flat string', '5g string task_error → error');
    ok(parseStatusResponse({ status: 'error', error: 'nope' }).error === 'nope', '5h normalized error field');

    const s5 = parseStatusResponse({ status: 'IN_PROGRESS', progress: 150 });
    ok(s5.progress === 1, '5i progress clamps to 1');
    ok(parseStatusResponse({ progress: -5 }).progress === 0, '5j negative progress clamps to 0');
    ok(parseStatusResponse(null).status === JobStatus.PENDING, '5k null body → pending snapshot (no throw)');
  }

  // ---- 6) runFurnishJob — happy path ------------------------------------------------------
  {
    const progress = [];
    const transport = fakeTransport([
      okRes({ result: 'task-1' }),                                 // submit
      okRes({ status: 'PENDING', progress: 0 }),                   // poll 1
      okRes({ status: 'IN_PROGRESS', progress: 50 }),              // poll 2
      okRes({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://cdn/sofa.glb' }, name: 'Sofa' }), // poll 3
    ]);
    const res = await runFurnishJob(PNG_URL, {
      transport, sleep: instantSleep,
      onProgress: (p) => progress.push(p.status),
    });
    ok(res.src === 'https://cdn/sofa.glb' && res.name === 'Sofa', '6a success → { src, name } from the GLB');
    ok(res.jobId === 'task-1' && res.polls === 3, '6b jobId threaded through, 3 polls to terminal');
    ok(progress.join(',') === 'pending,running,succeeded', '6c onProgress fired once per poll with normalized status');
    // submit POST first, then GETs to endpoint/jobId.
    ok(transport.seen[0].method === 'POST' && transport.seen[1].method === 'GET', '6d submit POST then status GETs');
    ok(transport.seen[3].url === `${FURNISH_DEFAULTS.endpoint}/task-1`, '6e status polls the returned job id');
  }

  // ---- 7) runFurnishJob — failure paths ---------------------------------------------------
  {
    await expectReject(runFurnishJob(PNG_URL, {
      transport: fakeTransport([okRes({ jobId: 'j' }), okRes({ status: 'FAILED', task_error: { message: 'gen error' } })]),
      sleep: instantSleep,
    }), ERROR_CODES.JOB_FAILED, '7a terminal FAILED → job-failed');

    await expectReject(runFurnishJob(PNG_URL, {
      transport: fakeTransport([okRes({ jobId: 'j' }), okRes({ status: 'EXPIRED' })]),
      sleep: instantSleep,
    }), ERROR_CODES.JOB_EXPIRED, '7b terminal EXPIRED → job-expired');

    await expectReject(runFurnishJob(PNG_URL, {
      transport: fakeTransport([okRes({ jobId: 'j' }), okRes({ status: 'SUCCEEDED' })]),  // no glbUrl
      sleep: instantSleep,
    }), ERROR_CODES.BAD_RESPONSE, '7c succeeded but no GLB url → bad-response');

    await expectReject(runFurnishJob(PNG_URL, { sleep: instantSleep }),
      ERROR_CODES.NO_TRANSPORT, '7d missing transport → no-transport');

    await expectReject(runFurnishJob(PNG_URL, {
      transport: fakeTransport([httpError(502)]),
      sleep: instantSleep,
    }), ERROR_CODES.SUBMIT_FAILED, '7e submit HTTP 502 → submit-failed');

    await expectReject(runFurnishJob(PNG_URL, {
      transport: async () => { throw new Error('network down'); },
      sleep: instantSleep,
    }), ERROR_CODES.SUBMIT_FAILED, '7f transport throws on submit → submit-failed');

    await expectReject(runFurnishJob(PNG_URL, {
      transport: fakeTransport([okRes({ jobId: 'j' }), jsonThrows()]),
      sleep: instantSleep,
    }), ERROR_CODES.BAD_RESPONSE, '7g non-JSON status body → bad-response');

    await expectReject(runFurnishJob('not-an-image', { transport: fakeTransport([]), sleep: instantSleep }),
      ERROR_CODES.INVALID_IMAGE, '7h invalid image rejected before any network call');
  }

  // ---- 8) runFurnishJob — timeout (fake clock, respects pollInterval) ----------------------
  {
    let t = 0;
    const now = () => t;
    const sleep = (ms) => { t += ms; return Promise.resolve(); };   // advancing the fake clock
    // status never terminates; with timeout 5000 and interval 2000, the loop must give up.
    const transport = fakeTransport([okRes({ jobId: 'j' }), ...Array(100).fill(okRes({ status: 'IN_PROGRESS' }))]);
    await expectReject(runFurnishJob(PNG_URL, {
      transport, sleep, now, config: { pollIntervalMs: 2000, timeoutMs: 5000 },
    }), ERROR_CODES.TIMEOUT, '8a non-terminal job → timeout');
    // t: poll@0 (sleep→2000), poll@2000 (sleep→4000), poll@4000 then 4000+2000>5000 → stop. 3 polls.
    ok(t === 4000, `8b stops before exceeding timeout (clock at ${t}, not run past 5000)`);

    // 8c maxPolls valve: a FROZEN clock (never advances) must NOT spin forever — the hard poll
    // cap ends it. This is the exact pathology the valve exists for.
    let capturedPolls = -1;
    const frozenNow = () => 0;
    const transport2 = fakeTransport([okRes({ jobId: 'j' }), ...Array(50).fill(okRes({ status: 'IN_PROGRESS' }))]);
    try {
      await runFurnishJob(PNG_URL, { transport: transport2, sleep: instantSleep, now: frozenNow, config: { maxPolls: 5, timeoutMs: 1e9, pollIntervalMs: 1 } });
      ok(false, '8c frozen clock should still terminate via maxPolls');
    } catch (e) {
      capturedPolls = e && e.details && e.details.polls;
      ok(e instanceof FurnishError && e.code === ERROR_CODES.TIMEOUT, `8c frozen clock → timeout via maxPolls (got ${e && e.code})`);
    }
    ok(capturedPolls === 5, `8d stopped exactly at the poll cap (polls=${capturedPolls})`);
  }

  // ---- 9) runFurnishJob — cancellation -----------------------------------------------------
  {
    const signal = { aborted: true };
    await expectReject(runFurnishJob(PNG_URL, { transport: fakeTransport([]), sleep: instantSleep, signal }),
      ERROR_CODES.ABORTED, '9a pre-aborted signal → aborted (no submit)');

    // abort mid-poll: flip the signal after the submit response is consumed.
    const sig = { aborted: false };
    const transport = fakeTransport([
      (req) => { sig.aborted = true; return { ok: true, status: 200, json: async () => ({ jobId: 'j' }) }; },
      okRes({ status: 'IN_PROGRESS' }),
    ]);
    await expectReject(runFurnishJob(PNG_URL, { transport, sleep: instantSleep, signal: sig }),
      ERROR_CODES.ABORTED, '9b abort after submit → aborted before polling');
  }

  // ---- 10) SECURITY invariant: no credential header anywhere, no provider host/key default -
  {
    const transport = fakeTransport([
      okRes({ jobId: 'j' }),
      okRes({ status: 'SUCCEEDED', glbUrl: 'https://cdn/x.glb' }),
    ]);
    await runFurnishJob(PNG_URL, { transport, sleep: instantSleep });
    let leaked = false;
    for (const req of transport.seen) {
      for (const k of Object.keys(req.headers || {})) {
        if (/^(authorization|x-api-key|api-key|x-meshy-key)$/i.test(k)) leaked = true;
      }
    }
    ok(!leaked, '10a no request in the whole flow carried a credential header');
    ok(FURNISH_DEFAULTS.endpoint.startsWith('/'), '10b default endpoint is same-origin relative (proxy owns the key)');
    const blob = JSON.stringify(FURNISH_DEFAULTS).toLowerCase();
    ok(!blob.includes('meshy.ai') && !blob.includes('api_key') && !blob.includes('bearer'), '10c no provider host or key token baked into defaults');
  }

  // ---- 11) toFurniture — model bridge ------------------------------------------------------
  {
    const f = toFurniture({ src: 'https://cdn/lamp.glb', name: 'Lamp' }, { levelId: 'L1', position: { x: 2, z: 3 } });
    ok(f.src === 'https://cdn/lamp.glb' && f.name === 'Lamp', '11a builds a furniture record with src + name');
    ok(f.levelId === 'L1' && f.position.x === 2 && f.position.z === 3, '11b forwards placement opts to createFurniture');
    ok(typeof f.id === 'string' && f.id.startsWith('furn'), '11c gets a model furniture id (no new save field)');
    ok(f.rotationY === 0 && f.scale === 1, '11d model defaults applied');
    let threw = false; try { toFurniture({ name: 'x' }); } catch (e) { threw = e instanceof FurnishError && e.code === ERROR_CODES.BAD_RESPONSE; }
    ok(threw, '11e no src → bad-response');
    // name override via opts wins.
    ok(toFurniture({ src: 'u.glb', name: 'Auto' }, { name: 'Manual' }).name === 'Manual', '11f opts.name overrides result.name');
  }

  // ---- 12) config resolution ---------------------------------------------------------------
  {
    const transport = fakeTransport([okRes({ jobId: 'j' }), okRes({ status: 'SUCCEEDED', glbUrl: 'g.glb' })]);
    await runFurnishJob(PNG_URL, { transport, sleep: instantSleep, config: { endpoint: 'https://proxy.example/furnish/' } });
    ok(transport.seen[0].url === 'https://proxy.example/furnish', '12a custom endpoint used, trailing slash stripped');
    ok(transport.seen[1].url === 'https://proxy.example/furnish/j', '12b status poll composes custom endpoint/jobId');
    // bad config values fall back to defaults, never crash.
    const t2 = fakeTransport([okRes({ jobId: 'j' }), okRes({ status: 'SUCCEEDED', glbUrl: 'g.glb' })]);
    const r = await runFurnishJob(PNG_URL, { transport: t2, sleep: instantSleep, config: { pollIntervalMs: -1, timeoutMs: NaN, endpoint: '' } });
    ok(r.src === 'g.glb', '12c invalid config values fall back to defaults (no crash)');
  }

  // ---- report ------------------------------------------------------------------------------
  console.log(`\nfurnish-pipeline: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILED:'); for (const f of fails) console.log('  · ' + f); process.exit(1); }
}

main().catch((e) => { console.error('furnish-pipeline: unexpected error', e); process.exit(1); });
