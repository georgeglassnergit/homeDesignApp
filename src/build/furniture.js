import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const _loader = new GLTFLoader();

// Load a GLB and resolve its scene, REJECTING on any load failure. This is the verify loader the
// furnish flow passes to furnishFromImage's `loadGlb` hook: it proves the generated model actually
// loads before the furniture record is committed to the undo history (loadFurniture below instead
// swallows a load error — resolving null — because it is the place-into-scene path, where a late
// miss just means the object is absent, not that a commit must be rolled back).
export function loadGlbModel(src) {
  return new Promise((resolve, reject) => {
    _loader.load(
      src,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(new Error((err && err.message) || `could not load GLB ${src}`))
    );
  });
}

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
