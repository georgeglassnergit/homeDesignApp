# Home Studio — whole-home design platform (Phase 0)

A fresh **Vite + Three.js** project, separate from the live room-clip demo (which stays untouched). This is the foundation for the whole-home interior/exterior design platform.

## What Phase 0 proves

A working end-to-end spike of the core engine hypothesis:

- **Three.js** renders the scene in the browser.
- The room is modeled in **real-world meters** (5 × 4 m, 2.7 m ceiling) — the glTF/IFC convention (+Y up, meters).
- **Doors and windows are cut into walls with `three-bvh-csg`** (boolean subtraction) — the exact technique the pro BIM standard (IFC) formalizes, so the pro layer later isn't a rewrite.
- An existing **Meshy-exported GLB** loads straight into the scene via `GLTFLoader` — the furnishing pipeline plugs into the new engine unchanged.

See `PHASE-0-GONOGO.md` for the verified result.

## Run it locally

You need Node 18+ and npm (normal internet access).

```
npm install      # fetches three, three-bvh-csg, vite
npm run dev       # opens http://localhost:5173
npm run build     # emits dist/ for Cloudflare Pages
```

## Project layout

```
index.html          # app entry (loads src/main.js)
src/main.js         # the scene: room in meters, CSG openings, GLB load
public/sample.glb   # a sample Meshy object used by the spike
vite.config.js
```

## Note on how this was verified

The cloud build environment this was authored in blocks all package registries (npm, PyPI) and CDNs, so `npm install` / `vite` can't run there. The spike was instead verified headlessly via a no-build **importmap harness** (`verify.html`) that maps the same bare imports `src/main.js` uses to vendored copies of the libraries — so the scene code you build with Vite is byte-for-byte the code that was tested. On your machine, `npm install` + `npm run dev` is the normal path; the harness and `vendor/` folder are testing scaffold you can ignore or delete.
