// ref-resolver.mjs — node tests for the label/ref resolver.
// Pins :
//   - buildLabelMap walks the DOM in source order
//   - kind inference picks the right ancestor block
//     (math-env → eq, figure.latex-figure-env → fig,
//      .latex-theorem → thm, table.latex-tabular → table,
//      h1/h2/h3 → sec, li → item, else unknown)
//   - per-kind 1-based numbering
//   - text composition (Eq. (N) / Figure N / Section N / ...)
//   - resolveRefs rewrites .latex-ref textContent to the lookup text
//   - unknown refs fall back to "[ref:label]"
//
// node_modules/jsdom is not present, so we ship a tiny DOM stub :
// just enough surface (Element/Document, classList, querySelectorAll,
// tagName, parentElement, get/setAttribute, textContent) for the
// resolver to walk a synthesised tree. Build trees with a small
// `parse(html)` helper that consumes the markup shapes the parser
// emits (see latexWysiwyg.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

// ─── compile refResolver.ts ──────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/refResolver.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

const wrapped = built.code + `
module.exports = { buildLabelMap, resolveRefs };
`;
const module_ = { exports: {} };
new Function('module', 'exports', wrapped)(module_, module_.exports);
const { buildLabelMap, resolveRefs } = module_.exports;

// ─── minimal DOM stub ────────────────────────────────────────────
//
// Just enough Element API for refResolver.ts :
//   - tagName (UPPERCASE)
//   - classList.contains(name)
//   - getAttribute(name) / setAttribute(name, value)
//   - parentElement
//   - children / appendChild
//   - textContent (set replaces all children)
//   - querySelectorAll(selector) — supports the two selectors the
//     resolver uses : ".latex-label[data-label]" and
//     ".latex-ref[data-label]"

