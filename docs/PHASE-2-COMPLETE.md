# Phase 2 — Interactive skeleton: COMPLETE

**Verdict: DONE.** Every "definition of done" item in [`PHASE-2-PLAN.md`](./PHASE-2-PLAN.md) is landed, and every Simple/Pro tier-table row is live. The whole-home model is now editable by direct manipulation — template → draw walls → cut openings → exterior/cutaway → walk-through — with every action a command that mutates the plain `Project` model, then re-derives the scene. The Phase 1 lossless save round-trip survives every edit.

This is the sign-off that closes Phase 2, in the shape of the Phase 0 GO/NO-GO doc. It consolidates verification that was proven slice-by-slice (each in its own daily run, logged in [`DEV-LOG.md`](../DEV-LOG.md)) and re-confirmed by the current regression pass.

## Definition of done — all met

| Plan item | Slice | Status | Headless proof |
|---|---|---|---|
| Start from a **template picker** or blank; scene builds from pure model data | S4 | ✅ | `phase2-s4-picker.png`, `phase2-s4-studio.png` |
| **Draw walls** by clicking in plan view; **edit** by dragging endpoints; persist to `Levels[].Walls[]` | S2 | ✅ | `phase2-s2s3.png` |
| **Place a door and a window** by clicking a wall; CSG-carved; persist to `Levels[].Openings[]` | S3 | ✅ | `phase2-s2s3.png` |
| **Exterior massing + flat roof** render, with an exterior ↔ interior/cutaway toggle | S5 | ✅ | `phase2-s5-exterior.png`, `phase2-s5-cutaway.png` |
| **Walk-through camera** (WASD + look) toggled against orbit | S6 | ✅ | `phase2-s6-walk.png`, `phase2-s6-orbit.png` |
| Every edit **undoable/redoable** and **round-trips losslessly** through `serialize`/`deserialize` | S1 | ✅ | asserted in every headless run + the core suite |
| Headless verification with **zero console errors** across the slice | all | ✅ | each slice's run: zero `pageerror` |

## Simple / Pro seam — every tier-table row live

The seam is no longer dormant. Each row registers once in `FEATURE_TIERS`; the UI reads `isAvailable(tool, mode)` — one gate, no scattered conditionals.

| Tool | Simple | Pro | Landed |
|---|---|---|---|
| Select / orbit · template picker · draw wall · door/window · exterior/cutaway · walk-through | ✅ | ✅ | S1–S6 |
| Exact dimension entry (length/thickness/sill) | — | ✅ | selection inspector (2026-07-17) |
| Per-opening custom size | — | ✅ | same inspector (2026-07-17) |
| Snapping / constraint settings (grid · corners · angle-lock) | — | ✅ | data-driven snapping (2026-07-18) |

## How it was verified

Two independent tiers, both re-run for this sign-off:

**Engine-independent core suite** — `node src/test/edit-core.test.mjs` → **189 passed, 0 failed**. Covers commands + history (do/undo/redo lossless), plan-view screen↔world math and hit-testing, the tool state machine, cutaway + walk math, the Pro-seam inspector and snapping, the dirty tracker and plan thumbnails — and, new this run, an automated **model/view-separation guard** (see below). Regression: `phase2/test/phase2-core.test.mjs` → **33 passed, 0 failed**.

**Three.js view layer, headless** — each slice was proven the Phase 0/1 way: vendor `three.js` + `three-bvh-csg` + `three-mesh-bvh` via `git clone` (npm/CDN are blocked in the build environment), wire an importmap harness, drive the *real* app via raw CDP on the pre-installed Chromium under swiftshader, assert **zero `pageerror`**, and screenshot. The Phase 1 regression (5 walls / 4 CSG openings / lossless round-trip / GLB furniture in the scene) held on every run. Screenshots live in [`docs/verification/`](./verification/).

## Model/view separation is now automated

Phase 0/1 made model/view separation *sacred*: `core/` (data + rules), `templates/` (pure starters), `app/` (state, no render), and the interaction logic in `edit/` (except the raycaster `picking.js`) plus the pure viewer math (`cutaway.js`, `walk.js`) must never import the Three.js engine. Only the render/build/pick layer may — a set of seven files:

```
build/furniture.js  build/geometry.js  build/materials.js  build/sceneBuilder.js
viewer/viewer.js    viewer/walkCamera.js    edit/picking.js
```

Until now this was hand-checked every run by *loading* the pure modules under Node (they'd throw on the absent `three`). That misses a leak hidden behind an untaken branch. The core suite now scans the whole `src/` tree statically and fails if any file outside the allowlist imports `three` / `three-bvh-csg` / `three-mesh-bvh` — and fails if the allowlist itself goes stale. The invariant the DEV-LOG asserted by hand is now a test.

## Known caveats carried forward

- **CSG needs watertight, two-manifold input** (the Phase 0 caveat). Wall/opening primitives stay clean boxes and corner-snap closes drawn rooms watertight; the validation guard runs before every boolean. This tightens as walls gain complexity (angled/merged) in later phases.
- **This is a design/visualization tool, not structural engineering or code certification.** Defaults are approachable and approximate real-world; nothing here is presented as code-compliant or engineer-certified.

## Recommendation

Proceed to **Phase 3 — depth behind the existing seam**: multi-level editing UI, roof types beyond flat, and the import-a-plan / outsource-drawing onboarding tiles (currently shown "coming soon"). No blockers; the Phase 2 skeleton is a correct foundation to build depth on.
