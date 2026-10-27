// Cloudflare Pages Function — POST /api/furnish  (submit an image→3D job).
//
// Thin wrapper ONLY: it binds the Cloudflare runtime's real `fetch` and `env` (which holds the
// server-side MESHY_API_KEY binding) to the pure, unit-tested handler in ../_lib/furnishProxy.js.
// All decision logic — key handling, provider request construction, response normalization, error
// mapping — lives there and is proven in src/test/furnish-proxy.test.mjs. Keep this file logic-free.
//
// Deploy note: this endpoint goes live when `main` deploys to Cloudflare Pages. Until the
// MESHY_API_KEY binding is set (Pages → Settings → Environment variables, or local `.dev.vars`),
// it returns 503 "not configured" and never calls the provider. The secret key is never in code.

import { handleFurnish } from '../_lib/furnishProxy.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function onRequestPost(context) {
  const { request, env } = context;
  let body = {};
  try {
    body = await request.json();
  } catch {
    // A missing / non-JSON body is handled downstream as a missing image (400).
    body = {};
  }
  const { status, json: payload } = await handleFurnish({ method: 'POST', body, env, fetchImpl: fetch });
  return json(status, payload);
}

// Any other verb on the collection endpoint is not allowed (status lives at /api/furnish/:jobId).
export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json(405, { error: 'method not allowed' });
}
