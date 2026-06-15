// ybinding-wysiwyg.mjs — node tests for ybindingWysiwyg.ts.
//
// Pins the four observable contracts :
//   1. Seed local → remote : attach with empty ytext + populated
//      innerHTML pushes innerHTML into ytext.
//   2. Seed remote → local : attach with populated ytext + empty
//      innerHTML writes ytext.toString() into the host.
//   3. Local DOM mutation → ytext (after debounce window).
//   4. Remote ytext.applyUpdate from a peer ydoc → host.innerHTML
//      updates without re-triggering the MutationObserver back into
//      a feedback loop (the local transactions counter doesn't move).
//
// jsdom is NOT installed in this workspace ; we hand-roll the slice
// of DOM the binding actually touches (HTMLElement.innerHTML getter+
// setter, MutationObserver with observe/disconnect/takeRecords). The
// MutationObserver stub schedules callbacks via queueMicrotask so the
// observer→debounce→ytext.transact pipeline matches the real-browser
// ordering of "DOM op → microtask → 50ms timer → CRDT op".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';
import * as Y from '../web/node_modules/yjs/dist/yjs.cjs';

// ─── DOM stub ────────────────────────────────────────────────────
//
// We don't need a full DOM. The binding only ever touches :
//   - host.innerHTML (get + set)
//   - new MutationObserver(cb) + observe(target, opts)
//   - mo.disconnect() + mo.takeRecords()
//
// innerHTML is implemented as a plain string getter/setter on the
// stub element ; setting it fires a synthetic MutationRecord on
// every MutationObserver currently observing the element. That's
// sufficient to drive the binding through its observe→debounce→
// ytext.transact pipeline.

class StubElement {
  constructor(html = '') {
    this._html = html;
    this._observers = new Set();
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    const next = String(v);
    if (next === this._html) return;
    this._html = next;
    // Notify every observer attached to this element. The real
    // MutationObserver queues records + flushes them asynchronously
    // ; we mimic via queueMicrotask so the binding's debounce timer
    // gets a chance to coalesce bursts that happen in the same tick.
    for (const obs of this._observers) {
      obs._enqueue({ type: 'childList', target: this });
    }
  }
}

class StubMutationObserver {
  constructor(cb) {
    this._cb = cb;
    this._targets = new Set();
    this._pending = [];
    this._flushScheduled = false;
  }
  observe(target /* , _opts */) {
    this._targets.add(target);
    target._observers.add(this);
  }
  disconnect() {
    for (const t of this._targets) {
      t._observers.delete(this);
    }
    this._targets.clear();
    // Per-spec : disconnect leaves pending records in place ; they
    // can still be drained by takeRecords().
  }
  takeRecords() {
    const out = this._pending;
    this._pending = [];
    return out;
  }
  _enqueue(record) {
    this._pending.push(record);
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    queueMicrotask(() => {
      this._flushScheduled = false;
      if (this._pending.length === 0) return;
      const records = this._pending;
      this._pending = [];
      try { this._cb(records, this); } catch { /* swallow : test stub */ }
    });
  }
}

function installDom() {
  globalThis.MutationObserver = StubMutationObserver;
  globalThis.HTMLElement = StubElement;
}

// ─── Module loader ───────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/ybindingWysiwyg.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

// Inject the SAME Y instance the test file pulled in (otherwise
// `instanceof Y.Doc` would fail across realms). esbuild emits
// `require("yjs")` from `import * as Y from 'yjs'` ; we satisfy it
// from a tiny require shim.
const wrapped = `
${built.code}
module.exports = { yjsWysiwygBinding, YORIGIN_LOCAL };
`;

function loadModule() {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', wrapped)(mod, mod.exports, (id) => {
    if (id === 'yjs') return Y;
    throw new Error('unexpected require: ' + id);
  });
  return mod.exports;
}

// Helper : wait long enough for the MutationObserver microtask + the
// 50ms debounce timer to fire.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ───────────────────────────────────────────────────────

test('attach : empty ytext + populated host → ytext mirrors host innerHTML', () => {
  installDom();
  const { yjsWysiwygBinding } = loadModule();

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('body');
  const host = new StubElement('<p>hello <strong>world</strong></p>');

  assert.equal(ytext.length, 0, 'ytext should start empty');

  const binding = yjsWysiwygBinding(ytext, ydoc);
  const destroy = binding.attach(host);

  assert.equal(ytext.toString(), '<p>hello <strong>world</strong></p>',
    'ytext should be seeded from host.innerHTML');
  destroy();
});

