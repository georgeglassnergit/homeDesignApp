// Generic headless view-layer verifier for the daily run. Boots the REAL app (verify.html →
// src/main.js over the vendored importmap) on the pre-installed Playwright Chromium under
// swiftshader, asserts the always-on invariants (zero console/page errors + the Phase 1
// regression: 5 walls / 4 CSG openings / rooms / GLB furniture / lossless save), runs an
// optional per-slice probe, and screenshots to docs/verification/<name>.png.
//
// Usage (from repo root, after vendor-deps.sh):
//   node automation/headless-verify/verify.mjs <screenshot-name> [--probe probes/<slice>.mjs]
//
// A probe module exports:  export async function run(page) { ... return { checks:[[name,bool],...] } }
// where `page` is the Playwright page with the app booted and its window.__* handles installed.
//
// WHY Playwright/CDP and not `chrome --screenshot ...`: the CLI screenshot path and any
// bash-detached / setsid launch get reaped instantly in this environment (a prior run lost a
// whole session to this). Playwright's CDP launch is reaped-proof here. Keep this path.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { extname, join, normalize } from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

// --- resolve playwright + the vendored Chromium from known env locations ---
const PW_CANDIDATES = ['/opt/node22/lib/node_modules/playwright/index.js', '/usr/lib/node_modules/playwright/index.js'];
const pwPath = PW_CANDIDATES.find(existsSync);
if (!pwPath) { console.error('playwright not found in', PW_CANDIDATES); process.exit(2); }
const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const CHROME_CANDIDATES = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
let chromePath = CHROME_CANDIDATES.find(existsSync);
if (!chromePath) {
  // fall back to any chromium-* chrome under the browsers path
  const { execSync } = require('child_process');
  chromePath = execSync('ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1').toString().trim();
}
if (!chromePath) { console.error('Chromium binary not found under /opt/pw-browsers'); process.exit(2); }

const shot = process.argv[2];
if (!shot) { console.error('usage: verify.mjs <screenshot-name> [--probe probes/x.mjs]'); process.exit(2); }
const probeIdx = process.argv.indexOf('--probe');
const probePath = probeIdx > -1 ? process.argv[probeIdx + 1] : null;

const ROOT = process.cwd();
const MIME = { '.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.json':'application/json','.css':'text/css','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.wasm':'application/wasm' };

// Static server rooted at the repo. Mirrors Vite dev in the two ways the app relies on:
// files in public/ are served at the root, and a bare /favicon.ico gets an empty 200 (else the
// browser's automatic probe 404s and trips the zero-errors gate).
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/x-icon' }); res.end(Buffer.alloc(0)); return; }
    if (p === '/') p = '/verify.html';
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    let buf;
    try { buf = await readFile(join(ROOT, rel)); }
    catch { buf = await readFile(join(ROOT, 'public', rel)); }  // Vite serves public/ at root
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('404 ' + req.url); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: chromePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message)));
page.on('requestfailed', (r) => errors.push('REQFAIL ' + r.url() + ' ' + (r.failure()?.errorText || '')));

await page.goto(`http://localhost:${port}/verify.html`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => typeof window.__project === 'function' && window.__project(), { timeout: 20000 });
await page.waitForTimeout(600);
await page.evaluate(() => window.__closePicker && window.__closePicker()); // dismiss the start-screen picker
await page.waitForTimeout(150);

// always-on Phase 1 regression
const selftest = await page.evaluate(() => window.__selftest());
const checks = [
  ['Phase1 regression: project valid', selftest.valid === true],
  ['Phase1 regression: save lossless (byte-identical)', selftest.lossless === true],
  ['Phase1 regression: 5 walls / 4 openings present', selftest.counts.walls === 5 && selftest.counts.openings === 4],
  ['Phase1 regression: GLB furniture in model', selftest.counts.furniture >= 1],
];

// per-slice probe
let probeLog = null;
if (probePath) {
  const mod = await import(pathToFileURL(join(ROOT, 'automation/headless-verify', probePath)).href);
  const out = await mod.run(page);
  for (const c of out.checks || []) checks.push(c);
  probeLog = out.log || null;
}

await page.screenshot({ path: `docs/verification/${shot}.png` });
await browser.close();
server.close();

checks.push(['zero console/page errors', errors.length === 0]);

console.log('=== HEADLESS VERIFICATION:', shot, '===');
if (probeLog) console.log('probe:', JSON.stringify(probeLog));
console.log('counts:', JSON.stringify(selftest.counts));
let pass = 0;
for (const [n, c] of checks) { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (c) pass++; }
console.log(`\n${pass}/${checks.length} checks passed → docs/verification/${shot}.png`);
if (errors.length) { console.log('--- ERRORS ---'); errors.slice(0, 20).forEach((e) => console.log(e)); }
process.exit(pass === checks.length ? 0 : 1);
