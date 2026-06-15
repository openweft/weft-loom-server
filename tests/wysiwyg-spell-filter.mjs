// wysiwyg-spell-filter.mjs — node tests for wysiwygSpellFilter.ts.
//
// Asserts five contracts of the filter module :
//   1. applySpellFilter marks a lone .latex-cite span as
//      spellcheck="false".
//   2. Multiple skip-class nodes (.math-inline, .latex-ref, img …)
//      are all marked in a single pass.
//   3. A pure prose <p> with no skip-class is left alone.
//   4. The teardown returned by applySpellFilter removes the
//      spellcheck="false" attribute from exactly the nodes that were
//      marked.
//   5. wireSpellFilter : appending a .math-inline span after attach
//      gets it marked within the debounce window (we drive time via
//      a fake setTimeout queue, no real wallclock waits).
//
// We don't have jsdom in this workspace, so we hand-roll the tiny
// DOM slice the module touches : Element/Text shims with parent +
// children pointers, classList/setAttribute/getAttribute, plus a
// querySelectorAll that understands a flat comma-separated list of
// `.cls` and bare tag selectors (everything in SKIP_SELECTOR), and a
// MutationObserver shim that fires on appendChild/insertBefore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

// ─── DOM stub ────────────────────────────────────────────────────

let _observers = [];

class StubElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.parentNode = null;
    this.children = [];
    this._attrs = new Map();
    this._classes = new Set();
  }
  get className() {
    return [...this._classes].join(' ');
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get classList() {
    const set = this._classes;
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    };
  }
  setAttribute(k, v) {
    if (k === 'class') {
      this.className = v;
      return;
    }
    this._attrs.set(k, String(v));
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(k) {
    if (k === 'class') return this._classes.size > 0;
    return this._attrs.has(k);
  }
  removeAttribute(k) {
    this._attrs.delete(k);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    _fireMutations(this, [child]);
    return child;
  }
  insertBefore(child, ref) {
    child.parentNode = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx < 0) this.children.push(child);
    else this.children.splice(idx, 0, child);
    _fireMutations(this, [child]);
    return child;
  }
  // Flat selector understanding : list of '.cls' or bare tags
  // separated by commas. Walks the subtree and collects matches.
  querySelectorAll(selector) {
    const parts = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    const walk = (node) => {
      if (!node.children) return;
      for (const child of node.children) {
        if (child.nodeType !== 1) continue;
        if (matchesAny(child, parts)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return {
      forEach: (fn) => out.forEach(fn),
      length: out.length,
      [Symbol.iterator]: () => out[Symbol.iterator](),
    };
  }
}

function matchesAny(el, parts) {
  for (const p of parts) {
    if (p.startsWith('.')) {
      if (el._classes && el._classes.has(p.slice(1))) return true;
    } else {
      if (el.tagName === p.toUpperCase()) return true;
    }
  }
  return false;
}

class StubText {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentNode = null;
  }
}

// MutationObserver shim : observes a subtree and on appendChild /
// insertBefore inside that subtree it queues a record. Records are
// flushed synchronously to the callback (matches the timing our
// debounced re-apply expects, since the module schedules via
// setTimeout anyway, which we also fake).
class StubMutationObserver {
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
  }
  observe(target /*, opts */) {
    this.targets.push(target);
    _observers.push(this);
  }
  disconnect() {
    _observers = _observers.filter((o) => o !== this);
  }
}

function _fireMutations(target, added) {
  for (const obs of _observers) {
    if (obs.targets.some((t) => _contains(t, target))) {
      obs.cb([{ type: 'childList', addedNodes: added, target }]);
    }
  }
}

function _contains(root, node) {
  let cur = node;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parentNode;
  }
  return false;
}

// Fake setTimeout queue : we want the test to drive the debounce
// deterministically. Save the real ones, install fakes, expose a
// flush() that pops everything in FIFO order.
const _scheduled = [];
let _fakeTimeoutId = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function installFakeTimers() {
  globalThis.setTimeout = (fn /*, ms */) => {
    const id = ++_fakeTimeoutId;
    _scheduled.push({ id, fn });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const idx = _scheduled.findIndex((s) => s.id === id);
    if (idx >= 0) _scheduled.splice(idx, 1);
  };
}
function restoreTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
function flushTimers() {
  while (_scheduled.length > 0) {
    const { fn } = _scheduled.shift();
    fn();
  }
}

