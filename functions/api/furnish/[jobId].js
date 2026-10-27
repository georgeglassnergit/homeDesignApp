// Cloudflare Pages Function — GET /api/furnish/:jobId  (poll an image→3D job's status).
//
// Thin wrapper ONLY: binds the runtime's real `fetch` and `env` (holding MESHY_API_KEY) to the
// pure handler in ../../_lib/furnishProxy.js. The dynamic segment `[jobId]` is the task id the
// submit response returned. All logic lives in the handler and is proven in
// src/test/furnish-proxy.test.mjs. Keep this file logic-free. See functions/api/furnish.js for
// the deploy / "not configured" note.

import { handleFurnish } from '../../_lib/furnishProxy.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function onRequestGet(context) {
  const { env, params } = context;
  const jobId = params && params.jobId;
  const { status, json: payload } = await handleFurnish({ method: 'GET', jobId, env, fetchImpl: fetch });
  return json(status, payload);
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return json(405, { error: 'method not allowed' });
}