test('attach : populated ytext + empty host → host innerHTML matches ytext', () => {
  installDom();
  const { yjsWysiwygBinding, YORIGIN_LOCAL } = loadModule();

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('body');
  // Seed ytext under a non-local origin so attach() observers
  // never mis-classify the seed as a remote op.
  ydoc.transact(() => {
    ytext.insert(0, '<h1>Title</h1><p>Body.</p>');
  }, 'test-seed');
  const host = new StubElement('');

  const binding = yjsWysiwygBinding(ytext, ydoc);
  const destroy = binding.attach(host);

  assert.equal(host.innerHTML, '<h1>Title</h1><p>Body.</p>',
    'host should be seeded from ytext.toString()');
  // And critically : the act of writing host.innerHTML must NOT
  // bounce back into ytext under YORIGIN_LOCAL. We use the local-
  // transaction counter as a probe : observe(yfn) with a guard.
  let bounced = false;
  ytext.observe((_ev, tr) => { if (tr.origin === YORIGIN_LOCAL) bounced = true; });
  // Wait past the debounce window to confirm no late echo.
  return sleep(80).then(() => {
    assert.equal(bounced, false, 'seed write must not echo back as YORIGIN_LOCAL');
    destroy();
  });
});

test('local DOM mutation → ytext updates after debounce window', async () => {
  installDom();
  const { yjsWysiwygBinding } = loadModule();

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('body');
  const host = new StubElement('<p>initial</p>');

  const binding = yjsWysiwygBinding(ytext, ydoc);
  const destroy = binding.attach(host);

  // Confirm seed.
  assert.equal(ytext.toString(), '<p>initial</p>');

  // Now mutate the host as if the user typed.
  host.innerHTML = '<p>edited content</p>';

  // Before debounce window : ytext is still stale.
  assert.equal(ytext.toString(), '<p>initial</p>',
    'ytext should not update synchronously');

  // After debounce window : ytext has caught up.
  await sleep(80);
  assert.equal(ytext.toString(), '<p>edited content</p>',
    'ytext should pick up the local DOM mutation post-debounce');

  destroy();
});

test('remote ytext insert → host.innerHTML updates without local feedback loop', async () => {
  installDom();
  const { yjsWysiwygBinding, YORIGIN_LOCAL } = loadModule();

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('body');
  const host = new StubElement('<p>start</p>');

  const binding = yjsWysiwygBinding(ytext, ydoc);
  const destroy = binding.attach(host);

  // Wait for seed to settle.
  await sleep(80);
  assert.equal(ytext.toString(), '<p>start</p>');

  // Track local transactions AFTER seed.
  let localOps = 0;
  ytext.observe((_ev, tr) => {
    if (tr.origin === YORIGIN_LOCAL) localOps++;
  });

  // Simulate a peer by building a second ydoc, mutating it under a
  // different origin, and applying its state update to ours.
  const peer = new Y.Doc();
  const peerText = peer.getText('body');
  // Mirror current state into the peer first so we're starting from
  // the same baseline (otherwise the peer would overwrite with empty).
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  assert.equal(peerText.toString(), '<p>start</p>',
    'peer should hold same state after sync');

  peer.transact(() => {
    peerText.delete(0, peerText.length);
    peerText.insert(0, '<p>from remote peer</p>');
  }, 'peer-origin');

  // Apply the peer's update to our local ydoc. The yObserver should
  // pick this up, disconnect MO, write host.innerHTML, reconnect.
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));

  assert.equal(host.innerHTML, '<p>from remote peer</p>',
    'host.innerHTML should reflect the remote insert');

  // The MutationObserver disconnect-around-innerHTML logic + the
  // YORIGIN_LOCAL filter MUST conspire to keep localOps at 0. If
  // either is broken, the synthetic mutation from `host.innerHTML=`
  // would flush a YORIGIN_LOCAL transaction within the debounce
  // window.
  await sleep(80);
  assert.equal(localOps, 0,
    'remote apply must NOT echo back as a local transaction');
  // And ytext is still the remote value, not something stale.
  assert.equal(ytext.toString(), '<p>from remote peer</p>');

  destroy();
});
