// edit/picking.js — STUB (UNVERIFIED: needs Three.js + the Phase 0/1 environment).
// See VIEW-LAYER-CONTRACT.md §2. Maps a screen point to the model object under it.
// import * as THREE from 'three';

/**
 * @returns {{modelId:string, kind:string}|null}
 */
export function raycast(/* pointerEvent, camera, scene */) {
  // TODO: build a THREE.Raycaster from the pointer + camera, intersect the
  // generated meshes, and return the first hit's userData {modelId, kind}.
  // No model mutation happens here.
  throw new Error('picking.raycast: not implemented (view layer — see VIEW-LAYER-CONTRACT.md)');
}
