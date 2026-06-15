// ref-completion.mjs — node tests for refCompletion (the
// CodeMirror CompletionSource that suggests \label{} keys when
// the user types inside \ref{} / \eqref{} / etc).
//
// Compiles the TS source via esbuild + drives it with a stubbed
// CompletionContext (no real CodeMirror state needed — we only
// touch doc.sliceString + doc.lineAt + doc.length).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/refCompletion.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

const wrapped = built.code + `
module.exports = { refCompletion };
`;
const moduleObj = { exports: {} };
new Function('module', 'exports', wrapped)(moduleObj, moduleObj.exports);
const { refCompletion } = moduleObj.exports;

function makeCtx(docText, pos) {
  return {
    pos,
    state: {
      doc: {
        length: docText.length,
        sliceString: (from, to) => docText.slice(from, to ?? docText.length),
        lineAt: (p) => {
          const before = docText.slice(0, p);
          const lineStart = before.lastIndexOf('\n') + 1;
          const lineEndIdx = docText.indexOf('\n', p);
          const to = lineEndIdx === -1 ? docText.length : lineEndIdx;
          return { from: lineStart, to, text: docText.slice(lineStart, to) };
        },
      },
    },
    matchBefore: (re) => {
      const before = docText.slice(0, pos);
      const m = before.match(new RegExp(re.source + '$'));
      return m ? { from: pos - m[0].length, to: pos, text: m[0] } : null;
    },
    explicit: false,
  };
}

test('refCompletion : \\ref{ caret suggests every \\label key in doc', () => {
  const doc = `\\label{intro}\\label{methods}\nSee \\ref{`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.ok(result, 'expected a CompletionResult');
  const labels = result.options.map((o) => o.label).sort();
  assert.deepEqual(labels, ['intro', 'methods']);
  // from = right after the `{`, so prefix length = 0 → from = pos
  assert.equal(result.from, doc.length);
});

test('refCompletion : prefix filter is case-insensitive prefix match', () => {
  const doc = `\\label{intro}\\label{methods}\\label{introduction}\nSee \\ref{int`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.ok(result, 'expected a CompletionResult');
  const labels = result.options.map((o) => o.label).sort();
  // both `intro` and `introduction` start with `int`, `methods` doesn't
  assert.deepEqual(labels, ['intro', 'introduction']);
  // from = pos - 'int'.length
  assert.equal(result.from, doc.length - 3);
});

test('refCompletion : caret outside any \\ref{} returns null', () => {
  const doc = `\\label{intro}\nJust plain text here.`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.equal(result, null);
});

test('refCompletion : \\eqref{ triggers the same source', () => {
  const doc = `\\label{eq:euler}\\label{eq:pyth}\nFrom \\eqref{eq:`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.ok(result, 'expected a CompletionResult');
  const labels = result.options.map((o) => o.label).sort();
  assert.deepEqual(labels, ['eq:euler', 'eq:pyth']);
});

test('refCompletion : \\autoref{ and \\pageref{ also trigger', () => {
  const docA = `\\label{sec:a}\nSee \\autoref{`;
  const resA = refCompletion(makeCtx(docA, docA.length));
  assert.ok(resA);
  assert.deepEqual(resA.options.map((o) => o.label), ['sec:a']);

  const docB = `\\label{p:1}\nOn page \\pageref{`;
  const resB = refCompletion(makeCtx(docB, docB.length));
  assert.ok(resB);
  assert.deepEqual(resB.options.map((o) => o.label), ['p:1']);
});

test('refCompletion : doc with no labels returns null', () => {
  const doc = `No labels here.\nSee \\ref{`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.equal(result, null);
});

test('refCompletion : already-closed \\ref{x} does NOT trigger', () => {
  // Caret AFTER the closing brace ; REF regex requires no `}`
  // between `{` and the cursor.
  const doc = `\\label{intro}\nSee \\ref{intro} here.`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.equal(result, null);
});

test('refCompletion : every option has type=enum + detail=label', () => {
  const doc = `\\label{a}\\label{b}\n\\ref{`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.ok(result);
  for (const opt of result.options) {
    assert.equal(opt.type, 'enum');
    assert.equal(opt.detail, 'label');
  }
});

test('refCompletion : suggestions are capped at 50', () => {
  // 60 labels all matching prefix '' → should yield 50.
  const labels = Array.from({ length: 60 }, (_, i) => `\\label{k${i}}`).join('');
  const doc = `${labels}\n\\ref{`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.ok(result);
  assert.equal(result.options.length, 50);
});

test('refCompletion : validFor regex matches typical label chars', () => {
  const doc = `\\label{intro}\n\\ref{`;
  const result = refCompletion(makeCtx(doc, doc.length));
  assert.ok(result);
  assert.ok(result.validFor instanceof RegExp);
  // Sample of legal label chars
  assert.ok(result.validFor.test('sec:intro_1'));
  assert.ok(result.validFor.test('fig-2'));
  assert.ok(result.validFor.test(''));
  // Brace would break out of the popup
  assert.ok(!result.validFor.test('}'));
});
