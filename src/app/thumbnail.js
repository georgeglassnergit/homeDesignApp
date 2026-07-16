// app/thumbnail.js — pure top-down SVG plan thumbnail of a template, for the S4 picker.
//
// Engine-free: maps a project's wall centerlines into a fitted, square viewBox so each
// starter shows what it actually looks like before you commit to it (novice-first
// onboarding — you pick a shape, not a name). Returns an SVG string; no Three.js, no DOM.
// Plan coords are {x, z}; z maps to the SVG y axis (top-down), so what you see here
// matches the plan panel's top-down orientation.

// Bounding box over every wall endpoint on every level. null if there are no walls.
export function wallsBounds(project) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, n = 0;
  for (const lvl of project.levels || []) {
    for (const w of lvl.walls || []) {
      for (const p of [w.a, w.b]) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
        n++;
      }
    }
  }
  return n ? { minX, maxX, minZ, maxZ } : null;
}

// Build an SVG string sized `size`×`size` with `pad` px of margin. A blank project
// (no walls) renders an empty framed grid so the "start from scratch" tile still reads.
export function planThumbnailSVG(project, { size = 132, pad = 12 } = {}) {
  const b = wallsBounds(project);
  const bg = '#efe9df', ink = '#6b5b4b', grid = '#d8c9b8';
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">`;
  const frame = `<rect x="0" y="0" width="${size}" height="${size}" fill="${bg}"/>`;

  if (!b) {
    // empty grid for the blank starter
    let g = '';
    for (let i = 1; i < 4; i++) {
      const t = pad + (i / 4) * (size - 2 * pad);
      g += `<line x1="${pad}" y1="${t.toFixed(1)}" x2="${size - pad}" y2="${t.toFixed(1)}" stroke="${grid}" stroke-width="1"/>`;
      g += `<line x1="${t.toFixed(1)}" y1="${pad}" x2="${t.toFixed(1)}" y2="${size - pad}" stroke="${grid}" stroke-width="1"/>`;
    }
    return `${head}${frame}${g}</svg>`;
  }

  const spanX = Math.max(b.maxX - b.minX, 1e-3);
  const spanZ = Math.max(b.maxZ - b.minZ, 1e-3);
  const inner = size - 2 * pad;
  const s = inner / Math.max(spanX, spanZ);      // uniform scale — keep aspect ratio
  // centre the drawing inside the padded box
  const offX = pad + (inner - spanX * s) / 2;
  const offZ = pad + (inner - spanZ * s) / 2;
  const mapX = (x) => (offX + (x - b.minX) * s).toFixed(1);
  const mapY = (z) => (offZ + (z - b.minZ) * s).toFixed(1);

  let lines = '';
  for (const lvl of project.levels || []) {
    for (const w of lvl.walls || []) {
      lines += `<line x1="${mapX(w.a.x)}" y1="${mapY(w.a.z)}" x2="${mapX(w.b.x)}" y2="${mapY(w.b.z)}" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/>`;
    }
  }
  return `${head}${frame}${lines}</svg>`;
}
