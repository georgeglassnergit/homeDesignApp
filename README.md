# Home Design App (codename Roomclip)

A browser-based **whole-home interior & exterior design platform** — novice-first, with real editable 3D geometry underneath and a path to professional depth. The wedge: furnish a live 3D home with *any* real-world object via AI image-to-3D, on top of real buildable geometry (not just repainted photos, not a locked catalog).

Stack: **Three.js + three-bvh-csg**, strict **model/view separation** (the model is plain serializable data and *is* the save file), real-world meters, a **Simple/Pro** feature seam.

## Run the app
```
npm install       # three, three-bvh-csg, vite
npm run dev        # http://localhost:5173
npm run build      # dist/ (static; deploys to Cloudflare Pages)
```

## Layout
```
src/                 Phase 1 runnable app: model/view-separated whole-home builder
  core/              plain data model + units (no Three.js)
  build/             model → Three.js scene (walls, CSG openings, floors, roof, furniture)
  viewer/            renderer / camera / controls / framing
phase2/              Phase 2 core (Account A): commands+undo, tool state, Simple/Pro,
                     templates, tests (node test/phase2-core.test.mjs → 33/33), + view-layer contract
docs/                PHASE-0-GONOGO, PHASE-1-ARCHITECTURE, PHASE-2-PLAN, APP-README
automation/          daily-dev-run.md (the autonomous 5am dev-loop prompt) + SETUP.md
DEV-LOG.md           append-only log the daily run writes to (newest on top)
```

## Status
Phase 0 (GO) and Phase 1 (data model + lossless save) complete. Phase 2 (interactive skeleton) in progress: S1 command/undo core + S2 (draw & edit walls in plan view) + S3 (place door/window, CSG-carved) are landed in the runnable `src/` app and verified headlessly (`docs/verification/phase2-s2s3.png`). Remaining: S4 template-picker start screen, S5 exterior/cutaway toggle, S6 walk-through camera.

## Autonomous daily development
A scheduled run (see `automation/`) works this repo every morning: ~30 min review + landscape research to pick the highest-value revision, ~55 min implement + headless-verify, then it logs to `DEV-LOG.md`, pushes a dated branch, and opens a PR for review. Setup in `automation/SETUP.md`.

## Two-account coordination
Part of a project also tracked in a Box `_SYNC/` folder (shared memory + work log) read by a second Claude account. This GitHub repo is the authoritative home for platform code and the autonomous track.
