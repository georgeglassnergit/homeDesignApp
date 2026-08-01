// Regenerate three-mesh-bvh's *.generated.js from its *.template.js — WITHOUT npm.
//
// three-mesh-bvh ships template files that its own build expands with the `preprocess`
// npm package into two siblings each: a "direct" `.generated.js` and an `_indirect.generated.js`.
// npm and CDNs are blocked in the daily-run environment, so we can't run its rollup build.
// This is a self-contained replica of the exact `preprocess` directives v0.7.6 uses:
//
//   /* @echo INDIRECT_STRING */                                -> the value of INDIRECT_STRING
//   /* @if INDIRECT */ A /* @else */ B /* @endif */            -> A when INDIRECT, else B
//
// Run from repo root AFTER cloning three-mesh-bvh (see vendor-deps.sh):
//   node automation/headless-verify/gen-meshbvh-generated.mjs
//
// It writes both variants next to each template. Idempotent; safe to re-run.
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const root = process.argv[2] || 'three-mesh-bvh';
const templates = execSync(`find ${root}/src -name "*.template.js"`).toString().trim().split('\n').filter(Boolean);

function preprocess(code, env) {
  // Resolve innermost @if...@endif blocks (no nested @if inside) until none remain.
  const ifRe = /\/\*\s*@if\s+(\w+)\s*\*\/((?:(?!\/\*\s*@(?:if|endif)\b)[\s\S])*?)(?:\/\*\s*@else\s*\*\/((?:(?!\/\*\s*@(?:if|endif)\b)[\s\S])*?))?\/\*\s*@endif\s*\*\//;
  let prev;
  do { prev = code; code = code.replace(ifRe, (m, cond, t, f) => (env[cond] ? t : (f || ''))); } while (code !== prev);
  return code.replace(/\/\*\s*@echo\s+(\w+)\s*\*\//g, (m, v) => (v in env ? env[v] : ''));
}

let count = 0;
for (const input of templates) {
  const src = readFileSync(input, 'utf8');
  const name = input.split(/[/\\]/).pop();
  const stars = '*'.repeat(name.length);
  const header = `/***********************************${stars}/\n/* This file is generated from "${name}". */\n/***********************************${stars}/\n`;
  for (const [suffix, env] of [
    ['.generated.js', { INDIRECT: false, INDIRECT_STRING: '' }],
    ['_indirect.generated.js', { INDIRECT: true, INDIRECT_STRING: '_indirect' }],
  ]) {
    writeFileSync(input.replace(/\.template\.js$/, suffix), header + preprocess(src, env));
    count++;
  }
}
// Fail loudly if any macro survived — a leftover directive means a broken import at runtime.
const leftover = execSync(`grep -rlE "@(if|else|endif|echo)" ${root}/src --include="*.generated.js" || true`).toString().trim();
if (leftover) { console.error('ERROR: unexpanded macros remain in:\n' + leftover); process.exit(1); }
console.log(`generated ${count} files, no unexpanded macros`);
