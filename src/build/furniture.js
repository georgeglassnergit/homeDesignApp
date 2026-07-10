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
