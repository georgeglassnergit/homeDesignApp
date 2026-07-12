# DEV-LOG

*Append-only, newest entry on top. The autonomous daily run writes here each morning.*

---

## 2026-07-12 — S1 interaction foundation landed in the runnable `src/` app
- **Picked:** Integrate the engine-independent Phase 2 S1 core (commands + history + starters) into the runnable `src/` tree, reconciled onto the *authoritative* `src/core/model.js`. This is the foundation S2–S6 build on, and the one slice fully verifiable in this sandbox (no Three.js needed). The `phase2/` copy targeted its own divergent model API (`makeWall`/`findLevel`/center-offset openings); none of it was wired into `src/`.
- **Changed:**
  - `src/core/model.js` — added pure lookups `findLevel` / `findWall` / `findOpening` (additive; no change to existing factories, validation, or the save format).
  - `src/edit/commands.js` (NEW) — `addWall`, `moveWallVertex`, `removeWall` (cascades to its openings), `addOpening`, `removeOpening`, `loadTemplate`. Each is a `do()`/`undo()` on the plain `Project`. Zero Three.js.
  - `src/edit/history.js` (NEW) — model-level undo/redo stack with a size limit.
  - `src/templates/starters.js` (NEW) — `blank` / `studio` / two-room (`sampleHome`) as pure data, using src's `createWall`/`createOpening` **near-edge offset** convention (reconciled from phase2's center-offset).
  - `src/app/state.js` — `createAppState` gains `activeTool` / `view` / `camera` + setters and `TOOL`/`VIEW`/`CAMERA` enums (additive; existing `FEATURE_TIERS`/`isAvailable`/`availableTools` untouched).
  - `package.json` — `npm run test:edit`.
- **Verified (engine-independent, per the run rules):** `node src/test/edit-core.test.mjs` → **ALL PASS — 46 passed, 0 failed**. Covers: sample-home validate + counts; **lossless serialize round-trip survives every edit** (byte-identical); draw-a-room via commands; vertex move + undo/redo; opening near-edge fit detection; `removeWall`/`removeOpening` cascade + lossless undo; full undo-all byte-identical; redo-stack clear on new command; history limit trimming; `loadTemplate` in-place swap + undo; all starters validate; command error paths throw on bad ids. Regression guard: `phase2/test/phase2-core.test.mjs` still **33/33**. Model/view separation confirmed — no `three` import in `core/`, `edit/`, `templates/`, `app/`.
- **Not touched (no regression):** render path (`sceneBuilder`, `viewer`, `main.js`, `furniture`, CSG) is unchanged; the new edit layer is not yet wired into `main.js`.
- **Next:** S2/S3 **view layer** — wire `src/edit/` into `main.js` behind a plan-view interaction surface (`picking.js`, `tools.js`, `planView.js`) so drawing walls / placing openings drives these commands and rebuilds the scene. Requires the Three.js headless harness (clone three.js + three-bvh-csg + three-mesh-bvh, Playwright/swiftshader) to verify per the Phase 0/1 method.

## 2026-07-10 — setup — repo assembled for autonomous daily dev
- Did: assembled the push-ready repo (Phase 1 runnable app + Account A's Phase 2 core, 33/33 core tests passing) and authored the autonomous daily-run prompt (`automation/daily-dev-run.md`) + setup guide.
- State: ready to push to GitHub and schedule at 5am ET (see `automation/SETUP.md`).
- Next: first autonomous run advances Phase 2 (next unbuilt slice per `docs/PHASE-2-PLAN.md`).