class Elem {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map();
    this.classes = new Set();
    this.children = [];
    this.parentElement = null;
    this._text = '';
    const self = this;
    this.classList = {
      contains(name) { return self.classes.has(name); },
      add(name) { self.classes.add(name); },
    };
  }
  setAttribute(name, value) {
    if (name === 'class') {
      this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    } else {
      this.attrs.set(name, String(value));
    }
  }
  getAttribute(name) {
    if (name === 'class') return Array.from(this.classes).join(' ');
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  set textContent(v) {
    this._text = String(v);
    // textContent assignment clears children (matches DOM behavior).
    this.children = [];
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  // querySelectorAll : supports ".cls[attr]" and ".cls" only — what
  // the resolver needs. Walks the subtree in document order.
  querySelectorAll(selector) {
    const m = selector.match(/^\.([\w-]+)(?:\[([\w-]+)\])?$/);
    if (!m) throw new Error('stub querySelectorAll selector not supported : ' + selector);
    const cls = m[1];
    const requireAttr = m[2];
    const out = [];
    const walk = (node) => {
      if (node.classes && node.classes.has(cls)) {
        if (!requireAttr || node.attrs.has(requireAttr)) {
          out.push(node);
        }
      }
      for (const c of node.children) walk(c);
    };
    for (const c of this.children) walk(c);
    return out;
  }
}

// helper : new element with class + attrs + optional children/text
function el(tag, opts = {}) {
  const e = new Elem(tag);
  if (opts.class) e.setAttribute('class', opts.class);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
  if (opts.text) e._text = opts.text;
  if (opts.children) for (const c of opts.children) e.appendChild(c);
  return e;
}

function labelSpan(name) {
  return el('span', { class: 'latex-label', attrs: { 'data-label': name }, text: '¶' });
}
function refSpan(name) {
  return el('span', { class: 'latex-ref', attrs: { 'data-label': name }, text: `[ref:${name}]` });
}

// ─── tests ───────────────────────────────────────────────────────

test('buildLabelMap : section label in h1 → kind=sec, "Section 1"', () => {
  const root = el('div', {
    children: [
      el('h1', { children: [labelSpan('sec:intro'), el('span', { text: 'Intro' })] }),
    ],
  });
  const map = buildLabelMap(root);
  assert.equal(map.size, 1);
  const entry = map.get('sec:intro');
  assert.ok(entry, 'sec:intro must be present');
  assert.equal(entry.kind, 'sec');
  assert.equal(entry.index, 1);
  assert.equal(entry.text, 'Section 1');
});

test('buildLabelMap : three equations get eq:1 eq:2 eq:3 with "Eq. (N)"', () => {
  const root = el('div', {
    children: [
      el('div', { class: 'math math-env', attrs: { 'data-env': 'equation' }, children: [labelSpan('eq:1')] }),
      el('div', { class: 'math math-env', attrs: { 'data-env': 'align' },    children: [labelSpan('eq:2')] }),
      el('div', { class: 'math math-env', attrs: { 'data-env': 'gather' },   children: [labelSpan('eq:3')] }),
    ],
  });
  const map = buildLabelMap(root);
  assert.equal(map.get('eq:1').kind, 'eq');
  assert.equal(map.get('eq:1').index, 1);
  assert.equal(map.get('eq:1').text, 'Eq. (1)');
  assert.equal(map.get('eq:2').index, 2);
  assert.equal(map.get('eq:2').text, 'Eq. (2)');
  assert.equal(map.get('eq:3').index, 3);
  assert.equal(map.get('eq:3').text, 'Eq. (3)');
});

test('buildLabelMap : figure / theorem / table / item / unknown kinds', () => {
  const root = el('div', {
    children: [
      el('figure',  { class: 'latex-figure-env', children: [labelSpan('fig:plot')] }),
      el('div',     { class: 'latex-theorem', attrs: { 'data-env': 'theorem' }, children: [labelSpan('thm:prime')] }),
      el('table',   { class: 'latex-tabular', children: [labelSpan('tab:data')] }),
      el('ul',      { children: [el('li', { children: [labelSpan('item:a')] })] }),
      // Bare label with no special ancestor — kind=unknown, text=label
      el('p',       { children: [labelSpan('mystery')] }),
    ],
  });
  const map = buildLabelMap(root);
  assert.equal(map.get('fig:plot').kind, 'fig');
  assert.equal(map.get('fig:plot').text, 'Figure 1');
  assert.equal(map.get('thm:prime').kind, 'thm');
  assert.equal(map.get('thm:prime').text, 'Theorem 1');
  assert.equal(map.get('tab:data').kind, 'table');
  assert.equal(map.get('tab:data').text, 'Table 1');
  assert.equal(map.get('item:a').kind, 'item');
  assert.equal(map.get('item:a').text, 'Item 1');
  assert.equal(map.get('mystery').kind, 'unknown');
  assert.equal(map.get('mystery').text, 'mystery');
});

test('buildLabelMap : per-kind counters are independent', () => {
  // Interleaved eq + fig + sec — each kind gets its own 1-based count.
  const root = el('div', {
    children: [
      el('h1',     { children: [labelSpan('sec:a')] }),
      el('div',    { class: 'math math-env', attrs: { 'data-env': 'equation' }, children: [labelSpan('eq:a')] }),
      el('figure', { class: 'latex-figure-env', children: [labelSpan('fig:a')] }),
      el('h1',     { children: [labelSpan('sec:b')] }),
      el('div',    { class: 'math math-env', attrs: { 'data-env': 'equation' }, children: [labelSpan('eq:b')] }),
    ],
  });
  const map = buildLabelMap(root);
  assert.equal(map.get('sec:a').index, 1);
  assert.equal(map.get('sec:b').index, 2);
  assert.equal(map.get('eq:a').index, 1);
  assert.equal(map.get('eq:b').index, 2);
  assert.equal(map.get('fig:a').index, 1);
});

test('resolveRefs : replaces textContent with looked-up text', () => {
  const ref = refSpan('eq:2');
  const root = el('div', {
    children: [
      el('div', { class: 'math math-env', attrs: { 'data-env': 'equation' }, children: [labelSpan('eq:1')] }),
      el('div', { class: 'math math-env', attrs: { 'data-env': 'equation' }, children: [labelSpan('eq:2')] }),
      el('p',   { children: [ref] }),
    ],
  });
  const map = buildLabelMap(root);
  resolveRefs(root, map);
  assert.equal(ref.textContent, 'Eq. (2)');
  assert.equal(ref.getAttribute('title'), 'eq: eq:2');
});

test('resolveRefs : unknown label falls back to [ref:label]', () => {
  const ref = refSpan('unknown-label');
  const root = el('div', { children: [el('p', { children: [ref] })] });
  const map = buildLabelMap(root);
  resolveRefs(root, map);
  assert.equal(ref.textContent, '[ref:unknown-label]');
  assert.equal(ref.getAttribute('title'), 'unresolved: unknown-label');
});

test('resolveRefs : mix of resolved + unresolved in one pass', () => {
  const okRef  = refSpan('fig:plot');
  const badRef = refSpan('fig:ghost');
  const root = el('div', {
    children: [
      el('figure', { class: 'latex-figure-env', children: [labelSpan('fig:plot')] }),
      el('p',      { children: [okRef, badRef] }),
    ],
  });
  resolveRefs(root, buildLabelMap(root));
  assert.equal(okRef.textContent, 'Figure 1');
  assert.equal(badRef.textContent, '[ref:fig:ghost]');
});
