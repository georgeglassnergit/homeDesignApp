// Engine-independent image→3D furniture pipeline — pure orchestration (no Three.js, no DOM).
//
// F1 (PHASE-3-PLAN.md / PHASE-3-COMPLETE.md "Recommendation"): wire the Meshy image-to-3D
// pipeline behind the already-registered `furnish-photo-3d` seam. This is the Phase 4
// kickoff slice: the PURE logic layer of that pipeline — image validation, request
// construction, job-status parsing, and a submit→poll→result state machine — with every
// side effect (network, timers, cancellation) INJECTED, so the whole flow is unit-testable
// in plain Node against synthetic responses, with no live API call and no browser.
//
// Why a pure core for an inherently-networked feature?
//   • Model/view separation + the "verify headless / verify pure" discipline: the decision
//     logic (what to send, how to read a job, when it's done/failed/timed-out) is data-in /
//     data-out and must not depend on `fetch`, `setTimeout`, Three.js, or the GLB loader.
//     Those are all passed in, so CI exercises the real logic with fakes (constraint: F1
//     "stays synthetic in CI — never a live API call").
//   • Secrets stay server-side (constraint #7). The Meshy API key is NEVER held client-side.
//     This module talks only to the app's OWN same-origin proxy; it asserts it never attaches
//     an Authorization / API-key header. The proxy injects the key server-side.
//
// Contract with the server proxy (normalized shape this client expects back):
//   POST   {endpoint}            { image }                 → { jobId }
//   GET    {endpoint}/{jobId}                              → { status, progress, glbUrl, name?,
//                                                             thumbnailUrl?, error? }
// The status parser is tolerant: it also accepts the RAW Meshy task shape
// (`result`/`model_urls.glb`/`task_error`/`PENDING|IN_PROGRESS|SUCCEEDED|FAILED|EXPIRED`), so
// the eventual proxy can forward Meshy's payload verbatim or pre-normalize it — either works.
//
// The successful result maps straight onto the Phase-1 furniture model: `{ src, name }` →
// `createFurniture(src, { name })` (see `toFurniture` below). No save field is introduced;
// the GLB url/asset id lives in the existing `src` field a Meshy export already populated.

import { createFurniture } from './model.js';

// ---- normalized job status -------------------------------------------------

// The small, stable vocabulary the rest of the app reasons about, independent of the raw
// provider strings. Frozen so callers can `===` compare without typo risk.
export const JobStatus = Object.freeze({
  PENDING: 'pending',     // accepted, not started
  RUNNING: 'running',     // generating
  SUCCEEDED: 'succeeded', // a GLB is ready
  FAILED: 'failed',       // the provider reported an error
  EXPIRED: 'expired',     // the job/asset is no longer retrievable
});

const TERMINAL = new Set([JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.EXPIRED]);

// Raw provider status → normalized. Unknown strings fall back to PENDING (keep polling) so a
// provider adding an intermediate state never strands the state machine on a terminal verdict.
const RAW_STATUS = new Map([
  ['pending', JobStatus.PENDING], ['queued', JobStatus.PENDING], ['not_started', JobStatus.PENDING],
  ['running', JobStatus.RUNNING], ['in_progress', JobStatus.RUNNING], ['processing', JobStatus.RUNNING],
  ['succeeded', JobStatus.SUCCEEDED], ['success', JobStatus.SUCCEEDED], ['completed', JobStatus.SUCCEEDED],
  ['failed', JobStatus.FAILED], ['error', JobStatus.FAILED], ['canceled', JobStatus.FAILED], ['cancelled', JobStatus.FAILED],
  ['expired', JobStatus.EXPIRED],
]);

export function normalizeStatus(raw) {
  if (typeof raw !== 'string') return JobStatus.PENDING;
  return RAW_STATUS.get(raw.trim().toLowerCase()) || JobStatus.PENDING;
}

// ---- configuration ---------------------------------------------------------

