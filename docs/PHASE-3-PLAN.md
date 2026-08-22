# Phase 3 — Depth behind the seam (build plan)

*Status: **proposed — awaiting sign-off**. Phase 2 shipped a connected end-to-end skeleton ([`PHASE-2-COMPLETE.md`](./PHASE-2-COMPLETE.md)). Phase 3 adds **depth** to each stage — the features Phase 2 deliberately deferred behind the Simple/Pro seam. Nothing here changes the Phase 1 model contract or the lossless save; every slice adds an editing/read capability on top of it.*

## Why this document exists

The autonomous daily run had **no Phase 3 plan**, so each morning it re-picked work from the previous entry's free-text *"Next"* note. That caused three separate collisions — **PR #13/#14** shipped the *same* room-area readout twice (one became a near-duplicate and had to be salvaged into a different slice), and **PR #15/#16** collided on a shared base — each burning most of a run on rebases instead of new value. This document replaces the vague *"Next"* note with a **sequenced, deduplicated backlog** and a **pick protocol** (see the last two sections) so every future run selects a distinct, non-overlapping slice off a fresh base.

**This is a living planning doc, not a contract.** George steers it; a run may re-order or re-scope, but it must record the pick here (§ *Status ledger*) so the next run sees it.

## Objective

Turn the Phase 2 skeleton into a tool a real user can design a whole home in: rooms that are named, measured, and editable; walls and roofs with real-world depth; the deferred onboarding paths (import / outsource) wired up; and the dormant Pro-seam rows (materials, advisory checks, export) activated one at a time — each still novice-safe in Simple, each still lossless, each still engine-independent where the logic can be.

Phase 3 is **depth, not a rewrite.** The architecture from Phase 0–2 holds unchanged.

## Guiding constraints (carried from Phase 0/1/2 — non-negotiable)

