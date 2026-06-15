// upload-image.mjs — node tests for uploadImage.ts. Stubs the
// browser surfaces the module touches : global fetch (so the
// writeFile PUT is observable), URL.createObjectURL +
// URL.revokeObjectURL, and Image (so measureImage resolves
// without a real decoder).
//
// Same esbuild-compile-then-eval pattern as
// latex-wysiwyg-roundtrip.mjs : robust against any TS syntax,
// no regex-strip hacks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

const here = dirname(fileURLToPath(import.meta.url));

// Bundle uploadImage.ts AND its api.ts dep into a single CJS
// module — esbuild.transformSync only handles a single source ;
// for the import graph we need esbuild.buildSync with bundle:true.
// We use stdin so we can inject a tiny re-export shim that
// surfaces the symbols we test.
const entryShim = `
  import { uploadImageFile, wireImageDrop } from '${resolve(here, '../web/src/lib/uploadImage.ts').replace(/\\/g, '/')}';
  module.exports = { uploadImageFile, wireImageDrop };
`;

const built = esbuild.buildSync({
  stdin: {
    contents: entryShim,
    resolveDir: resolve(here, '..'),
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  write: false,
  // openapi-fetch is imported by api.ts ; mark it external so
  // esbuild doesn't try to bundle the whole openapi runtime —
  // we never call api.GET/POST from the upload path, so the
  // import resolving to a stub is fine.
  external: ['openapi-fetch'],
});

const code = built.outputFiles[0].text;

// Provide a tiny stub for openapi-fetch since esbuild marked it
// external. esbuild wraps the require() in __toESM, which expects
// a CJS module-exports shape (function or object) and synthesizes
// the `.default` property. So we return the function directly,
// not wrapped in `{ default: ... }`.
const openapiFetchStub = () => ({ GET: () => {}, POST: () => {}, PUT: () => {} });

const module = { exports: {} };
new Function('module', 'exports', 'require', code)(module, module.exports, (req) => {
  if (req === 'openapi-fetch') return openapiFetchStub;
  // Anything else delegates to the node test's require — but the
  // bundled code shouldn't reach for any other external (we
  // bundled the whole TS graph).
  throw new Error(`unexpected require(${JSON.stringify(req)}) from bundled code`);
});
const { uploadImageFile, wireImageDrop } = module.exports;

// ─── stubs ──────────────────────────────────────────────────

// fetch stub : records every call ; returns a 200 ok by
// default. Tests can swap `fetchImpl` if they need to fail.
let fetchCalls = [];
let fetchImpl = async (url, init) => {
  fetchCalls.push({ url, init });
  return {
    ok: true,
    status: 200,
    text: async () => '',
  };
};
globalThis.fetch = (url, init) => fetchImpl(url, init);

// URL.createObjectURL : node 20 has a URL class but no Blob URL
// support. Just hand back a sentinel string.
let objUrlCount = 0;
globalThis.URL.createObjectURL = (_blob) => `blob:stub-${++objUrlCount}`;
globalThis.URL.revokeObjectURL = (_url) => {};

// Image stub : fires onload on next microtask with width/height
// pre-set. Lets measureImage resolve without a real decoder.
globalThis.Image = class StubImage {
  constructor() {
    this.naturalWidth = 640;
    this.naturalHeight = 480;
    this.width = 640;
    this.height = 480;
    this.onload = null;
    this.onerror = null;
  }
  set src(_v) {
    // Defer to next tick so onload assignment after `new Image()`
    // wins — mirrors browser semantics where the image isn't
    // synchronously decoded.
    queueMicrotask(() => this.onload && this.onload());
  }
};

// File polyfill : node 20 has a global File (web-compat), but
// some node 20.x patches lag — fall back to a minimal stub if
// missing. We only need .name, .type, and Blob-ness for fetch.
const FileCtor = globalThis.File ?? class File extends Blob {
  constructor(parts, name, opts = {}) {
    super(parts, opts);
    this.name = name;
    this.lastModified = opts.lastModified ?? Date.now();
  }
};

// Minimal HTMLElement + DragEvent stand-ins. node doesn't ship
// DOM so we hand-roll just enough surface for addEventListener
// + dispatchEvent + defaultPrevented to work.
class StubEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this.dataTransfer = init.dataTransfer ?? null;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {}
}

class StubElement {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(ev) {
    const set = this.listeners.get(ev.type);
    if (set) for (const fn of set) fn(ev);
    return !ev.defaultPrevented;
  }
}

