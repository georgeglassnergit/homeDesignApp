#!/usr/bin/env bash
# Vendor the Three.js stack for headless view-layer verification — git clone only (npm/CDN blocked).
# Pins the exact combo the app builds against: three r169 + three-bvh-csg v0.0.17 + three-mesh-bvh v0.7.6.
# Run from the repo root:  bash automation/headless-verify/vendor-deps.sh
# The three vendored dirs are .gitignored (cloned per run, never committed).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "== three r169 =="
if [ ! -d three ]; then git clone --depth 1 --branch r169 https://github.com/mrdoob/three.js three; fi

echo "== three-bvh-csg v0.0.17 =="
if [ ! -d three-bvh-csg ]; then
  git clone --depth 1 https://github.com/gkjohnson/three-bvh-csg
  ( cd three-bvh-csg && git fetch --depth 1 origin tag v0.0.17 && git checkout -q v0.0.17 )
fi

echo "== three-mesh-bvh v0.7.6 =="
if [ ! -d three-mesh-bvh ]; then
  git clone --depth 1 https://github.com/gkjohnson/three-mesh-bvh
  ( cd three-mesh-bvh && git fetch --depth 1 origin tag v0.7.6 && git checkout -q v0.7.6 )
fi

echo "== regenerate meshbvh *.generated.js (no npm) =="
node automation/headless-verify/gen-meshbvh-generated.mjs

echo "== build verify.html (index.html + importmap) =="
node automation/headless-verify/build-verify-html.mjs

echo "vendored: three r169 / csg v0.0.17 / meshbvh v0.7.6 — ready for verify.mjs"
