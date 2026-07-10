# Phase 2 view-layer contract (the Three.js half — not yet verified)

The verified core (model + commands + history) is deliberately engine-free. The view layer is the only code that touches Three.js, and it talks to the core through the small, explicit contract below. Implement and verify these in the environment that ran Phase 0/1 (Three.js + `three-bvh-csg` available, headless WebGL for tests). Stub files with matching signatures live in `src/edit/` and `src/viewer/`.

## 1. Builder / rebuild
```
rebuild(project, scene) -> void
```
Pure function of the model: clears prior generated meshes and rebuilds walls, openings (CSG-cut), rooms/floors, roof, and furniture from `project`. Every mesh must stamp `userData.modelId` and `userData.kind` ('wall'|'floor'|'roof'|'opening'|'furniture'|'ground') — Phase 1 already does this. Called after every command.

## 2. Picking (`src/edit/picking.js`)
```
raycast(pointerEvent, camera, scene) -> { modelId, kind } | null
```
Screen point → Three.Raycaster against generated meshes → the `userData` of the first hit. No model mutation.

## 3. Tool controller (`src/edit/tools.js`)
```
class ToolController {
  constructor({ state, history, project, planView, picking, rebuild })
  setTool(name)                       // 'select'|'drawWall'|'placeDoor'|'placeWindow'
  onPointerDown/Move/Up(event)        // translate gestures into commands
}
```
Rules: gestures build a command from `edit/commands.js`; commit via `history.execute(cmd)`; then call `rebuild`. Coalesce continuous drags into **one** `moveWallVertex` on pointer-up. Only offer tools where `isAvailable(tool, state.mode)`.

## 4. Plan view (`src/edit/planView.js`)
```
screenToWorld(px, py) -> { x, z }      // top-down; storage stays metric
worldToScreen({x,z}) -> { px, py }
snap({x,z}, gridStep=0.1) -> {x,z}     // Simple mode; Pro exposes exact entry via units.parseLength
```
Only maps between screen and world. Never stores geometry — the model is the single source of truth.

## 5. Openings via CSG (in the builder)
For each `Opening`, build a box solid at `offset` along its wall (sized `width`×`height`, raised by `sill`) and subtract it from the wall solid with `three-bvh-csg`. **Guard:** wall/opening solids must be watertight/two-manifold before the boolean (the Phase 0 caveat) — validate and fail loud in dev.

## 6. Viewer (`src/viewer/`)
- **View mode:** `setViewMode('exterior'|'cutaway')` — cutaway hides roof + far walls (as in `platform/phase1-interior.png`). View state is a display pref, not geometry.
- **Walk camera:** `setCamera('orbit'|'walk')` — walk = first-person at ~1.6 m eye height, WASD move + pointer look, clamped to the level; Esc returns to orbit.

## Verification to add (headless, swiftshader)
Load a starter, drive the tool controller with synthetic pointer events to draw a 4-wall room + cut a door/window, assert the model matches, rebuild, screenshot exterior + cutaway + a walk-through frame, and confirm **zero console errors**. Re-run the Phase 1 checks (object counts, 4 CSG openings, lossless round-trip) as regression.
