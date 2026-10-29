// Same-origin furnish proxy — engine-independent SERVER-half verification.
// Run: node src/test/furnish-proxy.test.mjs
//
// The server half of the image→3D contract (functions/_lib/furnishProxy.js): accept the
// browser's request, attach the server-side provider key, call the provider, and hand back a
// response in the exact shape the CLIENT pipeline reads. This suite proves that logic against
// SYNTHETIC responses only — a fake `fetch`, a fake `env` — never a live API call and never a
// real key (mirroring furnish-pipeline.test.mjs, and honoring F1's "synthetic in CI"). No
// Three.js import; running under plain Node is itself the model/view separation guard.
//
// The crown-jewel invariant (constraint #7 "the key stays server-side"): the key is read from
// `env` and placed ONLY on the provider request's Authorization header — it is never present in
// any body returned to the browser, on any path. §7 deep-scans every response to prove it.
//
// §8 closes the loop: it feeds the proxy's OWN output back through the real client parsers
// (parseSubmitResponse / parseStatusResponse) and asserts they accept it — so the two halves are
// proven to actually agree on the contract, not just individually plausible.
import {
  PROVIDER_DEFAULTS, readServerKey,
  buildProviderSubmit, buildProviderStatus,
  extractJobId, normalizeStatusPayload, mapUpstreamStatus, handleFurnish,
} from '../../functions/_lib/furnishProxy.js';
import { parseSubmitResponse, parseStatusResponse, JobStatus } from '../core/furnishPipeline.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

// A test key that is DISTINCTIVE (so §7's deep scan can detect any leak unambiguously) and
// obviously-synthetic (never a real credential).
const KEY = 'sk-test-SECRET-9f3c2a-DO-NOT-LEAK';
const envWithKey = { MESHY_API_KEY: KEY, OTHER: 'noise' };
const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A scripted fake fetch: returns queued responses in order, recording every (url, init) it sees
// (so §7 can scan the exact outbound requests). Each entry is a function `(url,init)=>res`, or a
// descriptor from the helpers below. THROWS when under-scripted so a mis-scripted test fails fast.
function fakeFetch(responses) {
  const q = responses.slice();
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, init });
    if (!q.length) throw new Error('fakeFetch: ran out of scripted responses (under-scripted test)');
    const r = q.shift();
    if (typeof r === 'function') return r(url, init);
    if (r.throws) throw new Error('network down');
    const status = r.status || 200;
    if (status < 200 || status >= 300) return { ok: false, status, json: async () => ({ provider: 'error', secret_echo: KEY }) };
    if (r.jsonThrows) return { ok: true, status, json: async () => { throw new Error('not json'); } };
    return { ok: true, status, json: async () => r.json };
  };
  fn.seen = seen;
  return fn;
}
const res = (json) => ({ json });            // a 200 carrying this JSON body
const up = (status) => ({ status });         // a non-2xx upstream response (its body even contains KEY)
const thrown = () => ({ throws: true });     // fetch rejects (network drop)
const badJson = () => ({ jsonThrows: true });// a 200 whose body is not JSON

// Deep scan: does `value` contain `secret` anywhere (in any string value OR key)?
function containsSecret(value, secret) {
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') return v.includes(secret);
    if (v && typeof v === 'object') {
      if (seen.has(v)) return false; seen.add(v);
      for (const k of Object.keys(v)) { if (k.includes(secret) || walk(v[k])) return true; }
    }
    return false;
  };
  return walk(value);
}

