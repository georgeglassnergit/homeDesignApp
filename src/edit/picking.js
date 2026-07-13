// edit/picking.js — VIEW-LAYER-CONTRACT.md §2. The Three.js half of selection:
// a screen point -> the model object under it, read from the userData Phase 1 stamps
// on every generated mesh. No model mutation happens here.
//
// This is the ONLY file in edit/ that imports three; the interaction logic
// (commands/history/tools/planView) stays engine-independent on purpose.
import * as THREE from 'three';

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

// ndc: pointer in normalized device coords ({x,y} in [-1,1]). root: the home Group.
// Returns { modelId, kind, point } of the first generated mesh hit, or null.
export function raycast(ndc, camera, root) {
  _ndc.set(ndc.x, ndc.y);
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(root.children, true);
  for (const h of hits) {
    // walk up to the generated mesh that carries the model stamp
    let o = h.object;
    while (o && o.userData.kind === undefined && o !== root) o = o.parent;
    if (o && o.userData && o.userData.kind) {
      return { modelId: o.userData.modelId ?? null, kind: o.userData.kind, point: h.point };
    }
  }
  return null;
}

// Convenience: DOM pointer event + canvas rect -> NDC.
export function eventToNDC(event, domElement) {
  const rect = domElement.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
  };
}
