# Phase 2 — S1 core (engine-independent, verified)

This is the **engine-independent half of Phase 2 slice S1** (interaction foundation), implemented and unit-tested with plain Node — no Three.js, no network, no browser. It is the part of Phase 2 that the current automation sandbox can actually run and verify.

## What's here (verified)

```
src/core/model.js       whole-home model + DEFAULTS + validateProject + serialize/deserialize
src/core/units.js       metric/imperial parse + format (storage stays metric)
src/app/state.js        Simple/Pro seam (FEATURE_TIERS + isAvailable) + app state
src/edit/commands.js    addWall, moveWallVertex, removeWall, addOpening, removeOpening, loadTemplate
src/edit/history.js     model-level undo/redo stack
src/templates/          sampleHome + starters (blank / studio / two-room) as pure data
test/phase2-core.test.mjs   33 assertions
```

## Run the tests

```
cd platform/phase2-src
node test/phase2-core.test.mjs      # or: npm test
```

Expected: `ALL PASS — 33 passed, 0 failed`. Covers: sample home builds & validates; **lossless serialize round-trip**; units parse/format (incl. `10'6"`); the Simple/Pro seam; draw-a-room via commands; **vertex move + undo/redo**; **opening fit detection**; **removeWall cascades to its openings and undoes losslessly**; full undo-all returns byte-identical to the start; `loadTemplate` swaps + undoes; all starters validate.

## Design principle (carried from Phase 1)

**Model/view separation.** Every edit is a *command* that mutates the plain `Project` model with matching `do()`/`undo()`. Undo/redo is therefore model-level, the model stays the single source of truth, and scene rebuild is a pure function of the model. Nothing here imports Three.js.

## Relationship to the existing Phase 1 build

This targets the **documented Phase 1 model contract** (`platform/PHASE-1-ARCHITECTURE.md`). The authoritative Phase 1 source lives in `platform/home-studio-phase1.zip`. When integrating, the zip's `src/core/model.js` is authoritative — reconcile any naming differences there; the `edit/` command + history layer and the templates are the net-new Phase 2 contribution and are engine-independent.

## What's NOT here yet (needs the Phase 0/1 environment)

The Three.js view/interaction layer — `edit/picking.js`, `edit/tools.js`, `edit/planView.js`, and the `viewer` walk-camera + view-mode toggle, plus CSG rendering of openings via `three-bvh-csg`. These are specified in **`VIEW-LAYER-CONTRACT.md`** with signature stubs, but cannot be installed or run in this sandbox (npm/CDN blocked, no headless browser). Execute and verify them in the environment that ran Phase 0/1.
