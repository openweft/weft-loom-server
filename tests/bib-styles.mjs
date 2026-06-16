// bib-styles.mjs — pin the bibStyles.ts contract :
//   1. Every entry in BIB_STYLES carries a non-empty name + label +
//      description + a family value the picker can group on.
//   2. formatBibliographystyleLine returns the exact LaTeX line :
//        \bibliographystyle{<name>}\n
//   3. No duplicate `name` keys (the picker uses them as Svelte
//      `{#each}` keys ; duplicates would crash the render).
//
// Compiled with esbuild transformSync the same way
// latex-symbol-insert.mjs does — no jsdom needed, the module is pure
// data + a string formatter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/bibStyles.ts');
const src = readFileSync(srcPath, 'utf8');
const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});
const wrapped = built.code + `
module.exports = { BIB_STYLES, formatBibliographystyleLine };
`;

function loadModule() {
  const mod = { exports: {} };
  new Function('module', 'exports', wrapped)(mod, mod.exports);
  return mod.exports;
}

test('BIB_STYLES : every entry has non-empty name + label + description', () => {
  const { BIB_STYLES } = loadModule();
  assert.ok(Array.isArray(BIB_STYLES), 'BIB_STYLES should be an array');
  assert.ok(BIB_STYLES.length > 0, 'BIB_STYLES should not be empty');
  for (const s of BIB_STYLES) {
    assert.equal(typeof s.name, 'string',  'name must be a string : ' + JSON.stringify(s));
    assert.ok(s.name.length > 0,           'name must be non-empty : ' + JSON.stringify(s));
    assert.equal(typeof s.label, 'string', 'label must be a string : ' + JSON.stringify(s));
    assert.ok(s.label.length > 0,          'label must be non-empty : ' + JSON.stringify(s));
    assert.equal(typeof s.description, 'string', 'description must be a string : ' + JSON.stringify(s));
    assert.ok(s.description.length > 0,    'description must be non-empty : ' + JSON.stringify(s));
    assert.ok(
      ['plain', 'natbib', 'ieee', 'acm', 'chicago', 'other'].includes(s.family),
      'family must be a known value : ' + JSON.stringify(s),
    );
  }
});

test('BIB_STYLES : contains every style the spec listed', () => {
  const { BIB_STYLES } = loadModule();
  const want = [
    'plain', 'abbrv', 'alpha', 'unsrt', 'acm', 'ieeetr', 'apalike', 'siam',
    'abbrvnat', 'plainnat', 'unsrtnat', 'abstract', 'IEEEtran',
    'ACM-Reference-Format', 'agsm', 'apsr', 'asaetr', 'chicago', 'dcu',
    'harvard', 'nature', 'science',
  ];
  const have = new Set(BIB_STYLES.map((s) => s.name));
  for (const w of want) {
    assert.ok(have.has(w), 'missing style : ' + w);
  }
});

test('BIB_STYLES : no duplicate names', () => {
  const { BIB_STYLES } = loadModule();
  const seen = new Set();
  for (const s of BIB_STYLES) {
    assert.ok(!seen.has(s.name), 'duplicate name : ' + s.name);
    seen.add(s.name);
  }
});

test('formatBibliographystyleLine : returns the right LaTeX line', () => {
  const { formatBibliographystyleLine } = loadModule();
  assert.equal(formatBibliographystyleLine('plain'),    '\\bibliographystyle{plain}\n');
  assert.equal(formatBibliographystyleLine('IEEEtran'), '\\bibliographystyle{IEEEtran}\n');
  assert.equal(
    formatBibliographystyleLine('ACM-Reference-Format'),
    '\\bibliographystyle{ACM-Reference-Format}\n',
  );
});

test('formatBibliographystyleLine : handles empty string defensively', () => {
  // We don't sanitise — the caller is expected to pass a name from
  // BIB_STYLES. But the function must not throw on edge inputs.
  const { formatBibliographystyleLine } = loadModule();
  assert.equal(formatBibliographystyleLine(''), '\\bibliographystyle{}\n');
});
