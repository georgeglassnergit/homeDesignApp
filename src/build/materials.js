import * as THREE from 'three';

// Turn the project's plain material definitions into a registry of THREE materials.
export function makeMaterialRegistry(defs) {
  const reg = {};
  for (const [key, d] of Object.entries(defs || {})) {
    reg[key] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(d.color || '#cccccc'),
      roughness: d.roughness ?? 0.9,
      metalness: d.metalness ?? 0.0,
      side: THREE.DoubleSide,
    });
  }
  if (!reg.default) reg.default = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.9, side: THREE.DoubleSide });
  return reg;
}