// Defaults are deliberately conservative and same-origin. `endpoint` is a RELATIVE path, so
// the browser calls the app's own origin — the proxy that holds the key — never a provider
// host and never an embedded secret.
export const FURNISH_DEFAULTS = Object.freeze({
  endpoint: '/api/furnish',       // same-origin proxy; the server injects the provider key
  pollIntervalMs: 2000,           // between status polls
  timeoutMs: 180000,              // give up after 3 min (a generation can be slow)
  maxImageBytes: 8 * 1024 * 1024, // reject oversized uploads before they hit the network
  acceptedTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
  // Transient-failure tolerance on an INDIVIDUAL status poll. A 3-minute generation polls ~90
  // times; without this, one flaky poll (a dropped connection, HTTP 429, or a proxy 5xx) would
  // throw away the whole in-flight job. These bound how hard a single poll retries before giving
  // up, with exponential backoff between attempts. Permanent failures (HTTP 4xx, a non-JSON
  // body) are never retried — they would only re-fail.
  maxPollRetries: 4,              // transient failures tolerated PER status poll (0 disables retry)
  retryBackoffMs: 1000,           // base backoff; doubles each retry (1s, 2s, 4s, 8s), capped below
  maxRetryBackoffMs: 15000,       // cap on any single backoff wait
});

function resolveConfig(config) {
  const c = config || {};
  const n = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  // Retries may legitimately be 0 (disable), so this clamp accepts non-negative integers rather
  // than requiring strictly-positive like `n` above.
  const nonNegInt = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
  const endpoint = typeof c.endpoint === 'string' && c.endpoint.trim() ? c.endpoint.trim() : FURNISH_DEFAULTS.endpoint;
  const pollIntervalMs = n(c.pollIntervalMs, FURNISH_DEFAULTS.pollIntervalMs);
  const timeoutMs = n(c.timeoutMs, FURNISH_DEFAULTS.timeoutMs);
  return {
    endpoint: endpoint.replace(/\/+$/, ''),   // no trailing slash, so `${endpoint}/${jobId}` is clean
    pollIntervalMs,
    timeoutMs,
    maxImageBytes: n(c.maxImageBytes, FURNISH_DEFAULTS.maxImageBytes),
    acceptedTypes: Array.isArray(c.acceptedTypes) && c.acceptedTypes.length ? c.acceptedTypes.slice() : [...FURNISH_DEFAULTS.acceptedTypes],
    // Hard poll cap: a belt-and-suspenders bound so termination never depends SOLELY on the
    // injected clock being monotonic (a frozen/non-advancing `now` would otherwise let a
    // perpetual-PENDING proxy spin forever). Defaults just above the time-based budget.
    maxPolls: n(c.maxPolls, Math.ceil(timeoutMs / pollIntervalMs) + 10),
    maxPollRetries: nonNegInt(c.maxPollRetries, FURNISH_DEFAULTS.maxPollRetries),
    retryBackoffMs: n(c.retryBackoffMs, FURNISH_DEFAULTS.retryBackoffMs),
    maxRetryBackoffMs: n(c.maxRetryBackoffMs, FURNISH_DEFAULTS.maxRetryBackoffMs),
  };
}

// ---- typed error -----------------------------------------------------------

// Every failure path throws a FurnishError with a machine-readable `.code`, so the UI can
// branch (retry vs. re-pick image vs. report) without string-matching messages.
export class FurnishError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'FurnishError';
    this.code = code;             // see ERROR_CODES
    this.details = details;
  }
}

export const ERROR_CODES = Object.freeze({
  INVALID_IMAGE: 'invalid-image',
  NO_TRANSPORT: 'no-transport',
  SUBMIT_FAILED: 'submit-failed',
  BAD_RESPONSE: 'bad-response',
  JOB_FAILED: 'job-failed',
  JOB_EXPIRED: 'job-expired',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
});

// ---- image input validation ------------------------------------------------

