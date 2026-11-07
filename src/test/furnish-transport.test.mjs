// Tests for app/furnishTransport.js — the two browser-glue adapters that let the view layer
// drive the pure furnish controller. Both are exercised with fakes (no real fetch, no real
// FileReader), proving they map inputs correctly and that the transport output round-trips back
// through the real pipeline helpers that produce/consume it — so the two halves are proven to
// AGREE, not just individually plausible.

import assert from 'node:assert/strict';
import { makeProxyTransport, readFileAsDataUrl } from '../app/furnishTransport.js';
import { buildSubmitRequest, buildStatusRequest } from '../core/furnishPipeline.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); failed++; }
}

// ---- makeProxyTransport -----------------------------------------------------

test('makeProxyTransport requires a function', () => {
  assert.throws(() => makeProxyTransport(), /fetch-like function is required/);
  assert.throws(() => makeProxyTransport(null), /fetch-like function is required/);
  assert.throws(() => makeProxyTransport({}), /fetch-like function is required/);
  assert.equal(typeof makeProxyTransport(() => {}), 'function');
});

await testAsync('maps a POST submit request onto fetch(url, {method,headers,body})', async () => {
  const calls = [];
  const fakeResponse = { ok: true, status: 200, json: async () => ({ jobId: 'job-1' }) };
  const transport = makeProxyTransport((url, init) => { calls.push({ url, init }); return Promise.resolve(fakeResponse); });

  // Build the REAL request the pipeline would hand the transport.
  const req = buildSubmitRequest('data:image/png;base64,AAAA');
  const res = await transport(req);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, req.url);              // same-origin relative path, verbatim
  assert.equal(calls[0].url, '/api/furnish');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, req.headers);
  assert.equal(calls[0].init.body, req.body);       // JSON string passed through untouched
  assert.equal(res, fakeResponse);                  // Response returned as-is ({ok,status,json()})
});

await testAsync('omits body on a GET status poll (a GET with a body is illegal in fetch)', async () => {
  let seen = null;
  const transport = makeProxyTransport((url, init) => { seen = { url, init }; return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }); });

  const req = buildStatusRequest('job-xyz');
  await transport(req);

  assert.equal(seen.url, req.url);
  assert.equal(seen.url, '/api/furnish/job-xyz');
  assert.equal(seen.init.method, 'GET');
  assert.ok(!('body' in seen.init), 'GET init must carry no body key');
});

await testAsync('defaults method to GET and headers to {} for a bare request', async () => {
  let seen = null;
  const transport = makeProxyTransport((url, init) => { seen = { url, init }; return Promise.resolve({ ok: true, status: 200 }); });
  await transport({ url: '/api/furnish/x' });
  assert.equal(seen.init.method, 'GET');
  assert.deepEqual(seen.init.headers, {});
  assert.ok(!('body' in seen.init));
});

await testAsync('the transport never injects an auth / api-key header', async () => {
  let seen = null;
  const transport = makeProxyTransport((url, init) => { seen = { url, init }; return Promise.resolve({ ok: true, status: 200, json: async () => ({ jobId: 'j' }) }); });
  await transport(buildSubmitRequest('data:image/jpeg;base64,BBBB'));
  const keys = Object.keys(seen.init.headers).map((k) => k.toLowerCase());
  for (const forbidden of ['authorization', 'x-api-key', 'api-key', 'x-meshy-key']) {
    assert.ok(!keys.includes(forbidden), `must not carry ${forbidden}`);
  }
});

await testAsync('a rejected fetch propagates (pipeline treats it as a transient blip)', async () => {
  const transport = makeProxyTransport(() => Promise.reject(new Error('network down')));
  await assert.rejects(() => transport(buildStatusRequest('j')), /network down/);
});

// ---- readFileAsDataUrl ------------------------------------------------------

// A minimal synchronous FileReader stand-in whose readAsDataURL fires onload with a fixed result.
function fakeReaderClass(result, { error } = {}) {
  return class FakeReader {
    readAsDataURL(file) {
      queueMicrotask(() => {
        if (error) { this.error = error; this.onerror && this.onerror(); return; }
        this.result = typeof result === 'function' ? result(file) : result;
        this.onload && this.onload();
      });
    }
  };
}

await testAsync('reads a file to its data URL string via the injected reader', async () => {
  const dataUrl = 'data:image/png;base64,ZZZZ';
  const url = await readFileAsDataUrl({ name: 'x.png' }, fakeReaderClass(dataUrl));
  assert.equal(url, dataUrl);
});

await testAsync('rejects when no file is provided', async () => {
  await assert.rejects(() => readFileAsDataUrl(null, fakeReaderClass('x')), /no file provided/);
});

await testAsync('rejects when no FileReader is available', async () => {
  await assert.rejects(() => readFileAsDataUrl({ name: 'x' }, null), /no FileReader available/);
});

await testAsync('rejects on a reader error', async () => {
  await assert.rejects(
    () => readFileAsDataUrl({ name: 'x' }, fakeReaderClass(null, { error: new Error('read boom') })),
    /read boom/,
  );
});

await testAsync('rejects when the reader yields a non-string result', async () => {
  await assert.rejects(
    () => readFileAsDataUrl({ name: 'x' }, fakeReaderClass(new ArrayBuffer(4))),
    /did not return a data URL string/,
  );
});

await testAsync('the data URL it yields is accepted by the real pipeline submit builder', async () => {
  // end-to-end agreement: a file read here produces an image the pipeline validates + submits.
  const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/';
  const url = await readFileAsDataUrl({ name: 'photo.jpg' }, fakeReaderClass(dataUrl));
  const req = buildSubmitRequest(url);                       // throws if the image is unusable
  assert.equal(req.method, 'POST');
  assert.ok(req.body.includes(dataUrl), 'submit body carries the read data URL');
});

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
