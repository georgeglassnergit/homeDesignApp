// viewer/cutaway.js — PURE cutaway geometry decision. ZERO Three.js so it stays
// node-testable (importing it under Node is itself part of the separation guard).
//
// Cutaway view reveals the interior by hiding the roof and the walls between the camera
// and the building's interior. "Which walls" is a pure function of the wall centerlines
// and the camera's ground-plane (XZ) position: a wall occludes the interior when its
// midpoint sits on the camera-facing side of the building centre. The view layer applies
// the returned set to mesh.visible — it never mutates geometry, so object counts are stable.

// Centroid of all wall endpoints in the XZ ground plane.
export function wallsCenterXZ(walls) {
  let sx = 0, sz = 0, n = 0;
  for (const w of walls) {
    sx += w.a.x + w.b.x; sz += w.a.z + w.b.z; n += 2;
  }
  return n ? { x: sx / n, z: sz / n } : { x: 0, z: 0 };
}

// Ids of the walls to hide for a cutaway seen from `cameraXZ` ({x,z} in world/model XZ,
// which equals model XZ — the builder maps wall a/b straight to world x/z with no flip).
// A wall is hidden when the outward radial from centre to its midpoint points toward the
// camera: dot(normalize(mid-centre), normalize(camera-centre)) > threshold. threshold
// (~0.25) hides the one or two near walls that occlude, leaving the far walls to frame
// the interior. Degenerate radii (wall midpoint ≈ centre, or camera ≈ centre) never hide.
export function cutawayHiddenWalls(walls, cameraXZ, threshold = 0.25) {
  const c = wallsCenterXZ(walls);
  const cdx = cameraXZ.x - c.x, cdz = cameraXZ.z - c.z;
  const clen = Math.hypot(cdx, cdz);
  const hidden = new Set();
  if (clen < 1e-6) return hidden;            // camera directly over centre → hide nothing
  const cnx = cdx / clen, cnz = cdz / clen;
  for (const w of walls) {
    const mx = (w.a.x + w.b.x) / 2, mz = (w.a.z + w.b.z) / 2;
    const rdx = mx - c.x, rdz = mz - c.z;
    const rlen = Math.hypot(rdx, rdz);
    if (rlen < 1e-6) continue;               // wall through the centre → keep it
    if ((rdx / rlen) * cnx + (rdz / rlen) * cnz > threshold) hidden.add(w.id);
  }
  return hidden;
}
