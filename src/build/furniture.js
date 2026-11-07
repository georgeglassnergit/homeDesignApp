import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const _loader = new GLTFLoader();

// Load a furniture GLB (e.g. a Meshy export, in meters) and place it on the floor
// at its plan position. Returns a Promise resolving to the added object (or null).
export function loadFurniture(furn, group, levelElevation = 0) {
  return new Promise((resolve) => {
    _loader.load(
      furn.src,
      (gltf) => {
        const obj = gltf.scene;
        obj.scale.setScalar(furn.scale || 1);
        obj.rotation.y = furn.rotationY || 0;
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj);
        obj.position.set(
          furn.position.x,
          levelElevation - box.min.y,     // drop so its base sits on the floor
          furn.position.z
        );
        obj.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
        obj.userData.modelId = furn.id;
        obj.userData.kind = 'furniture';
        group.add(obj);
        resolve(obj);
      },
      undefined,
      (err) => { console.warn('[furniture] load failed', furn.src, err && err.message); resolve(null); }
    );
  });
}

// Strict GLB probe for the furnish VERIFY step (app/furnishController.js injects this as
// `loadGlb`). Unlike loadFurniture — which swallows a failed load so one bad GLB can't abort a
// whole scene build — this REJECTS on a load error, so the controller can treat "came back but
// won't load" as a bad response and refuse to commit a phantom record. It only parses the asset
// to prove it's a real, loadable GLB; it adds nothing to any scene (the real placement is done
// by loadFurniture/syncFurniture once the record is committed).
export function loadGlbStrict(src) {
  return new Promise((resolve, reject) => {
    _loader.load(
      src,
      (gltf) => resolve(gltf),
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err && err.message ? err.message : err))),
    );
  });
}

// Reconcile the furniture objects in the scene group with the model's `project.furniture[]`.
// Geometry (walls/floors/roof/ground) is re-derived every edit by rebuildGeometry, which leaves
// loaded furniture untouched; this is the companion that keeps the ASYNC furniture layer in sync
// after a furnish/add/remove or an undo/redo:
//   • a record present in the model but not yet in the scene  → load + place its GLB
//   • a furniture object in the scene whose record is gone     → remove + dispose it
// Matching is by the stable `userData.modelId === furniture.id` stamp loadFurniture writes.
// Returns a Promise resolving to the objects loaded this pass (so a caller can frame/inspect).
export function syncFurniture(group, project, levelElevById = () => 0) {
  const records = Array.isArray(project.furniture) ? project.furniture : [];
  const wantIds = new Set(records.map((f) => f.id));
  const present = new Map();   // modelId -> scene object, for the ones already loaded
  for (const child of group.children) {
    if (child.userData && child.userData.kind === 'furniture') present.set(child.userData.modelId, child);
  }

  // Drop furniture whose model record no longer exists (e.g. undo of an add, or a remove).
  for (const [id, obj] of present) {
    if (!wantIds.has(id)) {
      group.remove(obj);
      obj.traverse?.((n) => { n.geometry?.dispose?.(); if (n.material) { (Array.isArray(n.material) ? n.material : [n.material]).forEach((m) => m.dispose?.()); } });
    }
  }

  // Load any record that isn't in the scene yet.
  const toLoad = records.filter((f) => !present.has(f.id));
  return Promise.all(toLoad.map((f) => loadFurniture(f, group, levelElevById(f.levelId))));
}