// Accept either a bare data URL string (`data:image/png;base64,....`) or an object
// `{ dataUrl }` / `{ base64, mimeType }`. Returns a normalized
// `{ mimeType, base64, byteLength }` on success. Throws FurnishError('invalid-image') with a
// precise reason otherwise — all BEFORE any network call, so a bad pick fails fast and local.
export function validateImageInput(image, config) {
  const { acceptedTypes, maxImageBytes } = resolveConfig(config);

  let mimeType = null, base64 = null;
  if (typeof image === 'string') {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(image.trim());
    if (!m) throw new FurnishError(ERROR_CODES.INVALID_IMAGE, 'expected a base64 data URL (data:<type>;base64,<data>)');
    mimeType = m[1].toLowerCase();
    base64 = m[2];
  } else if (image && typeof image === 'object') {
    if (typeof image.dataUrl === 'string') return validateImageInput(image.dataUrl, config);
    if (typeof image.base64 === 'string' && typeof image.mimeType === 'string') {
      mimeType = image.mimeType.toLowerCase();
      base64 = image.base64;
    }
  }
  if (!mimeType || base64 == null) {
    throw new FurnishError(ERROR_CODES.INVALID_IMAGE, 'no image data (pass a data URL or { base64, mimeType })');
  }

  const cleaned = base64.replace(/\s+/g, '');
  if (!cleaned) throw new FurnishError(ERROR_CODES.INVALID_IMAGE, 'image data is empty');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new FurnishError(ERROR_CODES.INVALID_IMAGE, 'image data is not valid base64');
  }
  // Canonical (padded) base64 is ALWAYS a multiple of 4 chars — which is exactly what a browser
  // data URL (FileReader / canvas.toDataURL / btoa) emits. A length that is not a multiple of 4
  // means the payload is truncated or otherwise malformed (e.g. a partial/interrupted read or a
  // clipboard paste cut short), even when every character is a legal base64 symbol. Reject it
  // here so the furnish job fails FAST and LOCAL with a clear reason, instead of forwarding a
  // corrupt payload to the proxy → provider and failing late after a network round-trip. It also
  // keeps the byteLength estimate below exact (that formula assumes well-formed 4-char groups).
  if (cleaned.length % 4 !== 0) {
    throw new FurnishError(ERROR_CODES.INVALID_IMAGE, 'image data is truncated or malformed base64 (length is not a multiple of 4)');
  }
  if (!acceptedTypes.map((t) => t.toLowerCase()).includes(mimeType)) {
    throw new FurnishError(ERROR_CODES.INVALID_IMAGE, `unsupported image type ${mimeType} (accepted: ${acceptedTypes.join(', ')})`, { mimeType });
  }
  // Decoded byte length from the base64 length (4 chars → 3 bytes, minus padding), no Buffer/atob.
  const byteLength = Math.floor(cleaned.length * 3 / 4) - (cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0);
  if (byteLength > maxImageBytes) {
    throw new FurnishError(ERROR_CODES.INVALID_IMAGE, `image is ${byteLength} bytes, over the ${maxImageBytes}-byte limit`, { byteLength, maxImageBytes });
  }
  return { mimeType, base64: cleaned, byteLength };
}

// ---- request construction (NO secrets) -------------------------------------

// Guard: a request this client builds must NEVER carry a provider credential — the proxy owns
// the key. Any Authorization / api-key header here would mean the key leaked into the browser.
const FORBIDDEN_HEADER = /^(authorization|x-api-key|api-key|x-meshy-key)$/i;

function assertNoSecretHeaders(headers) {
  for (const k of Object.keys(headers || {})) {
    if (FORBIDDEN_HEADER.test(k)) {
      throw new FurnishError(ERROR_CODES.SUBMIT_FAILED, `client request must not set a credential header (${k}); the key stays server-side`);
    }
  }
}

// Build the submit request to the proxy. Returns a plain, inspectable descriptor
// `{ url, method, headers, body }` (body is a JSON string) — the caller's transport does the
// actual POST. Validates the image first.
export function buildSubmitRequest(image, config) {
  const cfg = resolveConfig(config);
  const img = validateImageInput(image, cfg);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  assertNoSecretHeaders(headers);
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers,
    body: JSON.stringify({ image: `data:${img.mimeType};base64,${img.base64}` }),
  };
}

export function buildStatusRequest(jobId, config) {
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new FurnishError(ERROR_CODES.BAD_RESPONSE, 'cannot poll without a job id');
  }
  const cfg = resolveConfig(config);
  const headers = { accept: 'application/json' };
  assertNoSecretHeaders(headers);
  return { url: `${cfg.endpoint}/${encodeURIComponent(jobId.trim())}`, method: 'GET', headers };
}

// ---- response parsing ------------------------------------------------------

// Pull a job id out of the submit response. Accepts our normalized `{ jobId }` and the raw
// Meshy shape `{ result }` (its task id lands in `result`), or `{ id }`.
export function parseSubmitResponse(json) {
  const o = json && typeof json === 'object' ? json : {};
  const id = o.jobId || o.result || o.id || o.taskId || o.task_id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new FurnishError(ERROR_CODES.BAD_RESPONSE, 'submit response had no job id', { json });
  }
  return { jobId: id.trim() };
}

