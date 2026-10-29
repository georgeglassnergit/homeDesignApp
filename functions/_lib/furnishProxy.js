// Same-origin furnish proxy — the SERVER half of the image→3D contract (engine-independent,
// pure request logic; no Three.js, no DOM, no Cloudflare globals at import time).
//
// Why this module exists
// ----------------------
// The client pipeline (src/core/furnishPipeline.js) deliberately never holds the provider API
// key: it talks ONLY to the app's own same-origin endpoint `/api/furnish`, and asserts it never
// attaches an Authorization / api-key header (constraint #7 — "the Meshy API key stays
// server-side"). Something on the server has to be that endpoint: accept the browser's request,
// attach the secret key, call the provider (Meshy), and hand back a NORMALIZED response in the
// exact shape the client's parsers expect. That is this module.
//
// It is the pure decision core. Every side effect — the network `fetch`, the environment that
// holds the key — is INJECTED, so the whole thing is unit-testable in plain Node against a
// synthetic transport with NO live API call and NO real key (mirroring how furnishPipeline.js is
// proven). The thin Cloudflare Pages Function wrappers in functions/api/ bind the real `fetch`
// and the real `env`; they contain no logic.
//
// Contract it fulfils (the shapes furnishPipeline.js reads back — see its parseSubmitResponse /
// parseStatusResponse):
//   POST {endpoint}            { image }                 → 200 { jobId }
//   GET  {endpoint}/{jobId}                              → 200 { status, progress, glbUrl,
//                                                                name?, thumbnailUrl?, error? }
// On trouble it returns a plain `{ error }` body with an HTTP status the client already classifies
// (429 / 5xx → transient/retryable on a poll; 4xx → permanent / fail-fast).
//
// SECRET SAFETY (the invariant the whole design exists to protect):
//   • The key is read from `env` server-side and placed ONLY on the request to the provider.
//   • It is NEVER placed in any response returned to the browser, and NEVER logged.
//   • If the key is absent the endpoint is simply "not configured" (503) — it never 500s in a way
//     that could echo internals, and it never falls back to an unauthenticated provider call.

// ---- provider configuration ------------------------------------------------

// Meshy OpenAPI image-to-3D. Isolated here so a provider swap (or a test) is a single override,
// and so no provider host/path is ever hard-coded into a request builder below.
export const PROVIDER_DEFAULTS = Object.freeze({
  // The provider's image-to-3D collection endpoint. Submit POSTs here; status GETs `${base}/${id}`.
  base: 'https://api.meshy.ai/openapi/v1/image-to-3d',
  // The env var (Cloudflare Pages binding / `.dev.vars`) that holds the secret key. Server-side only.
  keyEnv: 'MESHY_API_KEY',
  // Extra fields merged into the submit body. Conservative, provider-sensible defaults.
  submitExtras: Object.freeze({ enable_pbr: true }),
});

function resolveConfig(config) {
  const c = config || {};
  const base = typeof c.base === 'string' && c.base.trim() ? c.base.trim().replace(/\/+$/, '') : PROVIDER_DEFAULTS.base;
  const keyEnv = typeof c.keyEnv === 'string' && c.keyEnv.trim() ? c.keyEnv.trim() : PROVIDER_DEFAULTS.keyEnv;
  const submitExtras = c.submitExtras && typeof c.submitExtras === 'object' ? c.submitExtras : PROVIDER_DEFAULTS.submitExtras;
  return { base, keyEnv, submitExtras };
}

// Read the secret key from the injected environment. Returns a trimmed non-empty string, or null
// when unset/blank. Never throws, never logs the value.
export function readServerKey(env, config) {
  const { keyEnv } = resolveConfig(config);
  const raw = env && typeof env === 'object' ? env[keyEnv] : undefined;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// ---- request construction (the key goes HERE and only here) ----------------

// Build the provider submit request descriptor. The Authorization header is the ONLY place the
// key ever appears. `image` is passed straight through as the provider's `image_url` (Meshy
// accepts a data URI or a public URL); the client already validated it, and we re-guard the
// coarse shape in handleFurnish before calling this.
export function buildProviderSubmit(image, key, config) {
  const { base, submitExtras } = resolveConfig(config);
  return {
    url: base,
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ image_url: image, ...submitExtras }),
  };
}

