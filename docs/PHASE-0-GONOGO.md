# Phase 0 — Foundation spike: GO / NO-GO

**Verdict: GO.** The Three.js migration is sound. Every load-bearing assumption behind the engine decision was proven in a running, headless-verified spike.

## What was tested (headless, Chromium + WebGL)

| Check | Result |
|---|---|
| Three.js boots and renders in the browser | ✅ booted, canvas drew |
| Room modeled in real-world meters (5 × 4 × 2.7 m) | ✅ roomBuilt |
| Door cut into a wall via `three-bvh-csg` boolean subtraction | ✅ |
| Window cut into the same wall (second boolean) | ✅ (wall went 12 → **111 triangles**, i.e. the openings were really carved) |
| Meshy-exported GLB loads via `GLTFLoader`, in meters, dropped to the floor | ✅ glbLoaded (1.41 × 1.00 × 1.41 m) |
| Zero console errors / zero failed resource loads | ✅ clean |

The render shows the room with a see-through door and window opening, and the Meshy object sitting inside — see `spike.png`.

## Why this de-risks the whole plan

- **CSG is the hard part of architectural geometry, and it works out of the box.** Cutting openings is the operation every wall/door/window in the product depends on; proving it in the recommended library on frame one removes the biggest technical unknown.
- **The furnishing pipeline transfers for free.** Your Meshy investment (photo → GLB) drops into the new engine with a stock loader — no rework.
- **Real-world units are native**, so the "approachable but correct" defaults and the eventual pro/measurement layer sit on a correct foundation.
- **The path to the pro layer is straight:** the same boolean-subtraction opening model is exactly how IFC (the BIM standard) represents doors/windows, so a future IFC export maps cleanly onto this geometry.

## Known caveat to carry forward

`three-bvh-csg` requires **watertight, two-manifold** input solids. Our wall/opening primitives are clean boxes, so this is fine now — but it becomes a validation rule to enforce once walls get more complex (angled walls, merged rooms). Add it to the guardrail set alongside the existing mesh-validation work.

## Recommendation

Proceed to **Phase 1 — Architecture & data model**: define the whole-home model (lot → levels → walls → openings → rooms → roof → furniture → materials), the Simple/Pro toggle seam, the units system, and the project save format. No blockers.
