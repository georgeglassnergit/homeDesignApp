# Phase 2 — Broad end-to-end skeleton (build plan)

*Status: **proposed — awaiting sign-off**. This plan turns the verified Phase 1 data model into an *interactive* app: one thin but connected slice across the whole flow. Nothing here changes the Phase 1 model contract; it adds the editing layer on top of it.*

## Objective

Make the whole-home model editable by direct manipulation. A user should be able to open the app, pick a template (or start blank), draw and edit walls by clicking, drop in a door and a window, see the exterior massing with its flat roof, and walk through the result — with every one of those actions reading from and writing back to the **same `Project` model** from `src/core/model.js`.

This is deliberately a *skeleton*: one working path through each stage, not depth in any one. Depth (roof editor, code checks, IFC export, measurement, multi-level editing) stays in later phases behind the Pro seam.

## Definition of done

- Start a project from a **template picker** or blank, and the scene builds from pure model data.
- **Draw walls** by clicking in plan view; **edit** them by dragging endpoints; walls persist to `Levels[].Walls[]`.
- **Place a door and a window** by clicking a wall; they cut the wall via CSG and persist to `Levels[].Openings[]`.
- **Exterior massing + flat roof** render, with a toggle between exterior and interior/cutaway view.
- **Walk-through camera** toggles on and moves through the home (WASD + look), alongside the existing orbit camera.
- Every edit is **undoable/redoable** and **round-trips losslessly** through `serialize`/`deserialize`.
- Headless verification passes with **zero console errors** across the whole slice.

## Guiding constraints (carried from Phase 0/1)

1. **Model/view separation is sacred.** Interaction never mutates Three.js objects directly. Every user action produces a **command that mutates the plain `Project` model**, then the builder re-derives the affected scene objects. The save file stays engine-independent.
2. **Simple/Pro seam is the only gate.** Each new tool registers once in `FEATURE_TIERS`; the UI reads `isAvailable(tool, mode)`. No scattered conditionals.
3. **CSG inputs must stay watertight/two-manifold** (the Phase 0 caveat). Wall and opening solids remain clean boxes; add a validation guard before every boolean.
4. **Verify headless before saving.** Playwright on Chromium + WebGL with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`; assert no `pageerror`, screenshot, view it, then save.
5. **Build location.** The platform code ships as zips in `platform/`; the connected Box folder is not reachable from the Linux sandbox. Work in the sandbox against an unzipped copy, test there, then copy the updated build back into `platform/`.

## Architecture additions

Phase 2 introduces a thin **edit layer** between the app and the builder — the only new architectural surface. Everything under `core/` stays pure.

```
src/
  core/     model.js  units.js                 ← unchanged (pure data + rules)
  build/    sceneBuilder.js geometry.js
            materials.js furniture.js          ← unchanged; gains incremental rebuild helpers
  viewer/   viewer.js                          ← gains a walk camera + view-mode toggle
  edit/     ← NEW
    commands.js      ← command objects: add/move/remove wall, add/remove opening,
                       load template, set view — each is (apply, invert) on the model
    history.js       ← undo/redo stack of commands (model-level, not scene-level)
    picking.js       ← raycast → {modelId, kind} via mesh userData (from Phase 1)
    tools.js         ← tool state machine (select | drawWall | placeDoor | placeWindow)
    planView.js      ← 2D top-down interaction surface for wall drawing/editing
  app/      state.js                            ← gains active-tool + view-mode; FEATURE_TIERS grows
  templates/ sampleHome.js + starters.js        ← NEW starter projects (pure data)
  main.js                                       ← wires tools/history/picking into the UI
```

**Why a command layer instead of extending the existing undo?** Phase 1 already proved lossless serialize/deserialize. Modeling every edit as a command that `apply`/`invert`s on the plain model gives undo/redo *and* a clean audit path for free, and keeps the model as the single source of truth. Scene rebuild is a pure function of the model after each command.

## Feature slices

Each slice is independently testable and lands behind its own headless check.

### S1 — Interaction foundation (enables everything else)

- **What:** raycasting selection, the tool state machine, and the command/history stack.
- **Model interaction:** selection reads `userData.modelId`/`userData.kind` (already stamped in Phase 1). Commands mutate `Project`; the builder rebuilds affected objects.
- **Build:** `picking.js` (raycaster against built meshes), `tools.js` (current tool + pointer handlers), `commands.js` + `history.js` (apply/invert, redo). Selecting an object highlights it and shows a minimal inspector.
- **Acceptance:** click selects the right model object; a no-op command pushes/pops on the stack; rebuild after a command produces the same object count Phase 1 verified.

### S2 — Draw & edit walls

- **What:** click-to-place wall centerlines in plan view; drag endpoints to edit; delete a wall.
- **Model:** appends/edits `Levels[].Walls[] { a{x,z}, b{x,z}, thickness, height, material }` using `DEFAULTS` (12 cm, 2.7 m). Simple mode uses grid snapping; **Pro** exposes exact length/thickness entry via `units.js` parsing (`10'6"` or `3.2m`).
- **Build:** `planView.js` top-down surface; wall-draw tool emits `AddWall`/`MoveWallVertex`/`RemoveWall` commands; `validateProject()` rejects zero-length/degenerate walls before commit.
- **Acceptance:** draw a 4-wall room in plan view → 4 walls in the model → 3D rebuild shows them; drag a corner → both adjoining walls update; save/load round-trip identical.