export function buildProviderStatus(jobId, key, config) {
  const { base } = resolveConfig(config);
  return {
    url: `${base}/${encodeURIComponent(jobId)}`,
    method: 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
    },
  };
}

// ---- response normalization (provider shape → client contract) -------------

// Pull the task id out of a provider submit response. Meshy returns `{ result: "<task_id>" }`;
// we also tolerate `{ id }` / `{ task_id }` / an already-normalized `{ jobId }`. Returns a
// non-empty string, or null when none is present.
export function extractJobId(providerJson) {
  const o = providerJson && typeof providerJson === 'object' ? providerJson : {};
  const id = o.result || o.jobId || o.id || o.task_id || o.taskId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

// Normalize a provider status payload to EXACTLY the client contract shape
// (`{ status, progress, glbUrl, name, thumbnailUrl, error }`). The client's parseStatusResponse
// is itself tolerant of raw Meshy, but normalizing here keeps the browser decoupled from the
// provider's field names and is the documented seam. Status is forwarded as a lower-cased string
// the client's normalizeStatus maps; a missing glb/name/thumbnail/error becomes null.
export function normalizeStatusPayload(providerJson) {
  const o = providerJson && typeof providerJson === 'object' ? providerJson : {};
  const modelUrls = o.model_urls || o.modelUrls || null;
  const glbUrl =
    (typeof o.glbUrl === 'string' && o.glbUrl) ||
    (modelUrls && typeof modelUrls.glb === 'string' && modelUrls.glb) ||
    null;

  let error = null;
  if (typeof o.error === 'string' && o.error) error = o.error;
  else if (o.task_error && typeof o.task_error === 'object' && typeof o.task_error.message === 'string') error = o.task_error.message || null;
  else if (typeof o.task_error === 'string' && o.task_error) error = o.task_error;

  let progress = 0;
  if (Number.isFinite(o.progress)) progress = o.progress > 1 ? o.progress / 100 : o.progress;
  if (progress < 0) progress = 0; else if (progress > 1) progress = 1;

  return {
    status: typeof o.status === 'string' ? o.status.trim().toLowerCase() : 'pending',
    progress,
    glbUrl,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null,
    thumbnailUrl:
      (typeof o.thumbnailUrl === 'string' && o.thumbnailUrl) ||
      (typeof o.thumbnail_url === 'string' && o.thumbnail_url) ||
      null,
    error,
  };
}

// ---- upstream status mapping -----------------------------------------------

// Map a provider HTTP status onto the status we return to the browser, chosen so the client's
// own classifier (furnishPipeline isTransientStatus: 429 & 5xx → transient/retry; 4xx →
// permanent/fail-fast) does the right thing, WITHOUT ever leaking which upstream auth/validation
// detail failed:
//   • 429            → 429  (rate limited; a status poll may retry)
//   • 5xx            → 502  (upstream/gateway hiccup; a status poll may retry)
//   • 404            → 404  (the job is genuinely gone; fail fast)
//   • anything else  → 502  (incl. 400/401/403: collapse to a generic upstream failure — the real
//                            code is logged server-side for the operator, never sent to the client)
export function mapUpstreamStatus(providerStatus) {
  const s = providerStatus;
  if (s === 429) return 429;
  if (Number.isFinite(s) && s >= 500) return 502;
  if (s === 404) return 404;
  return 502;
}

// ---- the one entry point ---------------------------------------------------

// Coarse image guard (defense in depth — the client validates thoroughly, but the endpoint is
// publicly reachable). Accept a base64 data URL or an http(s) URL; reject anything else before a
// provider round-trip. Does NOT re-decode/limit bytes (the client does, and the provider enforces
// its own limits) — this only rejects obviously-wrong input.
function imageLooksUsable(image) {
  if (typeof image !== 'string') return false;
  const s = image.trim();
  if (!s) return false;
  return /^data:[^;,]+;base64,/i.test(s) || /^https?:\/\//i.test(s);
}

// handleFurnish — dispatch a browser request to the provider and return a normalized result.
//
//   method    'POST' (submit) | 'GET' (status)
//   jobId     required for GET; the task id from a prior submit
//   body      parsed request body for POST, e.g. `{ image }`
//   env       the environment holding the secret key (Cloudflare Pages binding / .dev.vars)
//   fetchImpl fetch-like `(url, init) => Promise<Response>` — INJECTED (never a global)
//   config    optional provider override (base / keyEnv / submitExtras)
//
// Resolves to `{ status, json }` — an HTTP status and a plain JS body object. Never throws for an
// expected failure; a thrown `fetchImpl` is caught and reported as an upstream failure. The key is
// never present in `json` on any path.
export async function handleFurnish({ method, jobId, body, env, fetchImpl, config } = {}) {
  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  if (verb !== 'POST' && verb !== 'GET') {
    return { status: 405, json: { error: 'method not allowed' } };
  }
  if (typeof fetchImpl !== 'function') {
    // Wiring bug on the server, not a client error — but still never leak internals.
    return { status: 500, json: { error: 'furnish service is misconfigured' } };
  }

  const key = readServerKey(env, config);
  if (!key) {
    // The operator has not set the provider key (Cloudflare Pages env binding / .dev.vars). The
    // endpoint simply reports itself unconfigured; it never calls the provider unauthenticated.
    return { status: 503, json: { error: 'furnish service is not configured' } };
  }

  try {
    if (verb === 'POST') {
      const image = body && typeof body === 'object' ? body.image : undefined;
      if (!imageLooksUsable(image)) {
        return { status: 400, json: { error: 'a base64 image data URL is required' } };
      }
      const req = buildProviderSubmit(image, key, config);
      const res = await callProvider(fetchImpl, req);
      if (!res.ok) {
        logUpstream('submit', res.status);
        return { status: mapUpstreamStatus(res.status), json: { error: 'could not start 3D generation' } };
      }
      const id = extractJobId(res.json);
      if (!id) return { status: 502, json: { error: 'unexpected response from the 3D service' } };
      return { status: 200, json: { jobId: id } };
    }

    // GET — status poll
    if (typeof jobId !== 'string' || !jobId.trim()) {
      return { status: 400, json: { error: 'a job id is required' } };
    }
    const req = buildProviderStatus(jobId.trim(), key, config);
    const res = await callProvider(fetchImpl, req);
    if (!res.ok) {
      logUpstream('status', res.status);
      return { status: mapUpstreamStatus(res.status), json: { error: 'could not read generation status' } };
    }
    return { status: 200, json: normalizeStatusPayload(res.json) };
  } catch (e) {
    // A thrown fetch (network drop) or a non-JSON upstream body. Report as an upstream failure the
    // client can retry on a poll; never surface the raw cause (it could contain a URL with the key
    // if a future provider ever put it in a query string).
    logUpstream('exception', undefined);
    return { status: 502, json: { error: 'the 3D service is unavailable' } };
  }
}

// Call the provider and read its JSON body. Returns `{ ok, status, json }`. A non-2xx response is
// surfaced via `ok:false` (body not read). A 2xx whose body is not JSON throws, so the caller maps
// it to a generic upstream failure rather than forwarding garbage.
async function callProvider(fetchImpl, req) {
  const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
  const status = res && typeof res.status === 'number' ? res.status : undefined;
  const ok = !!(res && (res.ok === true || (Number.isFinite(status) && status >= 200 && status < 300)));
  if (!ok) return { ok: false, status, json: null };
  const json = typeof res.json === 'function' ? await res.json() : res.body;
  return { ok: true, status, json };
}

// Server-side-only diagnostics. Logs the stage and upstream HTTP status (NEVER the key, never a
// URL, never a request/response body) so an operator can tell a bad key (401/403) from a provider
// outage (5xx) in the deployment logs. Guarded so it is a no-op where no console exists.
function logUpstream(stage, status) {
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`furnish-proxy: ${stage} upstream ${status == null ? 'exception' : 'HTTP ' + status}`);
    }
  } catch { /* never let logging break the request */ }
}
