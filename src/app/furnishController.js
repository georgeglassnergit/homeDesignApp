// app/furnishController.js — Phase-4 application glue for the `furnish-photo-3d` seam.
//
// This is the integration layer BETWEEN the pure pipeline core (core/furnishPipeline.js:
// runFurnishJob → toFurniture) and the editable model (edit/commands.js: addFurniture via
// the History). It is the single entry point the furnish UI calls: hand it a photo and the
// current History, and it runs submit→poll→(verify)→commit, so a generated model lands in the
// project as an UNDOABLE furniture record.
//
// Everything with a side effect is INJECTED — the network transport, the optional GLB-load
// verifier, the clock, the sleep, the cancellation signal — so this module is pure, has NO
// Three.js and NO DOM at import time, and is fully deterministic in CI (running under plain
// Node is itself the model/view separation guard). The view layer binds the real same-origin
// proxy transport and the real GLB loader later; nothing here reaches for a global.
//
// Why a VERIFY step: validateProject (model.js) can only check that a furniture record's `src`
// is a non-empty string — it cannot know the GLB at that url actually loads. A model that the
// service reports as SUCCEEDED but that fails to load (a 404, a corrupt/non-GLB body) would
// otherwise commit as a phantom record that then fails silently in the scene. If the caller
// injects `loadGlb`, we attempt the load BEFORE committing and treat a load failure as a bad
// response — so a phantom never enters the undo history.

import { runFurnishJob, toFurniture, FurnishError, ERROR_CODES } from '../core/furnishPipeline.js';
import { addFurniture } from '../edit/commands.js';

// The phases a furnish run moves through, for UI binding via `onPhase`.
export const FurnishPhase = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',       // submit + poll the generation job
  VERIFYING: 'verifying',   // loading the returned GLB to confirm it's real (only if loadGlb given)
  COMMITTED: 'committed',   // the furniture record is in the project + undo history
  ERROR: 'error',
});

// Novice-first, user-facing messages keyed by the pipeline's ERROR_CODES. The product is
// novice-first (Simple/Pro seam), so the UI shows these rather than the raw engine message.
const USER_MESSAGES = Object.freeze({
  [ERROR_CODES.INVALID_IMAGE]: 'That image can’t be used — pick a clear JPG or PNG photo.',
  [ERROR_CODES.NO_TRANSPORT]:  'The furnish service isn’t available right now.',
  [ERROR_CODES.SUBMIT_FAILED]: 'Couldn’t start the 3D generation. Check your connection and try again.',
  [ERROR_CODES.BAD_RESPONSE]:  'The 3D service returned something unexpected. Please try again.',
  [ERROR_CODES.JOB_FAILED]:    'A 3D model couldn’t be generated from that photo. Try a clearer shot or a different angle.',
  [ERROR_CODES.JOB_EXPIRED]:   'The 3D generation expired before it finished. Please try again.',
  [ERROR_CODES.TIMEOUT]:       'The 3D generation is taking too long. Please try again.',
  [ERROR_CODES.ABORTED]:       'Furnishing was cancelled.',
});
const GLB_LOAD_FAILED_MESSAGE = 'The 3D model came back but couldn’t be loaded. Please try again.';
const FALLBACK_MESSAGE = 'Something went wrong while furnishing from the photo.';

// Map any error to a friendly, user-facing string. A FurnishError with a known code maps to its
// message; anything else (including a plain Error or null) falls back to a generic message. If
// the error already carries a `.userMessage` (e.g. the GLB-load failure below), that wins.
export function messageForError(err) {
  if (err && typeof err.userMessage === 'string' && err.userMessage) return err.userMessage;
  if (err && Object.prototype.hasOwnProperty.call(USER_MESSAGES, err.code)) return USER_MESSAGES[err.code];
  return FALLBACK_MESSAGE;
}

// A cancellation check that matches the pipeline's ABORTED semantics (the pipeline guards
// submit/poll; this guards the gap between a successful job and the verify/commit step).
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new FurnishError(ERROR_CODES.ABORTED, 'furnishing was cancelled');
}