1. **Model/view separation is sacred.** Logic lives in pure `core/` (data + rules), `edit/` (commands, tools — except the raycaster `picking.js`), `app/` (state, inspector, plan canvas), and `templates/`. Only the seven-file render/build/pick allowlist may import `three` / `three-bvh-csg` / `three-mesh-bvh`. The **automated separation guard** in `src/test/edit-core.test.mjs` (sections 30a–i) fails the suite on any leak *and* on a stale allowlist — keep it green.
2. **The Simple/Pro seam is the only gate.** Every new tool registers once in `FEATURE_TIERS` (`src/app/state.js`); the UI reads `isAvailable(tool, mode)`. No scattered `if (pro)` conditionals. Novice-first: Simple stays clean and read-only where Pro gains an input.
3. **The Phase 1 lossless save is inviolable.** Prefer read-only/derived features (measurements) and edits over the room's **existing** fields (no new required save field). When a slice must add a field, make it **optional** so old saves still `validateProject()`, and prove `serialize→deserialize→serialize` is byte-identical after every command.
4. **Every edit is an undoable command.** Mutations go through `commands.js` + `history.js` (apply/invert, byte-lossless undo), never a direct model poke. Selection/hover/view state is *not* a command (it's view state — it must never touch the save).
5. **CSG inputs stay watertight/two-manifold** (the Phase 0 caveat). Wall/opening/roof primitives remain clean boxes/prisms; the validation guard runs before every boolean. Angled/merged walls (Group C) tighten this and carry the most risk.
6. **This is a design/visualization tool — never code-certification.** Advisory checks (Group E) may *flag* approximate real-world defaults (min ceiling height, egress width) but must be clearly labelled advisory/approximate and **never** presented as code-compliant or engineer-certified.
7. **Secrets stay server-side.** The Meshy image-to-3D key (Group F) is env-var placeholder only; never commit a key.
8. **Verify headless before shipping**, the Phase 0/1 way: pure logic via the `node` core suites; Three.js view work via vendored deps (`git clone` — npm/CDN blocked), importmap harness, real app over CDP on the pre-installed Chromium under swiftshader, **zero console/page errors**, screenshot saved to `docs/verification/`.

## What has already landed in Phase 3

Phase 3 is well underway — most momentum so far is in **rooms/measurement** and **roof**. Merged to `main`:

| Theme | Slice | Landed | Where |
|---|---|---|---|
| Multi-level | Storey add/remove/rename editing (Pro `multi-level`) | 2026-07-21 | `core/model`, `edit/commands`, inspector |
| Roof | Gable + hip roof types (Pro `roof-editor`) | 2026-07-22 | `core/roofShape`, `build/geometry` |
| Roof | Ridge-direction override auto/X/Z (gable & hip) | 2026-07-26 (PR #16) | `core/roofShape` |
| Measure | Measure tool (Pro `measure-tool`) — point-to-point | 2026-07-22 | `edit/measure` |
| Rooms | Per-room floor-area + perimeter readout (inspector) | 2026-07-23/24 (PR #13/#14) | `core/model` `polygonArea`/`polygonPerimeter`, inspector |
| Rooms | Plan-canvas area labels at each room centroid | 2026-07-24 (PR #13) | `core/model` `polygonCentroid`, `app/planCanvas` |
| Rooms | Whole-home GFA summary (inspector empty state) | 2026-07-25 | `core/model` `projectFloorArea`, inspector |
| Rooms | Plan-click room selection (point-in-polygon) | 2026-07-27 (PR #17) | `core/model` `pointInPolygon`/`roomAtPoint`, `edit/tools` |
| Rooms | Rename a room from the inspector (Pro `room-rename`) | 2026-07-28 (PR #18) | `edit/commands` `renameRoom`, inspector, `esc()` XSS-harden |
| Rooms | Rename a room by double-clicking it on the plan (Pro) | 2026-07-30 (PR #20) | `app/planCanvas` dblclick, `main.js` inline centroid editor |
| Rooms | Hover-highlight the room under the plan cursor (un-tiered view state) | 2026-08-01 (PR #21) | `app/planCanvas` `hoverRoomId`, `main.js` pointer wiring |

**Still dormant** (registered in `FEATURE_TIERS` but *not* wired to any UI): `materials-swatch`, `code-checks`, `ifc-export`, `furnish-photo-3d`. **Still disabled** (shown as "coming soon" tiles in `main.js:602–603`): *Import a plan*, *Outsource*.

## The backlog — grouped, sequenced, deduplicated

Slices are grouped by theme and ordered *within* a group by dependency. Across groups, prefer the **lowest-risk, highest-reuse** slice with a green base (see the pick protocol). Each slice names its **tier**, **dependencies**, **new-save-field risk**, and **verification tier** (pure-only vs. pure+headless).

### Group A — Rooms & labels *(active momentum; mostly pure-core; lowest risk — do these first)*

- **A1 · Rename a room by double-clicking its plan label.** Plan-side entry to the existing `renameRoom` command (07-28). Reuses `roomAtPoint` (07-27) + double-click detection + `buildRoomRename`. **Tier:** Pro (mirror the inspector gate). **Deps:** none new. **Save field:** none. **Verify:** pure (dblclick timing, room resolution, command emission) + headless (label edit renders, model updates, undo restores). *Natural immediate next — smallest, highest-reuse.*
- **A2 · Hover-highlight the room under the plan cursor.** Pure view state (like selection but on move); warmer fill on hover, no command, no save touch. **Tier:** un-tiered (both). **Deps:** `roomAtPoint`. **Save field:** none. **Verify:** pure (hover resolves room; no command/rebuild) + headless (fill changes on move).
- **A3 · Editable wall/opening label in Pro.** Extend the rename seam from rooms to walls/openings — an optional `label`/`name` field on the wall/opening, edited in the inspector via a command mirroring `renameRoom`. **Tier:** Pro. **Deps:** A1 pattern. **Save field:** *optional* (must round-trip; keep old saves valid). **Verify:** pure (command + lossless + old-save-still-valid) + headless.
- **A4 · Auto room detection (walls → closed rooms).** Derive room polygons from wall loops so hand-drawn walls become measurable rooms without a template. **Larger — pure graph/geometry** (planar cycle detection). **Tier:** un-tiered read (rooms appear); Pro to name. **Deps:** none engine. **Save field:** none if derived-on-read; optional if cached. **Verify:** pure-heavy (cycle detection on several wall layouts) + headless. *Highest value in Group A but biggest — do after A1–A3.*

### Group B — Roof depth *(pure `roofShape` + view geometry; medium risk)*

- **B1 · Gable-end wall infill.** Fill the triangle under a gable so the end reads as wall, not void (currently a gable leaves a gap). **Tier:** follows `roof-editor` (Pro). **Deps:** `roofShape` ridge math (07-26). **Save field:** none (derived). **Verify:** pure (infill vertices from footprint+pitch+ridge) + headless (no gap; watertight; CSG unaffected).
- **B2 · Per-slope eaves / overhang.** Extend the roof past the wall plane per slope. **Tier:** Pro. **Deps:** B1 not required but related. **Save field:** *optional* `overhang` (roof already carries `overhang` for flat — extend, keep optional). **Verify:** pure + headless.

### Group C — Wall depth *(CSG-sensitive; highest risk — schedule deliberately, small steps)*

- **C1 · Angled / non-orthogonal wall drawing.** Confirm/extend beyond grid-orthogonal draw. **Tier:** Pro (angle entry). **Deps:** snapping (07-18). **Save field:** none (walls already store free `a/b` points). **Verify:** pure (geometry) + headless (CSG stays watertight — the Phase 0 caveat bites hardest here).
- **C2 · Merged / T-junction walls (clean corners).** Miter/merge adjoining walls so corners are gap-free for CSG. **Tier:** Pro. **Deps:** C1. **Save field:** none. **Verify:** pure + headless (watertight guard must pass). *Do last in Phase 3 — most likely to regress CSG openings.*

### Group D — Onboarding paths *(wire the disabled tiles)*

- **D1 · Import a plan (trace an uploaded floor plan).** Enable the disabled tile: load a raster floor plan as a plan-canvas underlay to trace walls over. Scale-calibrate by drawing a known dimension. **Tier:** un-tiered (import) / Pro (calibrate). **Deps:** plan canvas. **Save field:** *optional* underlay ref/scale (keep out of the geometry save if possible — treat as a session/display pref). **Verify:** pure (screen↔world scale math) + headless (underlay renders under walls). *No external upload service — local file only; synthetic image for tests.*
- **D2 · Outsource-drawing tile.** Wire the second disabled tile to an explanatory/intake flow (no backend in this repo — content/UX only; **do not** touch backend deploy config). **Tier:** un-tiered. **Deps:** none. **Save field:** none. **Verify:** pure/UI + headless (tile enables, flow renders).

### Group E — Dormant Pro rows *(activate one at a time, like `measure-tool` was)*

- **E1 · Materials library UI (`materials-swatch`).** A swatch picker that sets a wall/room/roof material (the model already carries a `material` field). **Tier:** Simple (already registered `MODE.SIMPLE`). **Deps:** none. **Save field:** none (existing `material` field). **Verify:** pure (setMaterial command, lossless) + headless (material visibly changes).
- **E2 · Advisory checks (`code-checks`) — ADVISORY ONLY.** Flag approximate real-world thresholds (min ceiling height, egress/door width, room min area) with a clear *"approximate, not code-certified"* label per constraint #6. **Tier:** Pro. **Deps:** measurement (landed). **Save field:** none (computed on read). **Verify:** pure-heavy (threshold logic + labelling) + headless.
- **E3 · Export (`ifc-export` / or a simpler glTF/OBJ/JSON export first).** Engine-independent model → interchange. Consider a **pure JSON/OBJ export before full IFC** (IFC is large). **Tier:** Pro. **Deps:** none. **Save field:** none. **Verify:** pure (export serializer round-trips a known project) + headless if a 3D format.

### Group F — Furniture / image-to-3D *(server-side; scheduled last)*

- **F1 · Wire the Meshy image-to-3D pipeline (`furnish-photo-3d`).** Currently a GLB clip stands in. Needs a **server-side** key (env placeholder only — constraint #7) and is the largest external dependency. **Tier:** Simple (registered). **Deps:** GLB loading (Phase 1). **Verify:** headless with a **synthetic/local GLB** (never a live API call in CI). *Deferred to end of Phase 3 or Phase 4 — do not block earlier depth on it.*

## Simple / Pro exposure (FEATURE_TIERS deltas this phase)

Most Phase 3 rows are already registered. Deltas as slices land:

| Capability | Slice | Simple | Pro | Registry state |
|---|---|---|---|---|
| Rename room (plan dblclick) | A1 | — | ✅ | reuse `room-rename` |
| Hover-highlight room | A2 | ✅ | ✅ | un-tiered (view state) |
| Wall/opening label | A3 | — | ✅ | `element-label` (Pro) |
| Auto room detection | A4 | ✅ (find+add) | ✅ (find+add, name) | `room-detect` (Simple) — **live**; naming via `room-rename` (Pro) |
| Gable infill / eaves | B1/B2 | — | ✅ | reuse `roof-editor` |
| Angled / merged walls | C1/C2 | — | ✅ | reuse `draw-wall` + new Pro entry |
| Import a plan | D1 | ✅ | ✅ (calibrate) | `plan-import` (Simple) + `plan-calibrate` (Pro) — **live** |
| Materials library | E1 | ✅ | ✅ | activate `materials-swatch` |
| Advisory checks | E2 | — | ✅ | activate `code-checks` |
| Export | E3 | — | ✅ | activate `ifc-export` |
| Image-to-3D furniture | F1 | ✅ | ✅ | activate `furnish-photo-3d` |

## Verification plan (per slice — unchanged from Phase 2, applied here)

- **Pure logic:** extend `src/test/edit-core.test.mjs` (or a new sibling `*.test.mjs` file when a slice may collide with in-flight work — the roof suite did this) with assertions for the new logic. Keep the **model/view-separation guard** green. Keep `phase2/test/phase2-core.test.mjs` at 33/33.
- **Model invariants after every command:** `validateProject()` passes; `serialize→deserialize→serialize` byte-identical; old saves (no new field) still validate.
- **Three.js view work, headless:** vendor `three` (pinned `^0.169.0` → r169) + `three-bvh-csg` + `three-mesh-bvh` via `git clone` (regenerate meshbvh's `*.generated.js` from `*.template.js`), importmap harness, drive real `src/main.js` over CDP under swiftshader, **zero console/page errors**, screenshot to `docs/verification/phase3-<slice>.png`.
- **Regression each run:** the Phase 1 sample (5 walls / 4 CSG openings / rooms / GLB furniture / lossless round-trip) must hold.

## Recommended sequence

1. **A1** (rename via plan dblclick) → **A2** (hover highlight) → **A3** (wall/opening label) — small, pure-heavy, high-reuse; ride the current room momentum.
2. **B1** (gable infill) → **B2** (eaves) — close the open roof follow-ups.
3. **E1** (materials) → **D1** (import-a-plan) — activate a dormant row and a disabled tile; both novice-visible wins.
4. **A4** (auto room detection) — larger pure-geometry payoff once labels/hover exist.
5. **E2** (advisory checks) → **E3** (export) — Pro depth; advisory strictly labelled.
6. **C1 → C2** (angled/merged walls) — highest CSG risk; schedule when there's runway, small steps.
7. **D2** (outsource UX) and **F1** (Meshy) — last; F1 needs a server-side key and stays synthetic in CI.

Phase 3 **sign-off** (write `PHASE-3-COMPLETE.md`) when Groups A, B, D, E have landed and the seam table is fully live. Groups C and F may carry into Phase 4.

## Explicitly out of scope for Phase 3

Live multi-user collaboration; a real backend for outsource intake; cloud project storage; curved walls; parametric stairs/railings; full BIM/IFC round-trip *import*; and swapping the whole renderer. These are Phase 4+.

---

## Pick protocol (read this first, every run)

The rule that ends the #13/#14/#15 collisions. Before writing any code:

1. **Start from a truly fresh base.** `git fetch origin main` then branch off `origin/main` — **not** the session's possibly-stale local `main` (the 07-26 run branched off a 4-commits-behind `main` and had to rebase). Confirm the DEV-LOG top entry matches what you expect the latest merged PR to be.
2. **Check for open PRs.** `list_pull_requests(state=open)`. If a slice's files overlap an open PR, **pick a different slice** whose files don't (the 07-26 run dodged open PR #15 this way). Never ship a near-duplicate of an open/merged PR's feature — a regression or a redundant PR is worse than no change.
3. **Pick ONE slice** from the backlog above, honoring the recommended sequence unless a dependency or an open-PR overlap forces otherwise. Prefer lowest-risk/highest-reuse.
4. **Mark it in the status ledger below** (in your branch) *before* coding, so the next run sees it as taken.
5. **When a slice may collide with in-flight test work, add a new `*.test.mjs` file** rather than editing a shared section of `edit-core.test.mjs` (the roof suite's approach — it never collided).
6. **Ship only if it verifies** (pure + headless as the slice requires). Log the run in `DEV-LOG.md` (newest on top) and update the ledger row to *Landed (PR #n)*.

## Status ledger

*One row per slice. Update the status in your branch as part of the pick (step 4) and the ship (step 6). `todo` → `in-progress (branch)` → `Landed (PR #n)`.*

*Cleaned 2026-08-15: the mechanical union of five stacked PRs' ledger edits had duplicated these rows — collapsed back to one authoritative row per slice. B2/E1/E3/D1/A4 are consolidated on integration branch `auto/2026-08-15` (PR #29), which supersedes #24–#28.*

| Slice | Status | PR / notes |
|---|---|---|
| A1 · Rename room via plan dblclick | Landed (PR #20) | plan-side entry to renameRoom; inline centroid label editor, Pro-gated. 18 pure + 16 headless checks |
| A2 · Hover-highlight room on plan | Landed (PR #21) | pure view state on pointer-move; warmer fill under cursor, no command/save. reuses `roomAtPoint`, gated to SELECT tool. Headless 12/12, screenshot `docs/verification/phase3-room-hover-plan.png`. Restored headless verification via the committed Playwright-CDP harness under `automation/headless-verify/` |
| A3 · Wall/opening label (Pro) | Landed (PR #22) | new `element-label` tier; `setElementLabel` command + `buildElementLabel` builder; OPTIONAL `label` on wall/opening (empty clears the key → old saves byte-identical). inspector title reflects the label. 41 pure + regression green. Headless 17/17, screenshot `docs/verification/phase3-element-label.png` |
| A4 · Auto room detection (engine) | Landed (PR #30, was #29 integration) | pure `detectRooms`/`detectNewRooms` in `src/core/roomDetect.js` (planar wall-graph → bounded-face cycles; endpoint-merge + T-junction split; spurs/dupes dropped; derived-on-read, no save field). `room-detect.test.mjs`. |
| A4 · Auto room detection (UI wiring) | in-progress (branch auto/2026-08-18) | plan overlay + click-to-add over the merged engine. New un-tiered `room-detect` seam + a "Find rooms" toolbar button (`runDetect` toggle) that surfaces `detectNewRooms(level)` candidates as dashed teal "+ Add room" outlines; clicking one commits the **new undoable `addRoom` command** (createRoom → history; no new save field, byte-lossless). Re-detects after each add so the added room drops out of the offer (naming stays behind the Pro `room-rename` gate). **Fixed a latent engine bug:** `detectNewRooms` "covered" test was area-only (its docstring says area **AND** centroid-in) — two equal-area rooms both vanished when one was saved; now position-aware. `room-detect-ui.test.mjs` **28** + core suite **29→32**. Headless **21/21**, screenshot `docs/verification/phase3-detect-rooms.png`. |
| B1 · Gable-end wall infill | Landed (PR #23) | pure `gableInfill` + `wallBounds` in `core/roofShape.js` (wall-plane triangular prisms rising to the ridge, wall material) + `buildGableInfillMesh` view mesh, wired in `sceneBuilder`; roof shell untouched. No new save field (derived). 25 pure + regression green. Headless 14/14, screenshot `docs/verification/phase3-gable-infill.png` |
| B2 · Per-slope eaves / overhang | Landed (PR #30, was #29 integration) | eave (sloped) vs. rake (gable/hip end) overhang. OPTIONAL `eaveOverhang`/`rakeOverhang`, both backfilling from the legacy uniform `overhang` (`roofOverhangs`) → old saves byte-identical. Per-slope `roofFootprint`; ridge axis resolved from bare wall bounds so a big rake never flips the ridge. Two Pro roof-panel sliders. 40 pure. Headless 16/16, screenshot `docs/verification/phase3-roof-overhang.png` |
| C1 · Angled walls | todo | CSG-sensitive |
| C2 · Merged / T-junction walls | in-progress (auto/2026-08-20) — pure mitre engine landed | pure `core/wallJoin.js` (new file, imports only `model.js`, no Three.js): `joinWalls(walls)` → per-wall mitred quad `[aR,bR,bL,aL]`. At a node where EXACTLY two walls meet, their ±½-thickness offset edges are intersected so the rectangles share ONE seam (gap-free **and** non-overlapping); collinear edges, free ends, and T/X (3+) nodes stay square (safe watertight fallback); a runaway acute spike is capped by a mitre limit. Derived-on-read — mutates nothing, no save field. `wall-join.test.mjs` **44/44**. View wiring (extrude the quads into corner prisms in `build/geometry.js`) is the follow-up once `main.js`/`geometry.js` are free of the open UI PRs. |
| D1 · Import a plan (trace underlay) | Landed (PR #30, was #29 integration) | pure `core/underlay.js` (image↔world mapping + `calibrateScale`/`calibrateUnderlay`, anchored rescale); underlay is DISPLAY state, never saved. `app/planCanvas.js` draws it beneath the walls + captures calibration clicks; `main.js` wires the live "Import a plan" tile + "Plan image…" popover. New seam rows `plan-import` (Simple) + `plan-calibrate` (Pro). 38 pure. Headless 21/21, screenshot `docs/verification/phase3-import-plan.png` |
| D2 · Outsource-drawing UX | todo | disabled tile |
| E1 · Materials library UI | Landed (PR #30, was #29 integration) | activated `materials-swatch`: `MATERIAL_LIBRARY` (10 finishes) + `materialDef`/`isLibraryMaterial` in `core/model.js`; `setElementMaterial` repoints the element's EXISTING `material` key, registers a finish on first use, byte-lossless LIFO undo; inspector swatch slot for walls/floors; Simple-tier. No new save-field type. 49 pure. Headless 20/20, screenshot `docs/verification/phase3-materials.png` |
| E2 · Advisory checks (advisory only) | engine landed (branch auto/2026-08-19); UI in 08-22 integration | new pure `src/core/advisoryChecks.js` (`runAdvisoryChecks` + per-check fns) — reads walls/openings/rooms/level heights, flags approximate residential rules of thumb (ceiling height, habitable room area, door width/height, egress window area/sill, storey natural-light/access) as **advisory-only** findings with an always-present `ADVISORY_DISCLAIMER`. Computed on read; no save field; mutates nothing; imports only `model.js`. `advisory-checks.test.mjs` **46/46**. A Pro "Checks" panel listing findings + click-to-select wired in the 08-22 integration run. |
| E3 · Export (JSON/OBJ before IFC) | Landed (PR #30, was #29 integration) | new pure `core/exportObj.js` (Wavefront OBJ massing — walls as boxes, floors as ear-clipped slabs — + companion MTL; plus lossless JSON save). Activates the `ifc-export` Pro seam with an Export… popover. Zero Three.js added; no new save field; export mutates nothing. 47 pure. Headless 19/19, screenshot `docs/verification/phase3-export.png` |
| E3+ · glTF 2.0 export | engine landed (branch auto/2026-08-21); UI in 08-22 integration | new pure `core/exportGltf.js` — the third E3 format the plan names ("glTF/OBJ/JSON"). REUSES `exportObj.js`'s `wallMesh`/`roomSlabMesh` massing helpers (so glTF & OBJ can't drift) and emits a single self-contained glTF 2.0 doc: one JSON with the binary geometry buffer embedded as a base64 `data:` URI (no companion `.bin`), PBR materials from the project's material map. Portable base64 encoder (no Buffer/btoa) → runs in Node **and** the browser; imports only `exportObj.js`+`model.js`, **zero Three.js**. Derived-on-read; mutates nothing; no save field. `export-gltf.test.mjs` **47/47** + real **three.js GLTFLoader** round-trip (5 meshes / 40 verts / 60 tris, matches exactly). Sample `docs/verification/phase3-export-gltf-sample.gltf`. A glTF item added to the Export… popover in the 08-22 integration run. |
| F1 · Meshy image-to-3D furniture | todo | server-side key; last |
