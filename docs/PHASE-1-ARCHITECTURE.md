# Phase 1 — Architecture & data model

**Status: complete and verified.** The hardcoded Phase 0 spike is now a proper, data-driven architecture. A whole home is described by a plain, serializable model; a builder turns any such model into a 3D scene; and projects save/load losslessly. Verified headlessly against a two-room sample home (see `phase1.png` exterior and `phase1-interior.png` cutaway).

## Design principle: model / view separation

The single most important decision here. The **model** (`src/core/`) is plain JSON-serializable data with zero Three.js in it — it *is* the save file. The **builder + viewer** (`src/build/`, `src/viewer/`) are the only code that touches Three.js. This means the project file is engine-independent, testable without a GPU, and portable to future exporters (glTF now, IFC later) without dragging rendering code along.

## The data model (`src/core/model.js`)

Everything is in **real-world meters, +Y up** (the glTF and IFC convention), so the model is correct by construction and ready for both AR export and BIM export.

```
Project
├─ name, units (display pref; storage always metric), schemaVersion
├─ Site            { width, depth, material }         — the lot
├─ materials       { wall, floor, roof, ground, … }   — named, referenced by id
├─ Levels[]        (storeys)
│   ├─ elevation, height
│   ├─ Walls[]     { a{x,z}, b{x,z}, thickness, height, material }   — centerline
│   ├─ Openings[]  { wallId, kind:door|window, offset, width, height, sill }
│   ├─ Rooms[]     { points[{x,z}], material }         — floor polygons
│   └─ roof        { type:flat, thickness, overhang }
└─ Furniture[]     { src(GLB), levelId, position{x,z}, rotationY, scale }
```

- **Openings reference walls by id and are cut with CSG** — the same boolean-subtraction model IFC uses (`IfcOpeningElement` / `IfcRelVoidsElement`), so the pro/BIM export maps straight onto this.
- **"Approachable but correct" defaults** live in one place (`DEFAULTS`): 12 cm walls, 2.7 m ceilings, 0.9 × 2.1 m doors, 1.4 × 1.2 m windows with a 0.9 m sill. Novices get real-world-sane results without measuring; Pro mode edits the numbers.
- **`validateProject()`** catches bad geometry early: zero-length walls, non-positive thickness/height, openings that don't fit their wall, degenerate rooms.

## Save format (`serialize` / `deserialize`)

The project **is** the save file: pretty-printed JSON with a `schemaVersion` (currently 1) and a migration hook in `deserialize` for when the schema evolves. Verified **lossless round-trip**: `serialize → deserialize → serialize` is byte-identical and re-validates. GLB stays the runtime/AR export; this JSON is the editable source of truth.

## Units (`src/core/units.js`)

Storage is always meters. This module only formats/parses for display, so a novice can type `10'6"` and a pro can type `3.2m` while the model stays precise and metric. Supports metric and imperial (feet-inches), plus area.

## The Simple / Pro seam (`src/app/state.js`)

The novice-first-with-pro-depth requirement is implemented as **one gate the whole UI reads from** (progressive disclosure). `FEATURE_TIERS` maps every tool to the minimum mode it appears in; `isAvailable(tool, mode)` is the only check the UI needs. Simple mode currently exposes 8 novice tools (draw wall, place door/window, furnish-from-photo, templates, materials, orbit); Pro adds exact dimensions, snapping/constraints, multi-level, roof editor, code checks, IFC export, measure. Adding a tool = one line here, not scattered conditionals.

## Module layout

```
src/
  core/    model.js  units.js                  ← pure data + rules (no Three.js)
  build/   sceneBuilder.js geometry.js
           materials.js furniture.js            ← model → Three.js
  viewer/  viewer.js                            ← renderer/camera/controls/lights/framing
  app/     state.js                             ← mode + units + Simple/Pro seam
  templates/ sampleHome.js                      ← starter project (pure data)
  main.js                                       ← wires it together
```

Every built mesh carries `userData.modelId` and `userData.kind` ('wall' | 'floor' | 'roof' | 'furniture' | 'ground'), so selection/editing in later phases maps a clicked mesh straight back to its model object.

## Verified this phase

- Two-room sample home built from **pure model data** → 10 scene objects (ground, 5 walls, 2 floors, roof, 1 furniture), tagged and counted correctly.
- **4 openings** (front door, 2 windows, interior door) cut via CSG.
- **Save/load round-trip lossless** and re-validating.
- Zero console errors / zero failed loads, headless.

## Next: Phase 2 — broad end-to-end skeleton

Make it *interactive*: draw/edit walls and drop openings by clicking (writing back to this model), a template picker that instantiates starter projects, basic exterior massing + the flat roof already modeled, and a walk-through camera — one thin but connected slice across the whole flow, all reading and writing this same data model.
