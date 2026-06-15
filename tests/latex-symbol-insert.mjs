// latex-symbol-insert.mjs — pin the LatexSymbolPalette → WYSIWYG
// bridge. The helper has to :
//   1. Insert the snippet at the live caret (TextNode, not innerHTML)
//   2. Advance the caret to the end of the inserted text
//   3. Fire an 'input' event so the WYSIWYG autosave timer fires
//
// jsdom is NOT installed in this workspace, so we stub the slice of
// DOM the helper actually touches : Range, Selection, TextNode, an
// HTMLElement-ish container, and global window/document. Keeps the
// test fast + self-contained ; we're pinning the contract, not the
// full browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

// ─── DOM stub ────────────────────────────────────────────────────
//
// Minimal Node-like graph : a node has childNodes + nodeValue +
// parentNode. A TextNode carries text. An ElementNode adds focus,
// classList, contains, closest, dispatchEvent, createTextNode access
// through ownerDocument. Range knows how to deleteContents and
// insertNode against this stub graph.

class StubNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
    this.nodeValue = null;
  }
  appendChild(n) {
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  contains(n) {
    if (n === this) return true;
    for (const c of this.childNodes) {
      if (c.contains && c.contains(n)) return true;
    }
    return false;
  }
}

class StubText extends StubNode {
  constructor(text) {
    super();
    this.nodeValue = text;
  }
  get textContent() { return this.nodeValue; }
  contains(n) { return n === this; }
}

class StubElement extends StubNode {
  constructor(doc) {
    super();
    this.ownerDocument = doc;
    this.classListSet = new Set();
    this.classList = {
      add: (c) => this.classListSet.add(c),
      contains: (c) => this.classListSet.has(c),
    };
    this._listeners = new Map();
    this.focused = false;
  }
  focus() { this.focused = true; }
  closest(_sel) { return null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    const list = this._listeners.get(ev.type) ?? [];
    for (const fn of list) fn(ev);
    return true;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent ?? '').join('');
  }
}

class StubRange {
  constructor(doc) {
    this.doc = doc;
    this.startContainer = doc.body;
    this.startOffset = 0;
    this.endContainer = doc.body;
    this.endOffset = 0;
    this.commonAncestorContainer = doc.body;
  }
  selectNodeContents(node) {
    this.startContainer = node;
    this.endContainer = node;
    this.commonAncestorContainer = node;
    this.startOffset = 0;
    this.endOffset = node.childNodes.length;
  }
  collapse(toStart) {
    if (toStart) {
      this.endContainer = this.startContainer;
      this.endOffset = this.startOffset;
    } else {
      this.startContainer = this.endContainer;
      this.startOffset = this.endOffset;
    }
  }
  deleteContents() {
    // Caret-only ranges are a no-op for our purposes ; if start ==
    // end, nothing to delete. We don't test full deletion here.
    if (this.startContainer === this.endContainer
        && this.startOffset === this.endOffset) {
      return;
    }
    // Whole-content path : if the range spans the element, drop its
    // children. Enough to cover the "caret at end of populated div"
    // path the helper takes when there's no live selection.
  }
  insertNode(node) {
    // Insert at startContainer:startOffset. For our test the start
    // container is either the surface or a text node inside it.
    const container = this.startContainer;
    if (container instanceof StubText) {
      // Split the text and insert the new node between halves.
      const parent = container.parentNode;
      const before = container.nodeValue.slice(0, this.startOffset);
      const after = container.nodeValue.slice(this.startOffset);
      const idx = parent.childNodes.indexOf(container);
      // Replace the existing text node with [before, newNode, after].
      const beforeText = new StubText(before);
      const afterText = new StubText(after);
      beforeText.parentNode = parent;
      afterText.parentNode = parent;
      node.parentNode = parent;
      parent.childNodes.splice(idx, 1, beforeText, node, afterText);
      this.startContainer = node;
      this.endContainer = node;
      this.commonAncestorContainer = parent;
    } else {
      // Element container : insert at the given child offset.
      node.parentNode = container;
      container.childNodes.splice(this.startOffset, 0, node);
      this.startContainer = node;
      this.endContainer = node;
      this.commonAncestorContainer = container;
    }
  }
  setStartAfter(node) {
    const parent = node.parentNode;
    const idx = parent.childNodes.indexOf(node);
    this.startContainer = parent;
    this.startOffset = idx + 1;
    this.commonAncestorContainer = parent;
  }
  setEndAfter(node) {
    const parent = node.parentNode;
    const idx = parent.childNodes.indexOf(node);
    this.endContainer = parent;
    this.endOffset = idx + 1;
  }
}

