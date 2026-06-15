// wysiwyg-authorship.mjs — node tests for wysiwygAuthorship.ts.
//
// Pins the five observable contracts of attachChangeLog :
//   1. attachChangeLog on a fresh Y.Doc returns a ChangeLog whose
//      pending() is the empty array.
//   2. recordChange(...) pushes one entry into the underlying
//      Y.Array AND pending() returns it.
//   3. accept(id) removes the record so pending() no longer sees it.
//   4. reject(id) removes the record AND fires a
//      `weft-loom:rollback-change` window event carrying { id, before }.
//   5. Two clients each recording one change → after a Yjs state
//      handshake both clients see both records (CRDT convergence).
//
// We hand-roll the slice of `window` the reject() path actually
// pokes at : just dispatchEvent + a single registered listener.
// CustomEvent is also stubbed so dispatch(new CustomEvent(...))
// keeps a { type, detail } object the listener can inspect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';
import * as Y from '../web/node_modules/yjs/dist/yjs.cjs';

// ─── window/CustomEvent stub ───────────────────────────────────
//
// The module only uses :
//   - `typeof window !== 'undefined'`
//   - `window.dispatchEvent(new CustomEvent(name, { detail }))`
// and only at reject() time. We install a tiny event-bus stub so
// the listener-side assertion can intercept the dispatch.

class StubCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
}

function installWindow() {
  const listeners = new Map(); // type → Array<fn>
  const win = {
    addEventListener(type, fn) {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) ?? [];
      const next = arr.filter((f) => f !== fn);
      listeners.set(type, next);
    },
    dispatchEvent(ev) {
      const arr = listeners.get(ev.type) ?? [];
      for (const f of arr) {
        try { f(ev); } catch { /* swallow : test stub */ }
      }
      return true;
    },
  };
  globalThis.window = win;
  globalThis.CustomEvent = StubCustomEvent;
  return win;
}

// ─── Module loader ─────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/wysiwygAuthorship.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

// esbuild emits `require("yjs")` from `import * as Y from 'yjs'`.
// We satisfy it from a tiny require shim so the Y instance the
// module uses is the SAME one our test code imports (otherwise
// `instanceof Y.Doc` checks + cross-doc applyUpdate would break
// across realms).
const wrapped = `
${built.code}
module.exports = { attachChangeLog };
`;

function loadModule() {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', wrapped)(mod, mod.exports, (id) => {
    if (id === 'yjs') return Y;
    throw new Error('unexpected require: ' + id);
  });
  return mod.exports;
}

// ─── Tests ─────────────────────────────────────────────────────

test('attachChangeLog : returns an empty pending list on a fresh ydoc', () => {
  installWindow();
  const { attachChangeLog } = loadModule();

  const ydoc = new Y.Doc();
  const log = attachChangeLog(ydoc, 'doc.tex');

  assert.equal(log.pending().length, 0, 'fresh log should have no pending records');
  assert.ok(log.yarray, 'yarray handle should be exposed');
  assert.equal(log.yarray.length, 0, 'underlying Y.Array should be empty');

  log.destroy();
});

test('recordChange : pushes a record onto the Y.Array + pending() lists it', () => {
  installWindow();
  const { attachChangeLog } = loadModule();

  const ydoc = new Y.Doc();
  const log = attachChangeLog(ydoc, 'doc.tex');

  log.recordChange(42, 'alice', 'hsl(120, 60%, 50%)',
    '\\section{Intro}\nHello.',
    '\\section{Intro}\nHello, world.',
  );

  const list = log.pending();
  assert.equal(list.length, 1, 'pending should have exactly one entry');
  const rec = list[0];
  assert.equal(rec.clientID, 42);
  assert.equal(rec.author, 'alice');
  assert.equal(rec.color, 'hsl(120, 60%, 50%)');
  assert.equal(rec.before, '\\section{Intro}\nHello.');
  assert.equal(rec.after, '\\section{Intro}\nHello, world.');
  assert.equal(rec.status, 'pending');
  assert.ok(typeof rec.id === 'string' && rec.id.length > 0, 'record should have a non-empty id');
  assert.ok(typeof rec.at === 'number' && rec.at > 0, 'record should have a timestamp');

  // No-op when before === after.
  log.recordChange(42, 'alice', 'hsl(120, 60%, 50%)', 'same', 'same');
  assert.equal(log.pending().length, 1, 'identity edit should not be logged');

  log.destroy();
});

