// app/furnishTransport.js — the two thin browser-glue adapters the `furnish-photo-3d` view
// layer needs to drive the pure furnish controller (app/furnishController.js) from a real DOM:
//
//   1) makeProxyTransport(fetchImpl) — turns the app's `fetch` into the `transport` the pure
//      pipeline expects: a `(request) => Promise<{ ok, status, json() }>`. The pipeline hands it
//      a `{ url, method, headers, body }` request aimed at the SAME-ORIGIN proxy (`/api/furnish`);
//      this maps those fields straight onto `fetch`. A native `Response` already satisfies the
//      `{ ok, status, json() }` shape the pipeline reads, so the Response passes through untouched.
//      The provider key is NEVER involved here — the proxy injects it server-side (constraint #7);
//      this adapter only forwards the same-origin request the pipeline already built (and the
//      pipeline itself asserts it attaches no auth/api-key header).
//
//   2) readFileAsDataUrl(file, FileReaderImpl) — reads a picked image File to a base64 data URL,
//      the exact `image` input `furnishFromImage`/`runFurnishJob` validate and submit. FileReader
//      is INJECTED (defaults to the global) so this is unit-testable in plain Node with a fake —
//      keeping to the project's "every side effect injected, verified the pure way" discipline.
//
// Both are deliberately logic-light and dependency-free: NO Three.js, NO model imports, and they
// reach for no global unless a default is used, so the module imports cleanly under Node for CI.

// Wrap a `fetch`-like function as the pipeline's injected transport. The pipeline calls the
// returned function with `{ url, method, headers, body }` and reads `{ ok, status, json() }` off
// the result — exactly a `fetch(url, init)` → `Response`, so the mapping is 1:1 and the Response
// is returned as-is. We pass only the fields the pipeline sets (method/headers/body); a GET status
// poll carries no body, so we omit `body` when it is null/undefined (a GET with a body throws in
// the Fetch spec). `fetchImpl` is required and must be a function — reaching for a global `fetch`
// here would defeat the injection discipline and break Node CI.
export function makeProxyTransport(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('makeProxyTransport: a fetch-like function is required');
  }
  return function proxyTransport(request) {
    const req = request || {};
    const init = { method: req.method || 'GET', headers: req.headers || {} };
    if (req.body != null) init.body = req.body;
    return fetchImpl(req.url, init);
  };
}

// Read a File/Blob to a base64 data URL (`data:<mime>;base64,<...>`) — the image form the furnish
// pipeline accepts and validates. Resolves with the string; rejects if no file is given, if the
// read errors, or if the reader yields a non-string result. FileReaderImpl defaults to the global
// `FileReader` (present in every browser) but is injectable so CI can drive a synchronous fake.
export function readFileAsDataUrl(file, FileReaderImpl) {
  const Reader = FileReaderImpl || (typeof FileReader !== 'undefined' ? FileReader : null);
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('readFileAsDataUrl: no file provided')); return; }
    if (typeof Reader !== 'function') { reject(new Error('readFileAsDataUrl: no FileReader available')); return; }
    const reader = new Reader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('readFileAsDataUrl: reader did not return a data URL string'));
    };
    reader.onerror = () => reject(reader.error || new Error('readFileAsDataUrl: failed to read file'));
    reader.readAsDataURL(file);
  });
}