### S3 — Place openings (door + window)

- **What:** with the door or window tool active, click a wall to drop an opening at the clicked offset.
- **Model:** appends `Openings[] { wallId, kind, offset, width, height, sill }` with door/window `DEFAULTS`; `validateProject()` enforces the opening fits within its wall.
- **Build:** reuse the Phase 0 `three-bvh-csg` subtraction to carve the opening (guard: watertight input check). `AddOpening`/`RemoveOpening` commands.
- **Acceptance:** click a wall → one door + one window carved (wall triangle count rises, matching the Phase 0 spike behavior); opening that doesn't fit is rejected with a message; round-trip identical.

### S4 — Template picker

- **What:** a start screen offering blank / starter templates; picking one instantiates a full starter `Project`.
- **Model:** `templates/starters.js` returns pure-data projects (reuse `sampleHome`, add 1–2 more, e.g. studio + two-bed). `LoadTemplate` command swaps the project (with a confirm if unsaved).
- **Build:** picker UI in `main.js`; on select, deserialize the starter, rebuild, and reframe the camera (Phase 1 framing).
- **Acceptance:** each template loads, validates, builds without error, and reframes; matches RoomSketcher's "blank / template / import / outsource" onboarding pattern (import/outsource deferred).

### S5 — Exterior massing + flat roof

- **What:** render the building shell from the outside plus the already-modeled flat roof; toggle exterior ↔ interior/cutaway.
- **Model:** derives massing from existing `Walls`/`Levels`/`roof` — **no new model fields**; the flat roof (`roof { type:flat, thickness, overhang }`) already exists in Phase 1.
- **Build:** view-mode in `viewer.js` (exterior = full shell; cutaway = hide roof + far walls, as in the Phase 1 `phase1-interior.png` verification). `SetView` command so view state is undoable/persisted as a display pref.
- **Acceptance:** exterior view shows a closed massing with roof; cutaway reveals the interior; toggling doesn't mutate geometry (object count stable).

### S6 — Walk-through camera

- **What:** a first-person walk camera (WASD move, pointer/drag look) toggled against the orbit camera.
- **Model:** none — camera is pure view state.
- **Build:** walk controller in `viewer.js` at eye height (~1.6 m), clamped to the level; toggle in the toolbar; Esc returns to orbit.
- **Acceptance:** enter walk mode, traverse the sample home through a doorway, exit to orbit; no console errors; framerate acceptable on swiftshader headless.

## Simple / Pro exposure (FEATURE_TIERS additions)

| Tool | Simple | Pro |
|---|---|---|
| Select / orbit | ✅ | ✅ |
| Template picker | ✅ | ✅ |
| Draw wall (grid-snapped) | ✅ | ✅ |
| Place door / window (default sizes) | ✅ | ✅ |
| Exterior/cutaway toggle | ✅ | ✅ |
| Walk-through | ✅ | ✅ |
| Exact dimension entry (length/thickness/sill) | — | ✅ |
| Per-opening custom size | — | ✅ |
| Snapping/constraint settings | — | ✅ |

## Testing & verification plan

- **Per slice:** a headless Playwright script loads the build, drives the tool programmatically (synthetic pointer events / direct command calls), asserts the expected model state, rebuilds, screenshots, and checks **zero `pageerror`**.
- **Model invariants after every command:** `validateProject()` passes and `serialize→deserialize→serialize` is byte-identical (the Phase 1 guarantee must survive editing).
- **Regression:** re-run the Phase 1 two-room sample checks (object counts, 4 CSG openings, lossless round-trip) after the edit layer lands.
- **Visual proof:** exterior + cutaway + a walk-through frame captured like `phase1.png`/`phase1-interior.png`.

## Sequencing & checkpoints

1. **S1** interaction foundation (blocks all others) → checkpoint: selection + undo working.
2. **S2** walls → **S3** openings (openings depend on walls) → checkpoint: draw a room and cut a door/window.
3. **S4** templates (independent; can slot in after S1) → checkpoint: one-click starter home.
4. **S5** massing/roof → **S6** walk-through → checkpoint: full end-to-end slice.
5. Regression + visual proof → **Phase 2 sign-off**, write `PHASE-2-COMPLETE.md` like the Phase 0/1 docs.

## Risks & mitigations

- **CSG needs watertight input** → validate solids before every boolean; keep wall/opening primitives as clean boxes; fail loud in dev.
- **Undo granularity** (drags spamming the stack) → coalesce continuous drags into one command on pointer-up (same approach the HD build used for drag snapshots).
- **Plan-view ↔ 3D coordinate mapping** bugs → single source of truth in `core` meters; `planView.js` only maps screen↔world, never stores geometry.
- **Walk-camera performance on swiftshader** → keep lights/shadows from Phase 1; no new heavy passes this phase.

## Explicitly out of scope (Phase 3+)

Auto room detection, angled/curved/merged walls, multi-level editing UI, roof types beyond flat, materials library UI, measurement tool, code/ADA checks, IFC export, import-a-plan and outsource-drawing onboarding, and swapping the furniture clip for the live image-to-3D API. These sit behind the Pro seam or in later phases and are not needed to prove the end-to-end skeleton.
