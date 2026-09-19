// C2 slice probe — mitred wall corners in the REAL rebuilt scene graph.
//
// Group C's "clean corners": walls are stored as centrelines and were built as independent
// overlapping boxes. C2 wires the pure `core/wallJoin.js` mitre engine into the view so
// adjoining wall prisms meet along a single seam — gap-free AND non-overlapping. This probe
// proves the VIEW now extrudes those mitred quads (not plain boxes) and that the Phase-0
// caveat holds: the CSG-cut openings survive the change (walls with openings still have holes).
//
// The sample home is a closed 8×6 rectangle (south/east/north/west) + a central partition.
// Its four outer corners each join exactly two walls → all four mitre; the partition's ends
// touch no other wall endpoint → they stay square (the safe watertight fallback). We compute
// the expected mitred footprints in Node with the SAME pure engine, then read the rendered
// wall meshes' footprint corners from the browser and check they match.
import { sampleHome } from '../../../src/templates/sampleHome.js';
import { joinWalls, wallQuad } from '../../../src/core/wallJoin.js';

const R = (v) => Math.round(v * 1000) / 1000;                 // round to 1 mm
const key = (p) => `${R(p.x)},${R(p.z)}`;
const near = (set, p, tol = 2e-3) => {
  for (const s of set) { const [x, z] = s.split(',').map(Number); if (Math.abs(x - p.x) <= tol && Math.abs(z - p.z) <= tol) return true; }
  return false;
};

export async function run(page) {
  // Expected footprints from the pure engine (mitred) and the plain rectangles (C2-off oracle).
  const proj = sampleHome();
  const walls = proj.levels[0].walls;                          // [south, east, north, west, partition]
  const names = ['south', 'east', 'north', 'west', 'partition'];
  const joined = joinWalls(walls);
  const expect = {};                                           // name → { id, mitred:[{x,z}], plain:[{x,z}] }
  walls.forEach((w, i) => { expect[names[i]] = { id: w.id, mitred: joined[i].quad, plain: wallQuad(w) }; });

  // Read the rendered wall meshes' world-space footprint vertices + triangle counts.
  const rendered = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const home = window.__home;
    const out = {};
    home.traverse((o) => {
      if (!o.isMesh || o.userData.kind !== 'wall' || !o.userData.modelId) return; // skip gable infill (no modelId)
      o.updateMatrixWorld(true);
      const g = o.geometry; const pos = g.getAttribute('position');
      const verts = new Set();
      const m = o.matrixWorld.elements;
      let ymin = Infinity, ymax = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        // apply matrixWorld (column-major)
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        ymin = Math.min(ymin, wy); ymax = Math.max(ymax, wy);
        verts.add(`${Math.round(wx * 1000) / 1000},${Math.round(wz * 1000) / 1000}`);
      }
      out[o.userData.modelId] = { verts: [...verts], tris: (g.index ? g.index.count : pos.count) / 3, ymin, ymax };
    });
    return out;
  });

  const renderedFor = (name) => rendered[expect[name].id];
  const cornersPresent = (name, quad) => {
    const r = renderedFor(name); if (!r) return false;
    const set = new Set(r.verts);
    return quad.every((c) => near(set, c));
  };

  // Each mitred wall's four MITRED corners must be present in its rendered footprint,
  // and its distinctive PLAIN end corner (x=±4.0 at a mitred end) must be ABSENT — the
  // discriminator that proves the view genuinely mitred rather than drawing plain boxes.
  const mitredNames = ['south', 'east', 'north', 'west'];
  const allMitredMatch = mitredNames.every((n) => cornersPresent(n, expect[n].mitred));
  // south plain corner at exactly (4.0,-3.06) would exist only WITHOUT the mitre; confirm it's gone.
  const southSet = new Set((renderedFor('south') || { verts: [] }).verts);
  const southPlainCornerGone = !near(southSet, { x: 4.0, z: -3.06 }) && !near(southSet, { x: -4.0, z: -3.06 });

  // Gap-free & non-overlapping seam: at corner B(4,-3) south and east must TERMINATE at the
  // very same two mitre points — south.bR == east.aL and south.bL == east.aR (identical verts
  // in both meshes). Read them straight off the shared engine output and confirm both meshes carry them.
  const cornerB = [expect.south.mitred[1], expect.south.mitred[2]];   // south's b-end corners (bR, bL)
  const eastSet = new Set((renderedFor('east') || { verts: [] }).verts);
  const sharedSeam = cornerB.every((c) => near(southSet, c) && near(eastSet, c));

  // Partition keeps square ends (its quad == plain rectangle, corners at x=±0.06).
  const partitionSquare = cornersPresent('partition', expect.partition.mitred)
    && JSON.stringify(expect.partition.mitred) === JSON.stringify(expect.partition.plain);

  // CSG openings survive: the four walls with an opening have MORE triangles than the
  // no-opening west wall (a plain prism) — i.e. a hole was actually subtracted.
  const westTris = (renderedFor('west') || { tris: 0 }).tris;
  const openingWalls = ['south', 'east', 'north', 'partition'];
  const holesIntact = westTris > 0 && openingWalls.every((n) => (renderedFor(n) || { tris: 0 }).tris > westTris);

  // Every wall prism stands the full storey height (0 → 2.7 m) — extrude + stand-up correct.
  const heightsOk = names.every((n) => { const r = renderedFor(n); return r && Math.abs(r.ymin) < 1e-3 && Math.abs(r.ymax - walls[0].height) < 1e-3; });

  return {
    log: {
      westTris,
      tris: Object.fromEntries(names.map((n) => [n, (renderedFor(n) || {}).tris])),
      cornerB: cornerB.map((c) => `(${R(c.x)},${R(c.z)})`),
    },
    checks: [
      ['C2: all 5 wall meshes rendered', names.every((n) => !!renderedFor(n))],
      ['C2: every mitred wall extrudes its MITRED footprint (matches wallJoin)', allMitredMatch],
      ['C2: the plain-box end corner (x=±4.0) is gone → genuinely mitred, not a box', southPlainCornerGone],
      ['C2: adjoining walls share the SAME seam points (gap-free & non-overlapping)', sharedSeam],
      ['C2: the free-ended partition keeps square ends (safe watertight fallback)', partitionSquare],
      ['C2: CSG openings survive the mitre change (walls with a hole have more tris)', holesIntact],
      ['C2: every wall prism stands the full storey height (extrude/stand-up correct)', heightsOk],
    ],
  };
}