class StubSelection {
  constructor() {
    this.ranges = [];
  }
  get rangeCount() { return this.ranges.length; }
  getRangeAt(i) { return this.ranges[i]; }
  removeAllRanges() { this.ranges = []; }
  addRange(r) { this.ranges.push(r); }
}

class StubDocument {
  constructor() {
    this.body = new StubElement(this);
    this.defaultView = null;
  }
  createRange() { return new StubRange(this); }
  createTextNode(s) { return new StubText(s); }
}

class StubInputEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
  }
}

function installDom() {
  const doc = new StubDocument();
  const sel = new StubSelection();
  const win = {
    getSelection: () => sel,
  };
  doc.defaultView = win;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.HTMLElement = StubElement;
  globalThis.InputEvent = StubInputEvent;
  globalThis.Range = StubRange;
  return { doc, sel, win };
}

// ─── Module loader ───────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/latexSymbolInsert.ts');
const src = readFileSync(srcPath, 'utf8');
const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});
const wrapped = built.code + `
module.exports = { insertAtContenteditableCaret, resolveWysiwygTarget };
`;

function loadModule() {
  const mod = { exports: {} };
  new Function('module', 'exports', wrapped)(mod, mod.exports);
  return mod.exports;
}

// ─── Tests ───────────────────────────────────────────────────────

test('insertAtContenteditableCaret : inserts snippet at caret position 3', () => {
  const { doc, sel } = installDom();
  const { insertAtContenteditableCaret } = loadModule();

  // <div>HelloWorld</div> ; place caret between "Hel" and "loWorld".
  const surface = new StubElement(doc);
  surface.classList.add('latex-wysiwyg-surface');
  const text = new StubText('HelloWorld');
  surface.appendChild(text);

  const range = doc.createRange();
  range.startContainer = text;
  range.startOffset = 3;
  range.endContainer = text;
  range.endOffset = 3;
  range.commonAncestorContainer = text;
  sel.addRange(range);

  insertAtContenteditableCaret(surface, '\\alpha');

  // The text "Hel" + TextNode("\\alpha") + "loWorld" should be the
  // resulting children (3 nodes).
  assert.equal(surface.childNodes.length, 3, 'surface should have 3 children after split-insert');
  assert.equal(surface.childNodes[0].nodeValue, 'Hel');
  assert.equal(surface.childNodes[1].nodeValue, '\\alpha');
  assert.equal(surface.childNodes[2].nodeValue, 'loWorld');
  assert.equal(surface.textContent, 'Hel\\alphaloWorld');
});

test('insertAtContenteditableCaret : caret advances to AFTER inserted text', () => {
  const { doc, sel } = installDom();
  const { insertAtContenteditableCaret } = loadModule();

  const surface = new StubElement(doc);
  surface.classList.add('latex-wysiwyg-surface');
  const text = new StubText('abcdef');
  surface.appendChild(text);

  const range = doc.createRange();
  range.startContainer = text;
  range.startOffset = 2;
  range.endContainer = text;
  range.endOffset = 2;
  range.commonAncestorContainer = text;
  sel.addRange(range);

  insertAtContenteditableCaret(surface, 'X');

  // After insert, selection should hold one range whose start is
  // positioned right after the inserted text node.
  assert.equal(sel.rangeCount, 1);
  const after = sel.getRangeAt(0);
  // The inserted text node is at child index 1 inside surface ;
  // setStartAfter / setEndAfter put start/end at index 2 of surface.
  assert.equal(after.startContainer, surface);
  assert.equal(after.startOffset, 2);
  assert.equal(after.endContainer, surface);
  assert.equal(after.endOffset, 2);
});

test("insertAtContenteditableCaret : fires 'input' event on the surface", () => {
  const { doc } = installDom();
  const { insertAtContenteditableCaret } = loadModule();

  const surface = new StubElement(doc);
  surface.classList.add('latex-wysiwyg-surface');

  const events = [];
  surface.addEventListener('input', (ev) => { events.push(ev); });

  // No live selection : helper should still insert at end-of-el.
  insertAtContenteditableCaret(surface, '\\beta');

  assert.equal(events.length, 1, "exactly one 'input' event should fire");
  assert.equal(events[0].type, 'input');
  assert.equal(events[0].bubbles, true, 'event should bubble');
  // The snippet should have landed somewhere in the surface.
  assert.equal(surface.textContent, '\\beta');
});

test('insertAtContenteditableCaret : focuses the element', () => {
  const { doc } = installDom();
  const { insertAtContenteditableCaret } = loadModule();

  const surface = new StubElement(doc);
  surface.classList.add('latex-wysiwyg-surface');
  assert.equal(surface.focused, false);

  insertAtContenteditableCaret(surface, '\\gamma');

  assert.equal(surface.focused, true, 'el.focus() should have been called');
});
