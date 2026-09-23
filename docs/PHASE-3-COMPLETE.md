# Phase 3 — Depth behind the seam: COMPLETE

**Verdict: DONE.** Every group in [`PHASE-3-PLAN.md`](./PHASE-3-PLAN.md) that the sign-off bar names is landed — and then some. The plan's bar is *"Groups A, B, D, E landed and the seam table fully live; Groups C and F may carry into Phase 4."* This branch clears that bar **and** lands all of Group C. Only **F1** (Meshy image-to-3D — server-side key, synthetic in CI) carries forward, exactly as the plan deferred it.

The Phase 2 skeleton is now a tool a real user can design a whole home in: rooms are auto-detected, named, measured and editable; roofs have gable infill and per-slope eaves; walls draw at any angle and mitre gap-free at their corners; both onboarding tiles (import a plan, outsource) are live; and every dormant Pro-seam row — materials, advisory checks, export — is activated. Each slice stayed novice-safe in Simple, lossless through the Phase 1 save, and engine-independent where the logic can be.

This is the sign-off that closes Phase 3, in the shape of [`PHASE-2-COMPLETE.md`](./PHASE-2-COMPLETE.md). It consolidates verification that was proven slice-by-slice (each in its own daily run, logged in [`DEV-LOG.md`](../DEV-LOG.md)) and re-confirmed by the current regression pass: **980 `src/` assertions + 33 `phase2` = 1013 passing, 0 failed.**

## Definition of done — every group landed