test('accept : drops the record from pending() without touching the source', () => {
  installWindow();
  const { attachChangeLog } = loadModule();

  const ydoc = new Y.Doc();
  const log = attachChangeLog(ydoc, 'doc.tex');

  log.recordChange(1, 'a', '#fff', 'before-a', 'after-a');
  log.recordChange(2, 'b', '#000', 'before-b', 'after-b');
  assert.equal(log.pending().length, 2);

  const first = log.pending()[1]; // pending() is newest-first ; take the older one
  log.accept(first.id);

  const remaining = log.pending();
  assert.equal(remaining.length, 1, 'accept should drop one record');
  assert.notEqual(remaining[0].id, first.id, 'the dropped id should be gone');

  // accept on an unknown id is a no-op (idempotent).
  log.accept('nonexistent');
  assert.equal(log.pending().length, 1);

  log.destroy();
});

test('reject : drops the record AND fires weft-loom:rollback-change with { id, before }', () => {
  const win = installWindow();
  const { attachChangeLog } = loadModule();

  const ydoc = new Y.Doc();
  const log = attachChangeLog(ydoc, 'doc.tex');

  const events = [];
  const listener = (ev) => events.push(ev);
  win.addEventListener('weft-loom:rollback-change', listener);

  log.recordChange(7, 'carol', 'hsl(0, 70%, 50%)', 'original', 'edited');
  const rec = log.pending()[0];

  log.reject(rec.id);

  assert.equal(log.pending().length, 0, 'reject should drop the record');
  assert.equal(events.length, 1, 'reject should dispatch exactly one event');
  const ev = events[0];
  assert.equal(ev.type, 'weft-loom:rollback-change');
  assert.equal(ev.detail.id, rec.id);
  assert.equal(ev.detail.before, 'original');

  // reject on an unknown id is a no-op AND fires no event.
  log.reject('nonexistent');
  assert.equal(events.length, 1, 'unknown id reject must not dispatch');

  win.removeEventListener('weft-loom:rollback-change', listener);
  log.destroy();
});

test('two clients each recording a change → both see both records via Yjs sync', () => {
  installWindow();
  const { attachChangeLog } = loadModule();

  // Two ydocs share a "channel" only via explicit applyUpdate calls,
  // standing in for the WebsocketProvider relay. We sync forward +
  // backward at the end so both peers converge.
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const logA = attachChangeLog(docA, 'shared.tex');
  const logB = attachChangeLog(docB, 'shared.tex');

  logA.recordChange(101, 'alice', '#0a0', 'baseA', 'editA');
  logB.recordChange(202, 'bob',   '#00a', 'baseB', 'editB');

  // Before sync : each side sees only its own.
  assert.equal(logA.pending().length, 1);
  assert.equal(logB.pending().length, 1);

  // Cross-sync : the Yjs encodeStateAsUpdate(A) → applyUpdate(B)
  // dance is what the WS relay does on every transaction. We do it
  // by hand at the end to drive convergence.
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

  const pendingA = logA.pending();
  const pendingB = logB.pending();
  assert.equal(pendingA.length, 2, 'A should see both records after sync');
  assert.equal(pendingB.length, 2, 'B should see both records after sync');

  // Both peers should agree on the SET of clientIDs.
  const clientsA = new Set(pendingA.map((r) => r.clientID));
  const clientsB = new Set(pendingB.map((r) => r.clientID));
  assert.deepEqual([...clientsA].sort(), [101, 202]);
  assert.deepEqual([...clientsB].sort(), [101, 202]);

  // And on the SET of (before, after) source snapshots.
  const sourcesA = pendingA.map((r) => `${r.before}|${r.after}`).sort();
  const sourcesB = pendingB.map((r) => `${r.before}|${r.after}`).sort();
  assert.deepEqual(sourcesA, sourcesB);
  assert.deepEqual(sourcesA, ['baseA|editA', 'baseB|editB'].sort());

  logA.destroy();
  logB.destroy();
});