// Furnish a project from a photo and commit the result as an undoable furniture record.
//
//   image           a base64 data URL string, or { dataUrl } / { base64, mimeType }
//   opts.history    (required) a History — the result is committed via history.execute(addFurniture(..))
//   opts.transport  (required) fetch-like `(req) => Promise<{ok,status,json()}>` (forwarded to runFurnishJob)
//   opts.loadGlb    (optional) `async (src) => any` — verify the GLB loads before committing; a
//                              throw means "model came back but can't be loaded" → nothing is committed
//   opts.levelId / position / rotationY / scale / name / id   (optional) forwarded to toFurniture
//   opts.onPhase    (optional) `(phase, detail) => void` — UI state binding (never breaks the flow)
//   opts.onProgress (optional) forwarded to runFurnishJob (per-poll snapshot)
//   opts.signal / sleep / now / config   (optional) forwarded to runFurnishJob
//
// Resolves to `{ furniture, command, jobId, polls }` on success. On any failure it sets the
// ERROR phase, attaches a `.userMessage` to the error, and rethrows (so the UI can `try/catch`
// and show `err.userMessage`, or bind through `onPhase`). Nothing is committed on failure.
export async function furnishFromImage(image, opts = {}) {
  const { history } = opts;
  if (!history || typeof history.execute !== 'function') {
    // Programmer error (wiring bug), not a user-facing furnish failure — surface it plainly.
    throw new TypeError('furnishFromImage: opts.history (a History instance) is required');
  }
  const emit = (phase, detail) => {
    if (typeof opts.onPhase !== 'function') return;
    try { opts.onPhase(phase, detail); } catch { /* a UI callback must never break the flow */ }
  };

  try {
    // 1) submit + poll to a terminal state. The pure pipeline validates the image first, talks
    //    only to the injected transport (the same-origin proxy — the provider key stays server-
    //    side), and tolerates transient poll blips. A bad image/job/timeout throws here.
    emit(FurnishPhase.RUNNING, null);
    const result = await runFurnishJob(image, {
      transport: opts.transport,
      onProgress: opts.onProgress,
      signal: opts.signal,
      sleep: opts.sleep,
      now: opts.now,
      config: opts.config,
    });

    // 2) optional verify — load the GLB before committing so a model that can't be loaded never
    //    becomes a phantom record. Honor a cancel requested during the job, before verifying.
    if (typeof opts.loadGlb === 'function') {
      throwIfAborted(opts.signal);
      emit(FurnishPhase.VERIFYING, { src: result.src });
      try {
        await opts.loadGlb(result.src);
      } catch (loadErr) {
        const e = new FurnishError(
          ERROR_CODES.BAD_RESPONSE,
          'the generated model could not be loaded',
          { stage: 'glb-load', cause: loadErr && loadErr.message ? loadErr.message : String(loadErr) },
        );
        e.userMessage = GLB_LOAD_FAILED_MESSAGE;
        throw e;
      }
    }

    // 3) bridge to a Phase-1 furniture record and commit it through the undo history. toFurniture
    //    reuses createFurniture — no new save field; the GLB lands in the existing `src`.
    //    `name` is added only when the caller supplied one: toFurniture pre-sets name from the
    //    job result and then spreads these opts over it, so a forwarded `name: undefined` would
    //    clobber the service's name back to the generic default. Omitting it keeps result.name.
    const furnitureOpts = {
      levelId: opts.levelId,
      position: opts.position,
      rotationY: opts.rotationY,
      scale: opts.scale,
      id: opts.id,
    };
    if (opts.name !== undefined) furnitureOpts.name = opts.name;
    const furniture = toFurniture(result, furnitureOpts);
    const command = addFurniture(furniture);
    history.execute(command);

    emit(FurnishPhase.COMMITTED, { furniture, jobId: result.jobId, polls: result.polls });
    return { furniture, command, jobId: result.jobId, polls: result.polls };
  } catch (err) {
    const userMessage = messageForError(err);
    if (err && typeof err === 'object' && !err.userMessage) {
      try { err.userMessage = userMessage; } catch { /* a frozen/exotic error — the message still rides onPhase */ }
    }
    emit(FurnishPhase.ERROR, { error: err, code: err && err.code, message: userMessage });
    throw err;
  }
}
