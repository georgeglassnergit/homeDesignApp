# Headless view-layer verification harness

Proves a Three.js view-layer slice the Phase 0/1/2 way: boot the **real** app under a
no-build importmap (the same bare imports Vite resolves), drive it over CDP on the
pre-installed Playwright Chromium under swiftshader, assert **zero console/page errors** plus
the Phase 1 regression, and save a screenshot to `docs/verification/`.

npm and public CDNs are blocked in the daily-run environment — `git clone` through the proxy
is the only way to get dependencies. This harness is committed so no run has to re-derive it
(a prior run lost an entire session unable to launch Chromium — see the gotcha below).

## Run it (from the repo root)

```bash
bash automation/headless-verify/vendor-deps.sh              # clone+pin deps, gen files, build verify.html
node automation/headless-verify/verify.mjs <name> --probe probes/<slice>.mjs
```

`verify.mjs` always checks the invariants (zero errors + Phase 1 regression: 5 walls / 4 CSG
openings / rooms / GLB furniture / lossless save). The `--probe` module adds slice-specific
assertions. Screenshot lands at `docs/verification/<name>.png`. Exit code is 0 iff every check
passes.

Example (the A2 room-hover slice this harness was first proven on):
```bash
node automation/headless-verify/verify.mjs phase3-room-hover-plan --probe probes/a2-room-hover.mjs
```

## Writing a probe

`probes/<slice>.mjs` exports `async function run(page)` and returns
`{ checks: [[name, bool], ...], log?: {...} }`. `page` is the Playwright page with the app
booted and its `window.__*` handles installed (see the `Object.assign(window, {...})` block in
`src/main.js`). Keep probes view-only: assert new logic, and re-assert that view state issues
no command and never touches the save.

## Pinned versions (must match the app)

`package.json` pins `three ^0.169.0` + `three-bvh-csg ^0.0.17`. The compatible, proven combo:

| dep | tag | why |
|---|---|---|
| three | **r169** | app pin |
| three-bvh-csg | **v0.0.17** | app pin (HEAD 0.0.18 needs three ≥0.179) |
| three-mesh-bvh | **v0.7.6** | csg 0.0.17 peer (`>=0.6.6`); HEAD 0.9.x imports `three/webgpu` + `three/tsl` and breaks on r169 |

`three-mesh-bvh` ships `*.template.js` that its rollup build expands with the `preprocess` npm
package into `*.generated.js`. We can't run npm, so `gen-meshbvh-generated.mjs` replicates the
exact directives v0.7.6 uses (`@if INDIRECT` / `@else` / `@endif` / `@echo INDIRECT_STRING`) and
fails loudly if any macro survives.

## Gotchas (the expensive ones)

- **Launch over CDP (Playwright), never `chrome --screenshot ...` and never a bash-detached /
  `setsid` launch.** In this environment those get reaped instantly with no output — that's what
  cost a prior run its whole session. Playwright's CDP launch is reaped-proof here. Flags:
  `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox
  --disable-gpu-sandbox --disable-dev-shm-usage`. WebGL2 comes up green under swiftshader.
- **Serve `public/` at the root.** Vite does; a plain static server must fall back to
  `public/<path>` or the GLB furniture (`/sample.glb`) 404s and the scene loads without it.
- **Answer `/favicon.ico` with an empty 200**, or the browser's automatic probe 404s and trips
  the zero-errors gate (intermittently — depends on timing).
- The vendored dirs (`/three`, `/three-bvh-csg`, `/three-mesh-bvh`) and generated `verify.html`
  are `.gitignore`d — scaffold, cloned per run, never committed.