| Group | Slices | Status | Where / proof |
|---|---|---|---|
| **A · Rooms & labels** | A1 rename via plan dblclick · A2 hover-highlight · A3 wall/opening label · A4 auto room detection (engine + UI) | ✅ | `core/roomDetect`, `edit/commands` (`renameRoom`/`setElementLabel`/`addRoom`), `app/planCanvas`; `phase3-room-rename-plan.png`, `phase3-room-hover-plan.png`, `phase3-element-label.png`, `phase3-detect-rooms.png` |
| **B · Roof depth** | B1 gable-end wall infill · B2 per-slope eaves/rake overhang | ✅ | `core/roofShape` (`gableInfill`/`roofOverhangs`/`roofFootprint`), `build/geometry`; `phase3-gable-infill.png`, `phase3-roof-overhang.png` |
| **C · Wall depth (CSG-sensitive)** | C1 angled/polar wall entry · C2 mitred clean-corner walls (engine + view) | ✅ | `edit/snapping` (`polarOffset`/`segmentPolar`), `edit/tools` (`polarEntry`), `core/wallJoin` (`joinWalls`), `build/geometry`+`build/sceneBuilder`; `phase3-angle-entry.png`, `phase3-wall-mitre.png` |
| **D · Onboarding paths** | D1 import a plan (trace underlay + calibrate) · D2 outsource design-brief | ✅ | `core/underlay`, `core/outsourceBrief`, `app/planCanvas`, `main.js`; `phase3-import-plan.png`, `phase3-outsource.png` |
| **E · Dormant Pro rows** | E1 materials library · E2 advisory checks (advisory-only) · E3 export (OBJ/JSON) · E3+ glTF 2.0 · E3+ DXF 2D plan | ✅ | `core/model` (`MATERIAL_LIBRARY`), `core/advisoryChecks`, `core/exportObj`/`exportGltf`/`exportDxf`; `phase3-materials.png`, `phase3-advisory-checks.png`, `phase3-export.png`, `phase3-export-gltf.png`, `phase3-integration-e3plus-dxf.png` |
| **F · Furniture / image-to-3D** | F1 Meshy image-to-3D | ⏸ deferred to Phase 4 | server-side key (constraint #7); GLB clip stands in; never a live API call in CI |

Every headless slice ran the Phase 0/1 way with **zero console/page errors** and left the Phase 1 regression (5 walls / 4 CSG openings / rooms / GLB furniture / lossless round-trip) intact.

## Simple / Pro seam — every planned row live

The seam table in [`PHASE-3-PLAN.md`](./PHASE-3-PLAN.md) is fully realized. Each row registers once in `FEATURE_TIERS`; the UI reads `isAvailable(tool, mode)` — one gate, no scattered conditionals.

| Capability | Slice | Simple | Pro | Registry |
|---|---|---|---|---|
| Rename room (plan dblclick) | A1 | — | ✅ | `room-rename` |
| Hover-highlight room | A2 | ✅ | ✅ | un-tiered (view state) |
| Wall/opening label | A3 | — | ✅ | `element-label` |
| Auto room detection (find + add) | A4 | ✅ | ✅ (+ name) | `room-detect` (Simple) + `room-rename` (Pro) |
| Gable infill / eaves | B1/B2 | — | ✅ | `roof-editor` |
| Angled entry / mitred walls | C1/C2 | — | ✅ | `snapping-constraints` (Pro) |
| Import a plan (+ calibrate) | D1 | ✅ | ✅ | `plan-import` (Simple) + `plan-calibrate` (Pro) |
| Outsource design brief | D2 | ✅ | ✅ | un-tiered |
| Materials library | E1 | ✅ | ✅ | `materials-swatch` |
| Advisory checks | E2 | — | ✅ | `code-checks` |
| Export (OBJ / JSON / glTF / DXF) | E3 / E3+ | — | ✅ | `ifc-export` |
| Image-to-3D furniture | F1 | ✅ | ✅ | `furnish-photo-3d` — **registered, not yet wired** (Phase 4) |

## How it was verified

Two independent tiers, both re-run for this sign-off.

**Engine-independent core suites** — `node src/test/*.test.mjs` across all **18** suites → **980 passed, 0 failed**, plus `phase2/test/phase2-core.test.mjs` → **33 passed, 0 failed** (1013 total). Per suite: advisory-checks 46 · angle-entry 60 · edit-core **337 (incl. the model/view separation guard 30a–i)** · element-label 41 · export-dxf 39 · export-gltf 47 · export-obj 47 · gable-infill 25 · materials-swatch 49 · outsource-brief 34 · roof-overhang 40 · roof-ridge 40 · room-detect-ui 28 · room-detect 32 · room-hover-plan 15 · room-rename-plan 18 · underlay 38 · wall-join 44. `node --check src/main.js` clean.

**Three.js view layer, headless** — each slice was proven the Phase 0/1 way: vendor `three` (r169) + `three-bvh-csg` (0.0.17) + `three-mesh-bvh` (0.7.6) via `git clone` (npm/CDN are blocked in the build environment; regenerate meshbvh's `*.generated.js` from `*.template.js`), wire an importmap harness, drive the *real* `src/main.js` over raw CDP on the pre-installed Chromium under swiftshader, assert **zero `pageerror`**, and screenshot to [`docs/verification/`](./verification/). The discriminating probes: `c1-angle-entry` (23/23 — a 3-4-5 triangle typed by polar segments with a CSG window surviving on the diagonal wall), `c2-wall-mitre` (12/12 — adjoining walls share seam points gap-free & non-overlapping, openings survive the mitre), `d2-outsource` (20/20), `e3plus-dxf` (18/18), plus the earlier A/B/E probes.

## Model/view separation held — and stayed automated

The Phase 2 separation guard (`edit-core.test.mjs` sections 30a–i) scans the whole `src/` tree statically and fails on any file outside the render/build/pick allowlist importing `three` / `three-bvh-csg` / `three-mesh-bvh`, and on a stale allowlist. **No Phase 3 slice touched the allowlist** — every new capability landed as pure `core/`/`edit/` logic (`roomDetect`, `wallJoin`, `snapping` polar helpers, `advisoryChecks`, `exportObj`/`exportGltf`/`exportDxf`, `outsourceBrief`, `underlay`) plus view wiring in the seven already-allowlisted files. The guard is green.

## Phase 1 lossless save — inviolable, and unbroken

Every Phase 3 slice is either derived-on-read (measurements, room detection, all four export formats, advisory checks, the outsource brief, the wall mitre) or edits an **existing** field (`renameRoom`, `setElementMaterial`). Where a slice added a field it was made **optional** and backfilled (`label` on wall/opening; `eaveOverhang`/`rakeOverhang` on roof, backfilling from the legacy uniform `overhang`) — so old saves still `validateProject()` and `serialize→deserialize→serialize` stays byte-identical. Every command remains undoable/redoable with byte-lossless inversion.

## Known caveats carried forward

- **CSG needs watertight, two-manifold input** (the Phase 0 caveat). Group C tightened this the most: the C2 mitre and C1 angled entry were both headless-proven to keep CSG openings watertight — a window cut into an angled wall survives (hole → 64 tris vs a plain prism's 12). The validation guard still runs before every boolean.
- **This is a design/visualization tool, not structural engineering or code certification.** Group E's advisory checks *flag* approximate residential rules of thumb (ceiling height, egress, room area) but every finding carries `ADVISORY_DISCLAIMER` and is never presented as code-compliant or engineer-certified. The outsource brief and DXF plan are likewise footered as approximate, not surveyed/engineered/construction-ready.
- **F1 (Meshy image-to-3D) is deferred to Phase 4.** It is the one registered seam row not yet wired; it needs a server-side key (constraint #7 — env placeholder only, never committed) and must stay synthetic in CI.

## Recommendation

**Proceed to Phase 4.** Phase 3 delivered depth on the existing architecture without a rewrite; the Phase 0–2 invariants (model/view separation, the Simple/Pro seam, the lossless save, undoable commands, watertight CSG) all held. Phase 4 scoping starts with **F1** (wire the Meshy pipeline behind a server-side key, synthetic GLB in CI) and the items the Phase 3 plan put explicitly out of scope — live collaboration, a real outsource backend, cloud project storage, curved walls, parametric stairs, and BIM/IFC round-trip *import*. No blockers.
