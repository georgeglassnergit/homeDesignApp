# `functions/` — Cloudflare Pages Functions (the same-origin API)

These run server-side on Cloudflare Pages alongside the static Vite build (`dist/`). The static
site is untouched by this directory; Pages serves `dist/` for the app and routes `/api/*` here.

## Why it exists

The client furnish pipeline (`src/core/furnishPipeline.js`) **never holds the provider API key** —
it calls only this app's own origin (`/api/furnish`) and refuses to attach any credential header.
The key lives here, server-side. This directory is that server half.

## Endpoints

| Route | File | Purpose |
|---|---|---|
| `POST /api/furnish` | `api/furnish.js` | Submit an image → start a Meshy image→3D job → `{ jobId }` |
| `GET /api/furnish/:jobId` | `api/furnish/[jobId].js` | Poll job status → `{ status, progress, glbUrl, name?, thumbnailUrl?, error? }` |

Both wrappers are **logic-free**: they bind the runtime's `fetch` + `env` to the pure handler in
`_lib/furnishProxy.js`, which is where all decision logic lives and is unit-tested
(`src/test/furnish-proxy.test.mjs`, plain Node, synthetic transport — **never a live API call**).
Files under `_lib/` begin with `_`, so Pages does not route them as endpoints.

## Configuration (the secret stays server-side)

Set **`MESHY_API_KEY`** as a Cloudflare Pages environment variable (Pages → Settings →
Environment variables). For local `wrangler pages dev`, copy `.dev.vars.example` → `.dev.vars`
(git-ignored) and fill it in.

**Until the key is set, `/api/furnish` returns `503 { "error": "furnish service is not
configured" }` and never calls the provider.** The key is never written into code, a response
body, or a log line. Do not commit `.dev.vars` or paste the key anywhere in the repo.
