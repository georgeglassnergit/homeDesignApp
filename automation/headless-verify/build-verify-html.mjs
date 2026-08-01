// Build verify.html: a byte-for-byte copy of index.html with an importmap injected so the
// SAME bare imports src/main.js uses under Vite ("three", "three/addons/*", "three-bvh-csg",
// "three-mesh-bvh") resolve to the vendored copies with no bundler. The scene code that runs
// here is the exact code Vite would build — the harness adds nothing to the module graph.
// Output verify.html is .gitignored (build scaffold). Run from repo root.
import { readFileSync, writeFileSync } from 'fs';

const html = readFileSync('index.html', 'utf8');
const MAIN = '<script type="module" src="/src/main.js"></script>';
if (!html.includes(MAIN)) { console.error('index.html no longer loads /src/main.js as expected'); process.exit(1); }

const importmap = `<script type="importmap">
    {
      "imports": {
        "three": "/three/build/three.module.js",
        "three/addons/": "/three/examples/jsm/",
        "three-bvh-csg": "/three-bvh-csg/src/index.js",
        "three-mesh-bvh": "/three-mesh-bvh/src/index.js"
      }
    }
    </script>
    `;

writeFileSync('verify.html', html.replace(MAIN, importmap + MAIN));
console.log('verify.html written');
