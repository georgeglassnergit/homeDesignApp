#!/usr/bin/env node
// Aggregate test runner for the whole engine-independent test suite.
//
// Runs every `src/test/*.test.mjs` suite plus the `phase2/` core suite in
// plain Node — no `npm install`, no bundler, no browser. This is deliberate:
// the pure core/edit/app/templates modules never import Three.js (Node has no
// `three` available, so a stray import would fail to load — that absence is
// itself the model/view separation guard the suites rely on). Because the
// suites are zero-dependency, CI can run them directly and fast.
//
// Each suite prints its own "N passed, M failed" line and exits non-zero on
// any failure. This runner keys pass/fail on the child exit code (the source
// of truth) and additionally echoes each suite's output, then exits non-zero
// if any suite failed — so `node automation/run-tests.mjs` is the single
// command CI and contributors run to prove the tree is green.

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Suite discovery: all src/test/*.test.mjs, then phase2's core suite.
const suites = [];
const srcTestDir = join(repoRoot, 'src', 'test');
if (existsSync(srcTestDir)) {
  for (const f of readdirSync(srcTestDir).sort()) {
    if (f.endsWith('.test.mjs')) suites.push(join(srcTestDir, f));
  }
}
const phase2Suite = join(repoRoot, 'phase2', 'test', 'phase2-core.test.mjs');
if (existsSync(phase2Suite)) suites.push(phase2Suite);

if (suites.length === 0) {
  console.error('run-tests: no test suites found — expected src/test/*.test.mjs');
  process.exit(1);
}

console.log(`run-tests: ${suites.length} suites, plain Node ${process.version}, no dependencies\n`);

let failedSuites = 0;
const failedNames = [];
const t0 = Date.now();

for (const suite of suites) {
  const rel = relative(repoRoot, suite);
  // Run each suite from its own directory so any relative reads resolve.
  const res = spawnSync(process.execPath, [suite], {
    cwd: dirname(suite),
    encoding: 'utf8',
  });
  const out = ((res.stdout || '') + (res.stderr || '')).trimEnd();
  if (out) console.log(out);
  if (res.status === 0) {
    console.log(`  ✓ ${rel}\n`);
  } else {
    failedSuites++;
    failedNames.push(rel);
    console.log(`  ✗ ${rel} (exit ${res.status})\n`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('─'.repeat(60));
if (failedSuites === 0) {
  console.log(`ALL SUITES PASS — ${suites.length}/${suites.length} green in ${secs}s`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failedSuites}/${suites.length} suites failed in ${secs}s`);
  for (const n of failedNames) console.log(`  · ${n}`);
  process.exit(1);
}