// Clamp a progress value (accepts 0..1 or 0..100) to a normalized 0..1 fraction.
function normalizeProgress(raw) {
  if (!Number.isFinite(raw)) return 0;
  const v = raw > 1 ? raw / 100 : raw;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Parse a status poll into a normalized snapshot. Tolerant of our proxy shape and raw Meshy:
//   glbUrl  ← glbUrl | model_urls.glb | modelUrls.glb
//   error   ← error | task_error.message | task_error (string)
//   name    ← name (optional; the UI falls back to a default)
export function parseStatusResponse(json) {
  const o = json && typeof json === 'object' ? json : {};
  const status = normalizeStatus(o.status);
  const modelUrls = o.model_urls || o.modelUrls || null;
  const glbUrl = (typeof o.glbUrl === 'string' && o.glbUrl)
    || (modelUrls && typeof modelUrls.glb === 'string' && modelUrls.glb)
    || null;
  let error = null;
  if (typeof o.error === 'string' && o.error) error = o.error;
  else if (o.task_error && typeof o.task_error === 'object' && typeof o.task_error.message === 'string') error = o.task_error.message;
  else if (typeof o.task_error === 'string' && o.task_error) error = o.task_error;
  return {
    status,
    progress: normalizeProgress(o.progress),
    glbUrl,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null,
    thumbnailUrl: (typeof o.thumbnailUrl === 'string' && o.thumbnailUrl) || (typeof o.thumbnail_url === 'string' && o.thumbnail_url) || null,
    error,
    isTerminal: TERMINAL.has(status),
  };
}

// ---- transport helpers -----------------------------------------------------

// Classify an HTTP status as a transient failure worth retrying. A 429 (rate limited) or any
// 5xx (server/proxy/gateway) is a retry candidate; a missing status (a null/odd transport
// result) is treated as transient too, since it looks like a network-level anomaly rather than
// a deliberate rejection. Everything else — notably 4xx — is permanent (retrying just re-fails).
function isTransientStatus(status) {
  if (!Number.isFinite(status)) return true;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

// A transport is a fetch-like `(request) => Promise<{ ok, status, json() }>`. We require it to
// be injected (never reach for a global `fetch`) so the module is pure and CI-deterministic.
// Failures are tagged `.transient` so a caller can decide whether retrying is worthwhile (see
// `sendStatusWithRetry`); a thrown transport call and a 429/5xx are transient, a 4xx is not.
async function send(transport, request, codeOnThrow) {
  if (typeof transport !== 'function') {
    throw new FurnishError(ERROR_CODES.NO_TRANSPORT, 'a transport function must be provided (fetch is injected, never global)');
  }
  let res;
  try {
    res = await transport(request);
  } catch (e) {
    const err = new FurnishError(codeOnThrow, `transport error: ${e && e.message ? e.message : e}`, { cause: String(e) });
    err.transient = true;   // a thrown transport call is a network-level blip → safe to retry
    throw err;
  }
  if (!res || res.ok === false) {
    const status = res && res.status;
    const err = new FurnishError(codeOnThrow, `request failed${status ? ` (HTTP ${status})` : ''}`, { status });
    err.transient = isTransientStatus(status);   // 429/5xx/no-status → retry; 4xx → permanent
    throw err;
  }
  let body;
  try {
    body = typeof res.json === 'function' ? await res.json() : res.body;
  } catch (e) {
    // A 200 whose body does not parse as JSON is a contract violation, not a transient network
    // blip — retrying would just re-fail. Fail fast with BAD_RESPONSE (and leave it untagged, so
    // it is never retried). Preserves the existing "non-JSON status body → bad-response" behavior.
    throw new FurnishError(ERROR_CODES.BAD_RESPONSE, `response was not JSON: ${e && e.message ? e.message : e}`);
  }
  return body;
}

// Poll the job status once, retrying ONLY transient failures (a thrown transport call, HTTP 429,
// or HTTP 5xx) with exponential backoff. This is what keeps a single network blip from killing a
// multi-minute generation. A permanent failure (HTTP 4xx, a non-JSON body) is re-thrown at once.
// Abort and the overall time budget are honored between attempts, so the loop always terminates:
// a backoff that would push past `timeoutMs` ends the job with TIMEOUT instead of waiting.
async function sendStatusWithRetry(transport, request, cfg, ctx) {
  const { sleep, now, signal, started } = ctx;
  let attempt = 0;   // number of retries already performed
  for (;;) {
    checkAborted(signal);
    try {
      return await send(transport, request, ERROR_CODES.BAD_RESPONSE);
    } catch (e) {
      const transient = e instanceof FurnishError && e.transient === true;
      if (!transient || attempt >= cfg.maxPollRetries) {
        if (transient && e instanceof FurnishError) {
          e.details = { ...(e.details || null), transient: true, attempts: attempt + 1 };
        }
        throw e;   // permanent, or retries exhausted
      }
      attempt++;
      // Exponential backoff (base × 2^(attempt-1)), capped. Never wait past the time budget.
      const backoff = Math.min(cfg.retryBackoffMs * 2 ** (attempt - 1), cfg.maxRetryBackoffMs);
      if (now() - started + backoff > cfg.timeoutMs) {
        throw new FurnishError(ERROR_CODES.TIMEOUT, `job did not finish within ${cfg.timeoutMs}ms (transient poll failures)`, { attempts: attempt });
      }
      checkAborted(signal);
      await sleep(backoff);
    }
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkAborted(signal) {
  if (signal && signal.aborted) throw new FurnishError(ERROR_CODES.ABORTED, 'furnish job was cancelled');
}

// ---- orchestrator ----------------------------------------------------------

// Run the whole image→GLB job: submit, then poll until a terminal status, honoring a timeout
// and an optional cancellation signal. All side effects are injected:
//   opts.transport  (required)  fetch-like `(req) => Promise<{ok,status,json()}>`
//   opts.sleep      (optional)  `(ms) => Promise`  — tests pass an instant sleep
//   opts.now        (optional)  `() => epochMs`    — tests pass a fake clock
//   opts.onProgress (optional)  `(snapshot) => void` — per-poll progress callback
//   opts.signal     (optional)  `{ aborted }`      — cancellation
//   opts.config     (optional)  endpoint/intervals/limits/retries (see FURNISH_DEFAULTS)
// Resolves to `{ jobId, name, src, thumbnailUrl, polls }` on success; throws FurnishError
// (code in ERROR_CODES) on any failure. `src` is the GLB url ready for the furniture model.
// The SUBMIT call is single-shot (a submit failure is immediate and the user simply re-triggers);
// each STATUS poll tolerates transient failures via `sendStatusWithRetry`, since a long job is
// exposed to many polls and one blip must not discard an in-flight generation.
export async function runFurnishJob(image, opts = {}) {
  const { transport, onProgress, signal } = opts;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const cfg = resolveConfig(opts.config);

  checkAborted(signal);

  // 1) submit
  const submitReq = buildSubmitRequest(image, cfg);
  const submitBody = await send(transport, submitReq, ERROR_CODES.SUBMIT_FAILED);
  const { jobId } = parseSubmitResponse(submitBody);

  // 2) poll to a terminal state
  const started = now();
  let polls = 0;
  for (;;) {
    checkAborted(signal);
    const statusReq = buildStatusRequest(jobId, cfg);
    const snap = parseStatusResponse(await sendStatusWithRetry(transport, statusReq, cfg, { sleep, now, signal, started }));
    polls++;
    if (typeof onProgress === 'function') {
      try { onProgress({ ...snap, jobId, polls }); } catch { /* a UI callback must never break the job */ }
    }

    if (snap.status === JobStatus.SUCCEEDED) {
      if (!snap.glbUrl) throw new FurnishError(ERROR_CODES.BAD_RESPONSE, 'job succeeded but returned no GLB url', { jobId });
      return { jobId, name: snap.name || 'Furniture', src: snap.glbUrl, thumbnailUrl: snap.thumbnailUrl, polls };
    }
    if (snap.status === JobStatus.FAILED) {
      throw new FurnishError(ERROR_CODES.JOB_FAILED, snap.error || 'the generation job failed', { jobId });
    }
    if (snap.status === JobStatus.EXPIRED) {
      throw new FurnishError(ERROR_CODES.JOB_EXPIRED, 'the generation job expired before a model was retrieved', { jobId });
    }

    // not terminal — enforce the timeout against the NEXT poll, then wait. Either the
    // time budget OR the hard poll cap ends the loop, so it always terminates.
    if (polls >= cfg.maxPolls || now() - started + cfg.pollIntervalMs > cfg.timeoutMs) {
      throw new FurnishError(ERROR_CODES.TIMEOUT, `job did not finish within ${cfg.timeoutMs}ms`, { jobId, polls });
    }
    await sleep(cfg.pollIntervalMs);
  }
}

// ---- model bridge ----------------------------------------------------------

// Turn a successful `runFurnishJob` result into a Phase-1 furniture record via the existing
// `createFurniture` (the model stays the single source of truth; no new save field — the GLB
// lands in the `src` the furniture model already carries). `opts` is forwarded to
// createFurniture (levelId, position, rotationY, scale, id, name override).
export function toFurniture(result, opts = {}) {
  if (!result || typeof result.src !== 'string' || !result.src) {
    throw new FurnishError(ERROR_CODES.BAD_RESPONSE, 'cannot build furniture without a GLB src');
  }
  return createFurniture(result.src, { name: result.name || 'Furniture', ...opts });
}