function installDOM() {
  globalThis.MutationObserver = StubMutationObserver;
}

// ─── Module loader ────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/wysiwygSpellFilter.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

const wrapped = `
${built.code}
module.exports = { applySpellFilter, wireSpellFilter };
`;

function loadModule() {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', wrapped)(mod, mod.exports, (id) => {
    throw new Error('unexpected require: ' + id);
  });
  return mod.exports;
}

// ─── Helpers ──────────────────────────────────────────────────────

function mkSpan(...classes) {
  const el = new StubElement('span');
  el.className = classes.join(' ');
  return el;
}
function mkHost() {
  return new StubElement('div');
}

// ─── Tests ────────────────────────────────────────────────────────

installDOM();
const { applySpellFilter, wireSpellFilter } = loadModule();

test('applySpellFilter marks a single .latex-cite span', () => {
  const host = mkHost();
  const cite = mkSpan('latex-cite');
  host.appendChild(cite);
  applySpellFilter(host);
  assert.equal(cite.getAttribute('spellcheck'), 'false');
});

test('applySpellFilter marks every skip-class node + img', () => {
  const host = mkHost();
  const cite = mkSpan('latex-cite');
  const ref = mkSpan('latex-ref');
  const label = mkSpan('latex-label');
  const raw = mkSpan('latex-raw');
  const mInline = mkSpan('math-inline');
  const mDisplay = mkSpan('math-display');
  const mEnv = mkSpan('math-env');
  const katex = mkSpan('katex');
  const fn = mkSpan('latex-footnote');
  const fig = mkSpan('latex-figure');
  const thm = mkSpan('latex-theorem-header');
  const img = new StubElement('img');
  for (const el of [cite, ref, label, raw, mInline, mDisplay, mEnv, katex, fn, fig, thm, img]) {
    host.appendChild(el);
  }
  applySpellFilter(host);
  for (const el of [cite, ref, label, raw, mInline, mDisplay, mEnv, katex, fn, fig, thm, img]) {
    assert.equal(
      el.getAttribute('spellcheck'),
      'false',
      `${el.tagName}.${el.className} should be marked`,
    );
  }
});

test('applySpellFilter leaves prose paragraphs alone', () => {
  const host = mkHost();
  const p = new StubElement('p');
  const txt = new StubText('Hello wrold typo');
  p.appendChild(txt);
  host.appendChild(p);
  // Also a theorem BODY span (not the header) → must stay checkable.
  const thmBody = mkSpan('latex-theorem-body');
  host.appendChild(thmBody);
  applySpellFilter(host);
  assert.equal(p.getAttribute('spellcheck'), null);
  assert.equal(thmBody.getAttribute('spellcheck'), null);
});

test('teardown removes spellcheck="false" from previously marked nodes', () => {
  const host = mkHost();
  const cite = mkSpan('latex-cite');
  const math = mkSpan('math-inline');
  host.appendChild(cite);
  host.appendChild(math);
  const teardown = applySpellFilter(host);
  assert.equal(cite.getAttribute('spellcheck'), 'false');
  assert.equal(math.getAttribute('spellcheck'), 'false');
  teardown();
  assert.equal(cite.getAttribute('spellcheck'), null);
  assert.equal(math.getAttribute('spellcheck'), null);
});

test('wireSpellFilter marks late-inserted .math-inline within debounce window', () => {
  installFakeTimers();
  try {
    const host = mkHost();
    // pre-existing : a cite (initial sweep should catch it)
    const cite = mkSpan('latex-cite');
    host.appendChild(cite);

    const destroy = wireSpellFilter(host);
    assert.equal(cite.getAttribute('spellcheck'), 'false', 'initial sweep marks cite');

    // Now insert a math-inline span — observer fires → schedules
    // a debounced re-apply.
    const math = mkSpan('math-inline');
    host.appendChild(math);
    // not marked yet (debounce hasn't fired)
    assert.equal(math.getAttribute('spellcheck'), null, 'pre-flush : math not marked yet');

    // Fire the queued debounce.
    flushTimers();
    assert.equal(math.getAttribute('spellcheck'), 'false', 'post-flush : math marked');

    destroy();
  } finally {
    restoreTimers();
  }
});
