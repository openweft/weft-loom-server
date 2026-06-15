// wysiwyg-presence.mjs — node tests for wysiwygPresence.ts.
//
// Asserts the five observable contracts of wireWysiwygPresence :
//   1. Single peer in awareness → overlay div created with one
//      .wysiwyg-peer-caret.
//   2. Peer state {name: "alice", color: "hsl(120, 60%, 50%)"} →
//      caret has data-name + --peer-color set from the state.
//   3. Local clientID's state SKIPPED (we don't draw our own caret).
//   4. destroy() removes the overlay + unwires the awareness
//      listener.
//   5. Awareness state.change update → overlay updates without
//      leaking duplicate nodes.
//
// jsdom is not installed in this workspace ; we hand-roll the
// slice of DOM the module actually touches :
//   - parent.insertBefore / appendChild / removeChild
//   - element.classList, getAttribute / setAttribute, style.setProperty
//   - element.getBoundingClientRect (returns a fake rect we control)
//   - createTreeWalker(host, SHOW_TEXT) — only Text-node iteration
//   - createRange + setStart/setEnd/collapse + getBoundingClientRect
//   - requestAnimationFrame / cancelAnimationFrame stubs that fire
//     synchronously when the test calls flushRaf(), so we don't need
//     real time + the assertions land deterministically right after
//     each awareness change.
//
// Awareness comes from y-protocols/awareness (real impl, backed by
// a real Y.Doc) — that's tiny + has no DOM dependencies, so we use
// it as-is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';
import * as Y from '../web/node_modules/yjs/dist/yjs.cjs';
import { Awareness } from '../web/node_modules/y-protocols/dist/awareness.cjs';

// ─── DOM stub ────────────────────────────────────────────────────

// Minimal Node / Element / Text shims. We support only the surface
// the module actually pokes at.

