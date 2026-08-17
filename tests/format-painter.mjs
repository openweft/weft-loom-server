// format-painter.mjs — node tests for formatPainter.ts.
//
// Pins five contracts of the Word-style Format Painter helper :
//   1. snapshotFormatting on a Selection whose anchor sits inside a
//      <strong> returns bold=true (and zero everything else).
//   2. snapshotFormatting on a Selection anchored inside an <h2>
//      reports heading=2.
//   3. snapshotFormatting inside <em><strong>x</strong></em> sees
//      both bold=true AND italic=true (walks the full ancestor chain).
//   4. applyFormatting(snap.bold=true) over a plain non-collapsed
//      Selection issues document.execCommand('bold', false).
//   5. applyFormatting(snap.heading=1) issues
//      document.execCommand('formatBlock', false, 'h1') — and works
//      even on a collapsed caret (block-level commands legitimately
//      target the containing block).
//
// We deliberately don't pull jsdom : the module only touches a tiny
// slice of the DOM (Node.parentNode, Element.tagName, nodeType, plus
// document.execCommand) so a hand-rolled stub is cheaper + faster +
// faithful to what the code actually relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

// ─── Minimal DOM stub ─────────────────────────────────────────────
//
// Just enough to back closestTag (parent walk) + the wrapInCode
// branch (createElement / Range.extractContents / Range.insertNode /
// Selection.removeAllRanges + addRange). Tests for the code path
// aren't part of the required matrix ; we still keep the stub flexible
// so the module's full surface is exercisable.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

class StubNode {
  constructor() {
    this.nodeType = 0;
    this.parentNode = null;
    this.childNodes = [];
    this.ownerDocument = null;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
}

class StubElement extends StubNode {
  constructor(tagName, doc) {
    super();
    this.nodeType = ELEMENT_NODE;
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = doc;
  }
}

class StubText extends StubNode {
  constructor(text, doc) {
    super();
    this.nodeType = TEXT_NODE;
    this.data = text;
    this.ownerDocument = doc;
  }
}

class StubDocument {
  constructor() {
    this.execLog = [];
  }
  createElement(tag) { return new StubElement(tag, this); }
  createTextNode(t) { return new StubText(t, this); }
  createRange() { return new StubRange(); }
  execCommand(cmd, _ui, value) {
    this.execLog.push({ cmd, value });
    return true;
  }
}

class StubRange {
  constructor() {
    this.startContainer = null;
    this.endContainer = null;
    this.commonAncestorContainer = null;
    this.collapsed = true;
  }
  selectNodeContents(node) {
    this.startContainer = node;
    this.endContainer = node;
    this.commonAncestorContainer = node;
    this.collapsed = false;
  }
  extractContents() { return { /* empty fragment stub */ }; }
  insertNode() { /* no-op : tests don't inspect range mutation */ }
}

class StubSelection {
  constructor() {
    this.ranges = [];
  }
  get rangeCount() { return this.ranges.length; }
  get anchorNode() { return this.ranges[0]?.startContainer ?? null; }
  getRangeAt(i) { return this.ranges[i]; }
  removeAllRanges() { this.ranges = []; }
  addRange(r) { this.ranges.push(r); }
}

function makeRange(container, collapsed = false) {
  const r = new StubRange();
  r.startContainer = container;
  r.endContainer = container;
  r.commonAncestorContainer = container;
  r.collapsed = collapsed;
  return r;
}

function makeSelection(container, collapsed = false) {
  const sel = new StubSelection();
  sel.addRange(makeRange(container, collapsed));
  return sel;
}

// ─── Module loader ────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/formatPainter.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

const wrapped = `
${built.code}
module.exports = { snapshotFormatting, applyFormatting };
`;

function loadModule(doc) {
  // The module references the global `document` from inside
  // applyFormatting (execCommand) AND wrapInCode (createElement
  // fallback). Inject our stub before evaluating the CJS bundle.
  globalThis.document = doc;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', wrapped)(mod, mod.exports, (id) => {
    // The module watches peers through collab now. Nothing below exercises
    // that path, but the import has to resolve for the module to load at all.
    if (id === './collab') return { watchPeers: async () => () => {} };
    throw new Error('unexpected require: ' + id);
  });
  return mod.exports;
}

// ─── Tests ────────────────────────────────────────────────────────

test('snapshotFormatting : selection inside <strong> reports bold=true', () => {
  const doc = new StubDocument();
  const { snapshotFormatting } = loadModule(doc);

  // <strong>hello</strong> — anchor on the text node.
  const strong = new StubElement('strong', doc);
  const text = new StubText('hello', doc);
  strong.appendChild(text);

  const snap = snapshotFormatting(makeSelection(text));

  assert.equal(snap.bold, true, 'bold should detect <strong> ancestor');
  assert.equal(snap.italic, false);
  assert.equal(snap.underline, false);
  assert.equal(snap.code, false);
  assert.equal(snap.heading, 0);
});

test('snapshotFormatting : selection inside <h2> reports heading=2', () => {
  const doc = new StubDocument();
  const { snapshotFormatting } = loadModule(doc);

  const h2 = new StubElement('h2', doc);
  const text = new StubText('Title', doc);
  h2.appendChild(text);

  const snap = snapshotFormatting(makeSelection(text));

  assert.equal(snap.heading, 2);
  assert.equal(snap.bold, false);
  assert.equal(snap.italic, false);
});

test('snapshotFormatting : selection inside <em><strong>x</strong></em> reports bold=true + italic=true', () => {
  const doc = new StubDocument();
  const { snapshotFormatting } = loadModule(doc);

  const em = new StubElement('em', doc);
  const strong = new StubElement('strong', doc);
  const text = new StubText('x', doc);
  em.appendChild(strong);
  strong.appendChild(text);

  const snap = snapshotFormatting(makeSelection(text));

  assert.equal(snap.bold, true, 'walks past <strong>');
  assert.equal(snap.italic, true, 'and reaches <em>');
  assert.equal(snap.underline, false);
  assert.equal(snap.code, false);
  assert.equal(snap.heading, 0);
});

test('applyFormatting : bold=true on a non-collapsed selection calls execCommand("bold")', () => {
  const doc = new StubDocument();
  const { applyFormatting } = loadModule(doc);

  // A plain text node, non-collapsed selection (i.e. an actual span
  // of content the operator highlighted).
  const text = new StubText('plain', doc);
  const sel = makeSelection(text, /* collapsed */ false);

  const mutated = applyFormatting(sel, {
    bold: true, italic: false, underline: false, code: false, heading: 0,
  });

  assert.equal(mutated, true, 'should report a mutation');
  assert.equal(doc.execLog.length, 1, 'exactly one exec call');
  assert.equal(doc.execLog[0].cmd, 'bold');
  assert.equal(doc.execLog[0].value, undefined);
});

test('applyFormatting : heading=1 calls execCommand("formatBlock", false, "h1")', () => {
  const doc = new StubDocument();
  const { applyFormatting } = loadModule(doc);

  // Heading is block-level → applies even to a collapsed caret, which
  // mirrors the existing wrapHeading() behaviour in the Svelte host.
  const text = new StubText('Section', doc);
  const sel = makeSelection(text, /* collapsed */ true);

  const mutated = applyFormatting(sel, {
    bold: false, italic: false, underline: false, code: false, heading: 1,
  });

  assert.equal(mutated, true);
  assert.equal(doc.execLog.length, 1);
  assert.equal(doc.execLog[0].cmd, 'formatBlock');
  assert.equal(doc.execLog[0].value, 'h1');
});