// Helper : wait until the upload + onInsert callback (or its
// failure path) has run. Two microtasks cover : 1) the awaited
// measureImage resolution, 2) the awaited writeFile + .then chain.
async function flush() {
  // A few macrotask flushes — uploadImageFile chains await
  // measureImage → await writeFile → resolve ; each await is
  // a microtask hop, and writeFile awaits the fetch result too.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function resetFetch() {
  fetchCalls = [];
  fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return { ok: true, status: 200, text: async () => '' };
  };
}

// ─── tests ──────────────────────────────────────────────────

test('uploadImageFile : PUTs to figs/dropped-<ts>-<r>.<ext>', async () => {
  resetFetch();
  const file = new FileCtor([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
  const result = await uploadImageFile('proj1', file);

  assert.equal(fetchCalls.length, 1);
  const { url, init } = fetchCalls[0];
  assert.equal(init.method, 'PUT');
  // /api/projects/proj1/files/figs/dropped-<digits>-<4chars>.png
  assert.match(url, /^\/api\/projects\/proj1\/files\/figs\/dropped-\d+-[a-z0-9]{1,4}\.png$/);
  // Path returned matches the URL tail (after /files/).
  assert.match(result.path, /^figs\/dropped-\d+-[a-z0-9]{1,4}\.png$/);
  assert.equal(result.width, 640);
  assert.equal(result.height, 480);
});

test('uploadImageFile : sniffs extension from file.type when name has none', async () => {
  resetFetch();
  // No extension on the name — clipboard pastes give names like
  // "image.png" usually, but some browsers hand back "" or "blob".
  const file = new FileCtor([new Uint8Array([1])], 'pasted', { type: 'image/jpeg' });
  const result = await uploadImageFile('p', file);
  assert.ok(result.path.endsWith('.jpg'), `expected .jpg suffix, got ${result.path}`);
});

test('uploadImageFile : svg+xml → .svg', async () => {
  resetFetch();
  const file = new FileCtor(['<svg/>'], 'anon', { type: 'image/svg+xml' });
  const result = await uploadImageFile('p', file);
  assert.ok(result.path.endsWith('.svg'));
});

test('wireImageDrop : dragover with Files has default prevented', () => {
  const host = new StubElement();
  const destroy = wireImageDrop(host, 'proj', () => {});

  const ev = new StubEvent('dragover', {
    cancelable: true,
    dataTransfer: { types: ['Files'], files: [] },
  });
  host.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);

  destroy();
});

test('wireImageDrop : drop with non-image file does NOT call onInsert', async () => {
  resetFetch();
  const host = new StubElement();
  let inserts = 0;
  const destroy = wireImageDrop(host, 'proj', () => {
    inserts++;
  });

  const txtFile = new FileCtor(['hello'], 'note.txt', { type: 'text/plain' });
  const ev = new StubEvent('drop', {
    cancelable: true,
    dataTransfer: { types: ['Files'], files: [txtFile] },
  });
  host.dispatchEvent(ev);
  await flush();

  assert.equal(inserts, 0, 'onInsert must not fire for text drops');
  assert.equal(fetchCalls.length, 0, 'no PUT must have been issued');

  destroy();
});

test('wireImageDrop : destroy unwires the listeners', async () => {
  resetFetch();
  const host = new StubElement();
  let inserts = 0;
  const destroy = wireImageDrop(host, 'proj', () => {
    inserts++;
  });

  // Unwire BEFORE the drop fires.
  destroy();

  const file = new FileCtor([new Uint8Array([1])], 'p.png', { type: 'image/png' });
  const ev = new StubEvent('drop', {
    cancelable: true,
    dataTransfer: { types: ['Files'], files: [file] },
  });

  host.dispatchEvent(ev);
  await flush();

  assert.equal(inserts, 0, 'onInsert must not fire after destroy()');
  assert.equal(fetchCalls.length, 0, 'no PUT must have been issued after destroy()');
});

test('wireImageDrop : drop with an image file DOES call onInsert with result', async () => {
  resetFetch();
  const host = new StubElement();
  let captured = null;
  const destroy = wireImageDrop(host, 'proj', (r) => {
    captured = r;
  });

  const file = new FileCtor([new Uint8Array([1])], 'pic.png', { type: 'image/png' });
  // Plain array : the upload code iterates with files[i] +
  // files.length, both of which work on a vanilla Array.
  const ev = new StubEvent('drop', {
    cancelable: true,
    dataTransfer: { types: ['Files'], files: [file] },
  });
  host.dispatchEvent(ev);
  await flush();

  assert.ok(captured, 'onInsert should have been called');
  assert.match(captured.path, /^figs\/dropped-\d+-[a-z0-9]{1,4}\.png$/);
  assert.equal(captured.width, 640);
  assert.equal(captured.height, 480);
  assert.equal(fetchCalls.length, 1);
  assert.equal(ev.defaultPrevented, true);

  destroy();
});