class StubNode {
  constructor() {
    this.parentNode = null;
    this.children = [];
    this.nextSibling = null;
    this.previousSibling = null;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (this.children.length > 0) {
      const prev = this.children[this.children.length - 1];
      prev.nextSibling = child;
      child.previousSibling = prev;
    }
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    if (ref == null) return this.appendChild(child);
    const idx = this.children.indexOf(ref);
    if (idx === -1) return this.appendChild(child);
    child.parentNode = this;
    this.children.splice(idx, 0, child);
    const prev = idx > 0 ? this.children[idx - 1] : null;
    child.previousSibling = prev;
    if (prev) prev.nextSibling = child;
    child.nextSibling = ref;
    ref.previousSibling = child;
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx === -1) return child;
    this.children.splice(idx, 1);
    if (child.previousSibling) child.previousSibling.nextSibling = child.nextSibling;
    if (child.nextSibling) child.nextSibling.previousSibling = child.previousSibling;
    child.parentNode = null;
    child.previousSibling = null;
    child.nextSibling = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class StubText extends StubNode {
  constructor(value) {
    super();
    this.nodeType = 3; // TEXT_NODE
    this.nodeValue = value;
  }
}

class StubElement extends StubNode {
  constructor(tag = 'div') {
    super();
    this.nodeType = 1; // ELEMENT_NODE
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.attributes = new Map();
    this.style = makeStyle();
    // Allow tests to fake getBoundingClientRect for the host ;
    // children get a derived rect from textContent length so the
    // module's range measurement returns plausible coordinates.
    this._rect = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  getBoundingClientRect() {
    return { ...this._rect };
  }
  // Used by the production code to find Text descendants. We only
  // need a generator that yields text children in document order.
  // The TreeWalker stub uses this via _collectText below.
  _collectText(out) {
    for (const c of this.children) {
      if (c.nodeType === 3) out.push(c);
      else if (c.nodeType === 1) c._collectText(out);
    }
  }
  appendText(value) {
    return this.appendChild(new StubText(value));
  }
  get textContent() {
    const buf = [];
    this._collectText(buf);
    return buf.map((t) => t.nodeValue ?? '').join('');
  }
}

function makeStyle() {
  const m = new Map();
  return {
    setProperty(k, v) { m.set(k, String(v)); },
    getPropertyValue(k) { return m.has(k) ? m.get(k) : ''; },
    get cssText() {
      return Array.from(m.entries()).map(([k, v]) => `${k}: ${v}`).join('; ');
    },
    set left(v) { m.set('left', String(v)); },
    get left() { return m.get('left') ?? ''; },
    set top(v) { m.set('top', String(v)); },
    get top() { return m.get('top') ?? ''; },
    set width(v) { m.set('width', String(v)); },
    get width() { return m.get('width') ?? ''; },
    set height(v) { m.set('height', String(v)); },
    get height() { return m.get('height') ?? ''; },
  };
}

// TreeWalker for Text nodes. The production code calls
// document.createTreeWalker(root, NodeFilter.SHOW_TEXT) ; we
// snapshot every Text descendant of root in document order and
// hand out an iterator via nextNode().
function createTreeWalker(root, _whatToShow) {
  const texts = [];
  root._collectText(texts);
  let i = -1;
  return {
    nextNode() {
      i++;
      return i < texts.length ? texts[i] : null;
    },
  };
}

// Range stub. setStart / setEnd record a (node, offset) pair ;
// collapse drops the end onto the start ; getBoundingClientRect
// returns a deterministic rect we synthesise from offsets so the
// caret-position assertions are stable.
function createRange() {
  const r = {
    startContainer: null,
    startOffset: 0,
    endContainer: null,
    endOffset: 0,
    setStart(n, o) { r.startContainer = n; r.startOffset = o; },
    setEnd(n, o) { r.endContainer = n; r.endOffset = o; },
    collapse(_toStart) { r.endContainer = r.startContainer; r.endOffset = r.startOffset; },
    getBoundingClientRect() {
      // 8 px per char, 16 px tall — purely synthetic, just needs
      // to be non-zero + monotonic so the production caret
      // height fallback doesn't kick in.
      const start = r.startOffset || 0;
      const end = r.endOffset || start;
      const left = start * 8;
      const width = Math.max(0, (end - start) * 8);
      return { left, top: 0, right: left + width, bottom: 16, width, height: 16 };
    },
  };
  return r;
}

// rAF stub : queue callbacks ; flushRaf() runs them. Production
// code calls schedulePaint() which sets a frame ID ; the deferred
// callback runs paint(). We expose flushRaf() to drive the queue
// synchronously from tests.
let rafQueue = [];
let rafId = 1;
function requestAnimationFrameStub(cb) {
  rafQueue.push({ id: rafId++, cb });
  return rafId - 1;
}
function cancelAnimationFrameStub(id) {
  rafQueue = rafQueue.filter((e) => e.id !== id);
}
function flushRaf() {
  // Repeat until the queue stops growing — paint() doesn't re-
  // schedule, but defensive against future revisions.
  for (let guard = 0; guard < 10 && rafQueue.length > 0; guard++) {
    const batch = rafQueue;
    rafQueue = [];
    for (const e of batch) {
      try { e.cb(performance.now ? performance.now() : Date.now()); }
      catch (err) { console.error('raf cb threw', err); }
    }
  }
}

function installDom() {
  globalThis.document = {
    createElement(tag) { return new StubElement(tag); },
    createTreeWalker,
    createRange,
    body: new StubElement('body'),
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.requestAnimationFrame = requestAnimationFrameStub;
  globalThis.cancelAnimationFrame = cancelAnimationFrameStub;
  // y-protocols/awareness sets a setInterval for liveness — fine on
  // node ; we don't unref so the test process exits via the
  // explicit destroy() of the awareness instance at end-of-test.
}

// ─── Module loader ────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/wysiwygPresence.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

const wrapped = `
${built.code}
module.exports = { wireWysiwygPresence };
`;

function loadModule() {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', wrapped)(mod, mod.exports, (id) => {
    throw new Error('unexpected require: ' + id);
  });
  return mod.exports;
}

// Helpers : count caret + selection nodes in the overlay, and find
// the overlay div under a given parent.
function overlayOf(parent) {
  return parent.children.find(
    (c) => c.nodeType === 1 && (c.className ?? '') === 'wysiwyg-presence-layer',
  );
}
function caretsIn(overlay) {
  if (!overlay) return [];
  return overlay.children.filter((c) => c.className === 'wysiwyg-peer-caret');
}
function selectionsIn(overlay) {
  if (!overlay) return [];
  return overlay.children.filter((c) => c.className === 'wysiwyg-peer-selection');
}

// Build a (parent, host) pair with the host pre-populated with one
// Text node so the TreeWalker has something to walk.
function makeHost(text = 'hello world') {
  const parent = new StubElement('div');
  const host = new StubElement('div');
  host.appendText(text);
  parent.appendChild(host);
  return { parent, host };
}

// ─── Tests ────────────────────────────────────────────────────────

test('single peer in awareness → overlay div + one caret', () => {
  installDom();
  const { wireWysiwygPresence } = loadModule();

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const { parent, host } = makeHost('hello world');

  // Local client : 1. Remote peer : 42.
  awareness.states.set(42, {
    user: { name: 'bob', color: 'hsl(0, 80%, 50%)' },
    wysiwygSelection: { startOffset: 3, endOffset: 3 },
  });

  const wiring = wireWysiwygPresence(host, awareness, 1);
  flushRaf();

  const overlay = overlayOf(parent);
  assert.ok(overlay, 'overlay div should be a sibling of the host');
  const carets = caretsIn(overlay);
  assert.equal(carets.length, 1, 'exactly one caret for the one remote peer');
  assert.equal(selectionsIn(overlay).length, 0,
    'collapsed selection → no selection rect');

  wiring.destroy();
  awareness.destroy();
});

test('peer state name + color → data-name + --peer-color', () => {
  installDom();
  const { wireWysiwygPresence } = loadModule();

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const { parent, host } = makeHost('hello world');

  awareness.states.set(7, {
    user: { name: 'alice', color: 'hsl(120, 60%, 50%)' },
    wysiwygSelection: { startOffset: 2, endOffset: 5 },
  });

  const wiring = wireWysiwygPresence(host, awareness, 1);
  flushRaf();

  const overlay = overlayOf(parent);
  const [caret] = caretsIn(overlay);
  assert.ok(caret, 'caret rendered');
  assert.equal(caret.getAttribute('data-name'), 'alice',
    'data-name comes from awareness user.name');
  assert.equal(caret.getAttribute('data-client-id'), '7',
    'data-client-id comes from awareness key');
  assert.equal(caret.style.getPropertyValue('--peer-color'),
    'hsl(120, 60%, 50%)',
    '--peer-color comes from awareness user.color');

  // Non-collapsed range → a selection rect appears next to the caret.
  const sels = selectionsIn(overlay);
  assert.equal(sels.length, 1, 'non-collapsed selection → one selection rect');
  assert.equal(sels[0].style.getPropertyValue('--peer-color'),
    'hsl(120, 60%, 50%)',
    'selection rect picks up same --peer-color');

  wiring.destroy();
  awareness.destroy();
});

test('local clientID is skipped (no self-caret)', () => {
  installDom();
  const { wireWysiwygPresence } = loadModule();

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const { parent, host } = makeHost('hello world');

  // Same clientID as the "local" one we pass in below → must
  // never render.
  awareness.states.set(99, {
    user: { name: 'me', color: 'hsl(220, 70%, 50%)' },
    wysiwygSelection: { startOffset: 1, endOffset: 1 },
  });
  awareness.states.set(101, {
    user: { name: 'peer', color: 'hsl(50, 70%, 50%)' },
    wysiwygSelection: { startOffset: 2, endOffset: 2 },
  });

  const wiring = wireWysiwygPresence(host, awareness, 99);
  flushRaf();

  const overlay = overlayOf(parent);
  const carets = caretsIn(overlay);
  assert.equal(carets.length, 1, 'only the remote peer gets a caret');
  assert.equal(carets[0].getAttribute('data-name'), 'peer',
    'the rendered caret is the remote peer, not us');

  wiring.destroy();
  awareness.destroy();
});

test('destroy() removes overlay + unwires awareness listener', () => {
  installDom();
  const { wireWysiwygPresence } = loadModule();

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const { parent, host } = makeHost('hello world');

  awareness.states.set(42, {
    user: { name: 'bob', color: 'hsl(0, 80%, 50%)' },
    wysiwygSelection: { startOffset: 1, endOffset: 1 },
  });

  const wiring = wireWysiwygPresence(host, awareness, 1);
  flushRaf();
  assert.ok(overlayOf(parent), 'overlay exists before destroy');

  wiring.destroy();
  assert.equal(overlayOf(parent), undefined,
    'overlay removed from parent after destroy');

  // After destroy(), changes to awareness must NOT re-create the
  // overlay (listener was unwired). We add a new peer + emit a
  // change ; if the listener leaked it would re-paint and re-
  // append the overlay.
  awareness.states.set(77, {
    user: { name: 'late', color: 'hsl(280, 70%, 50%)' },
    wysiwygSelection: { startOffset: 0, endOffset: 0 },
  });
  awareness.emit('change', [{ added: [77], updated: [], removed: [] }, 'test']);
  flushRaf();

  assert.equal(overlayOf(parent), undefined,
    'no overlay re-created after destroy : listener was properly removed');

  awareness.destroy();
});

test('awareness change update → overlay updates without leaking nodes', () => {
  installDom();
  const { wireWysiwygPresence } = loadModule();

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const { parent, host } = makeHost('hello world this is text');

  // One peer to start.
  awareness.states.set(7, {
    user: { name: 'alice', color: 'hsl(120, 60%, 50%)' },
    wysiwygSelection: { startOffset: 1, endOffset: 1 },
  });

  const wiring = wireWysiwygPresence(host, awareness, 1);
  flushRaf();
  const overlay = overlayOf(parent);
  assert.equal(caretsIn(overlay).length, 1, 'one peer = one caret');

  // Move alice's caret. The same caret node should be reused (no
  // duplicate inserted).
  awareness.states.set(7, {
    user: { name: 'alice', color: 'hsl(120, 60%, 50%)' },
    wysiwygSelection: { startOffset: 5, endOffset: 5 },
  });
  awareness.emit('change', [{ added: [], updated: [7], removed: [] }, 'test']);
  flushRaf();
  assert.equal(caretsIn(overlay).length, 1,
    'updating a peer does not duplicate its caret');

  // Add a second peer.
  awareness.states.set(9, {
    user: { name: 'bob', color: 'hsl(0, 80%, 50%)' },
    wysiwygSelection: { startOffset: 3, endOffset: 7 },
  });
  awareness.emit('change', [{ added: [9], updated: [], removed: [] }, 'test']);
  flushRaf();
  assert.equal(caretsIn(overlay).length, 2,
    'second peer gets its own caret');
  assert.equal(selectionsIn(overlay).length, 1,
    'second peer has a non-collapsed selection rect');

  // Remove alice. Only bob remains.
  awareness.states.delete(7);
  awareness.emit('change', [{ added: [], updated: [], removed: [7] }, 'test']);
  flushRaf();
  const remaining = caretsIn(overlay);
  assert.equal(remaining.length, 1, 'alice pruned, bob remains');
  assert.equal(remaining[0].getAttribute('data-name'), 'bob',
    'the surviving caret is bob');

  wiring.destroy();
  awareness.destroy();
});