async function main() {
  // ── §1 readServerKey ─────────────────────────────────────────────────────────────────────
  ok(readServerKey(envWithKey) === KEY, '1a reads MESHY_API_KEY from env');
  ok(readServerKey({ MESHY_API_KEY: '  ' + KEY + ' ' }) === KEY, '1b trims surrounding whitespace');
  ok(readServerKey({}) === null, '1c missing key → null');
  ok(readServerKey({ MESHY_API_KEY: '' }) === null, '1d blank key → null');
  ok(readServerKey({ MESHY_API_KEY: '   ' }) === null, '1e whitespace-only key → null');
  ok(readServerKey(null) === null, '1f null env → null (never throws)');
  ok(readServerKey({ MESHY_API_KEY: 123 }) === null, '1g non-string key → null');
  ok(readServerKey({ CUSTOM: KEY }, { keyEnv: 'CUSTOM' }) === KEY, '1h honors a custom keyEnv');
  ok(PROVIDER_DEFAULTS.keyEnv === 'MESHY_API_KEY' && /meshy\.ai/.test(PROVIDER_DEFAULTS.base), '1i defaults name the provider + key env');

  // ── §2 buildProviderSubmit ───────────────────────────────────────────────────────────────
  {
    const r = buildProviderSubmit(PNG_URL, KEY);
    ok(r.method === 'POST', '2a submit is POST');
    ok(r.url === PROVIDER_DEFAULTS.base, '2b submit hits the provider base');
    ok(r.headers.authorization === `Bearer ${KEY}`, '2c Authorization carries the key (server-side only)');
    ok(r.headers['content-type'] === 'application/json', '2d content-type json');
    const body = JSON.parse(r.body);
    ok(body.image_url === PNG_URL, '2e image forwarded as image_url');
    ok(body.enable_pbr === true, '2f submitExtras merged into the body');
    ok(!('authorization' in body) && !containsSecret(body, KEY), '2g key is NOT in the body');
    const r2 = buildProviderSubmit(PNG_URL, KEY, { base: 'https://x.test/api/', submitExtras: { foo: 1 } });
    ok(r2.url === 'https://x.test/api' && JSON.parse(r2.body).foo === 1, '2h config override: base trailing-slash trimmed + custom extras');
  }

  // ── §3 buildProviderStatus ───────────────────────────────────────────────────────────────
  {
    const r = buildProviderStatus('task-123', KEY);
    ok(r.method === 'GET', '3a status is GET');
    ok(r.url === `${PROVIDER_DEFAULTS.base}/task-123`, '3b status hits base/{id}');
    ok(r.headers.authorization === `Bearer ${KEY}`, '3c Authorization carries the key');
    ok(r.body === undefined, '3d GET has no body');
    ok(buildProviderStatus('a/b?c', KEY).url.endsWith('/a%2Fb%3Fc'), '3e job id is URL-encoded (no path injection)');
  }

  // ── §4 extractJobId ──────────────────────────────────────────────────────────────────────
  ok(extractJobId({ result: 'r1' }) === 'r1', '4a Meshy `result` → id');
  ok(extractJobId({ id: 'i1' }) === 'i1', '4b `id` → id');
  ok(extractJobId({ task_id: 't1' }) === 't1', '4c `task_id` → id');
  ok(extractJobId({ jobId: ' j1 ' }) === 'j1', '4d normalized `jobId` (trimmed)');
  ok(extractJobId({}) === null, '4e nothing → null');
  ok(extractJobId({ result: '' }) === null, '4f blank → null');
  ok(extractJobId(null) === null, '4g null → null');

  // ── §5 normalizeStatusPayload ────────────────────────────────────────────────────────────
  {
    const s = normalizeStatusPayload({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'g.glb' }, name: ' Chair ', thumbnail_url: 't.png' });
    ok(s.status === 'succeeded', '5a status lower-cased');
    ok(s.glbUrl === 'g.glb', '5b glbUrl from model_urls.glb');
    ok(s.progress === 1, '5c progress 0..100 → 0..1');
    ok(s.name === 'Chair', '5d name trimmed');
    ok(s.thumbnailUrl === 't.png', '5e thumbnail_url mapped');
    ok(s.error === null, '5f no error → null');
    const s2 = normalizeStatusPayload({ status: 'FAILED', task_error: { message: 'bad image' } });
    ok(s2.error === 'bad image', '5g error from task_error.message');
    ok(normalizeStatusPayload({ task_error: 'boom' }).error === 'boom', '5h error from task_error string');
    ok(normalizeStatusPayload({ glbUrl: 'direct.glb' }).glbUrl === 'direct.glb', '5i glbUrl from a direct field');
    ok(normalizeStatusPayload({ progress: 0.5 }).progress === 0.5, '5j progress already 0..1 kept');
    ok(normalizeStatusPayload({ progress: -5 }).progress === 0 && normalizeStatusPayload({ progress: 999 }).progress === 1, '5k progress clamped');
    ok(normalizeStatusPayload({}).status === 'pending' && normalizeStatusPayload({}).glbUrl === null, '5l empty → pending + null glb');
    ok(normalizeStatusPayload(null).status === 'pending', '5m null → pending (never throws)');
  }

  // ── §6 mapUpstreamStatus ─────────────────────────────────────────────────────────────────
  ok(mapUpstreamStatus(429) === 429, '6a 429 stays 429 (client may retry)');
  ok(mapUpstreamStatus(500) === 502 && mapUpstreamStatus(503) === 502, '6b 5xx → 502 (transient)');
  ok(mapUpstreamStatus(404) === 404, '6c 404 stays 404 (fail fast)');
  ok(mapUpstreamStatus(401) === 502 && mapUpstreamStatus(403) === 502 && mapUpstreamStatus(400) === 502, '6d auth/validation 4xx → generic 502 (no leak of which)');

  // ── §7 handleFurnish — dispatch + SECRET SAFETY ──────────────────────────────────────────
  // not-configured / wiring
  {
    const f = fakeFetch([]);
    const r = await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: {}, fetchImpl: f });
    ok(r.status === 503 && /not configured/.test(r.json.error), '7a no key → 503 not configured');
    ok(f.seen.length === 0, '7b no key → provider NEVER called');
  }
  ok((await handleFurnish({ method: 'PUT', env: envWithKey, fetchImpl: fakeFetch([]) })).status === 405, '7c bad method → 405');
  ok((await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey })).status === 500, '7d missing fetchImpl → 500 (no leak)');

  // submit happy path + outbound request inspection
  {
    const f = fakeFetch([res({ result: 'task-777' })]);
    const r = await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey, fetchImpl: f });
    ok(r.status === 200 && r.json.jobId === 'task-777', '7e submit happy → 200 { jobId }');
    ok(f.seen.length === 1 && f.seen[0].init.headers.authorization === `Bearer ${KEY}`, '7f provider called once WITH the Bearer key');
    ok(f.seen[0].url === PROVIDER_DEFAULTS.base && JSON.parse(f.seen[0].init.body).image_url === PNG_URL, '7g outbound carries image_url to the provider base');
    ok(!containsSecret(r.json, KEY), '7h SECRET: key absent from the submit response body');
  }
  // submit image guard — fetch NOT called
  for (const [img, label] of [[undefined, 'missing'], ['', 'blank'], ['not-a-url', 'non-URL'], [{ x: 1 }, 'non-string']]) {
    const f = fakeFetch([]);
    const r = await handleFurnish({ method: 'POST', body: { image: img }, env: envWithKey, fetchImpl: f });
    ok(r.status === 400 && f.seen.length === 0, `7i ${label} image → 400, provider NOT called`);
  }
  ok((await handleFurnish({ method: 'POST', body: { image: 'https://cdn.test/a.png' }, env: envWithKey, fetchImpl: fakeFetch([res({ result: 'u' })]) })).json.jobId === 'u', '7j an http(s) image URL is accepted');
  // submit upstream failures
  ok((await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey, fetchImpl: fakeFetch([up(400)]) })).status === 502, '7k provider 4xx → 502 generic');
  ok((await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey, fetchImpl: fakeFetch([up(503)]) })).status === 502, '7l provider 5xx → 502');
  ok((await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey, fetchImpl: fakeFetch([up(429)]) })).status === 429, '7m provider 429 → 429');
  ok((await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey, fetchImpl: fakeFetch([res({ noId: true })]) })).status === 502, '7n ok but no job id → 502');
  {
    const r = await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey, fetchImpl: fakeFetch([thrown()]) });
    ok(r.status === 502 && !containsSecret(r.json, KEY), '7o submit fetch throws → 502, no leak');
  }
  // a failing upstream body that CONTAINS the key must never reach the client
  {
    const r = await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey, fetchImpl: fakeFetch([up(500)]) });
    ok(!containsSecret(r.json, KEY), '7p SECRET: a key-bearing upstream error body never reaches the client');
  }

  // status happy path + inspection
  {
    const f = fakeFetch([res({ status: 'IN_PROGRESS', progress: 42 })]);
    const r = await handleFurnish({ method: 'GET', jobId: 'task-777', env: envWithKey, fetchImpl: f });
    ok(r.status === 200 && r.json.status === 'in_progress' && r.json.progress === 0.42, '7q status happy → normalized snapshot');
    ok(f.seen[0].url === `${PROVIDER_DEFAULTS.base}/task-777` && f.seen[0].init.headers.authorization === `Bearer ${KEY}`, '7r status GET hits base/{id} with the key');
    ok(!containsSecret(r.json, KEY), '7s SECRET: key absent from the status response body');
  }
  ok((await handleFurnish({ method: 'GET', jobId: '  ', env: envWithKey, fetchImpl: fakeFetch([]) })).status === 400, '7t blank jobId → 400 (provider not called)');
  ok((await handleFurnish({ method: 'GET', jobId: 'x', env: envWithKey, fetchImpl: fakeFetch([up(404)]) })).status === 404, '7u status provider 404 → 404 (fail fast)');
  ok((await handleFurnish({ method: 'GET', jobId: 'x', env: envWithKey, fetchImpl: fakeFetch([up(503)]) })).status === 502, '7v status provider 5xx → 502');
  ok((await handleFurnish({ method: 'GET', jobId: 'x', env: envWithKey, fetchImpl: fakeFetch([up(429)]) })).status === 429, '7w status provider 429 → 429');
  ok((await handleFurnish({ method: 'GET', jobId: 'x', env: envWithKey, fetchImpl: fakeFetch([thrown()]) })).status === 502, '7x status fetch throws → 502');
  ok((await handleFurnish({ method: 'GET', jobId: 'x', env: envWithKey, fetchImpl: fakeFetch([badJson()]) })).status === 502, '7y status non-JSON body → 502 (never forwards garbage)');

  // ── §8 client-contract conformance (the two halves actually agree) ───────────────────────
  {
    // Submit: the proxy's { jobId } must parse through the CLIENT's parseSubmitResponse.
    const sub = await handleFurnish({ method: 'POST', body: { image: PNG_URL }, env: envWithKey, fetchImpl: fakeFetch([res({ result: 'J-9' })]) });
    ok(parseSubmitResponse(sub.json).jobId === 'J-9', '8a proxy submit body parses via the client parseSubmitResponse');
    // Status (succeeded): the proxy's snapshot must parse to SUCCEEDED + the glb url the client commits.
    const st = await handleFurnish({ method: 'GET', jobId: 'J-9', env: envWithKey, fetchImpl: fakeFetch([res({ status: 'SUCCEEDED', model_urls: { glb: 'final.glb' }, name: 'Sofa', thumbnail_url: 'th.png' })]) });
    const snap = parseStatusResponse(st.json);
    ok(snap.status === JobStatus.SUCCEEDED && snap.isTerminal, '8b proxy status parses to a terminal SUCCEEDED via the client');
    ok(snap.glbUrl === 'final.glb' && snap.name === 'Sofa' && snap.thumbnailUrl === 'th.png', '8c the glb/name/thumbnail survive the round-trip to the client');
    // Status (failed): maps to a terminal FAILED carrying the reason.
    const fl = await handleFurnish({ method: 'GET', jobId: 'J-9', env: envWithKey, fetchImpl: fakeFetch([res({ status: 'FAILED', task_error: { message: 'no object found' } })]) });
    const fsnap = parseStatusResponse(fl.json);
    ok(fsnap.status === JobStatus.FAILED && fsnap.error === 'no object found', '8d proxy FAILED status + reason parses via the client');
  }

  // ---- report ----------------------------------------------------------------------------
  console.log(`\nfurnish-proxy: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILED:'); for (const f of fails) console.log('  · ' + f); process.exit(1); }
  console.log('ALL PASS — furnish-proxy');
}

main().catch((e) => { console.error('furnish-proxy: unexpected error', e); process.exit(1); });
