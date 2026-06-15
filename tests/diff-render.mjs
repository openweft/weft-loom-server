// diff-render.mjs — node tests for diffRender.ts.
//
// Pins the contracts the TrackChangesPanel relies on :
//   1. diffStrings produces an 'added' segment for a pure insertion
//      ("hello world" → "hello wonderful world" contains a segment
//      with kind:'added' AND text:'nderful ').
//   2. Identical strings collapse to a single 'unchanged' segment.
//   3. A full replacement produces BOTH a 'removed' and an 'added'
//      segment ("foo" → "bar").
//   4. renderDiffHtml escapes HTML entities (& < > etc) so arbitrary
//      LaTeX source is safe to inject via {@html}.
//   5. renderDiffHtml emits one <span class="diff-{kind}">…</span>
//      per segment.
//
// Loaded via esbuild transformSync (TS → CJS) the same way
// wysiwyg-authorship.mjs does, with a single require shim for the
// `diff` npm package.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';
import * as diffLib from '../web/node_modules/diff/libcjs/index.js';

// ─── Module loader ─────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/diffRender.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

const wrapped = `
${built.code}
module.exports = { diffStrings, renderDiffHtml };
`;

function loadModule() {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', wrapped)(mod, mod.exports, (id) => {
    if (id === 'diff') return diffLib;
    throw new Error('unexpected require: ' + id);
  });
  return mod.exports;
}

// ─── Tests ─────────────────────────────────────────────────────

test('diffStrings : pure insertion surfaces an added segment containing the inserted text', () => {
  const { diffStrings } = loadModule();
  const segs = diffStrings('hello world', 'hello wonderful world');

  // Sanity : the segment list must cover both inputs.
  assert.ok(segs.length >= 2, 'expected at least 2 segments');
  for (const s of segs) {
    assert.ok(['added', 'removed', 'unchanged'].includes(s.kind), 'segment kind must be one of the three flavours');
    assert.equal(typeof s.text, 'string');
  }

  // For a pure insertion there must be ZERO removed segments — the
  // before string is fully contained in the after string.
  const removedSegs = segs.filter((s) => s.kind === 'removed');
  assert.equal(removedSegs.length, 0, 'pure insertion must not emit removed segments');

  // At least one added segment must exist + the concatenation of
  // unchanged+added must reconstruct the after string exactly.
  // jsdiff's LCS picks its own split, so we don't assert a single
  // 'nderful ' segment ; instead we assert reconstructability +
  // that the unique inserted characters land in added segments.
  const addedText = segs.filter((s) => s.kind === 'added').map((s) => s.text).join('');
  assert.ok(addedText.length > 0, 'expected at least one added segment for a pure insertion');
  // The inserted run characteristic chars 'n', 'e', 'f', 'u' come
  // from 'wonderful' and MUST live in added segments — they don't
  // appear anywhere in the before string.
  for (const ch of ['n', 'e', 'f', 'u']) {
    assert.ok(addedText.includes(ch), `added text should contain '${ch}' from the inserted 'wonderful'`);
  }

  // Reconstruction : concat of unchanged + added recovers the after.
  const reconstructedAfter = segs
    .filter((s) => s.kind !== 'removed')
    .map((s) => s.text)
    .join('');
  assert.equal(reconstructedAfter, 'hello wonderful world');
});

test('diffStrings : identical inputs collapse to a single unchanged segment', () => {
  const { diffStrings } = loadModule();
  const segs = diffStrings('abc', 'abc');
  assert.equal(segs.length, 1, 'identical strings should produce exactly one segment');
  assert.equal(segs[0].kind, 'unchanged');
  assert.equal(segs[0].text, 'abc');
});

test('diffStrings : full replacement yields both removed and added segments', () => {
  const { diffStrings } = loadModule();
  const segs = diffStrings('foo', 'bar');

  const removed = segs.filter((s) => s.kind === 'removed').map((s) => s.text).join('');
  const added = segs.filter((s) => s.kind === 'added').map((s) => s.text).join('');

  assert.equal(removed, 'foo', 'removed segments must reconstruct the before string');
  assert.equal(added, 'bar', 'added segments must reconstruct the after string');
});

test('renderDiffHtml : escapes &, <, >, ", and \' to entities', () => {
  const { renderDiffHtml } = loadModule();
  const html = renderDiffHtml([
    { kind: 'unchanged', text: 'a & b' },
    { kind: 'added', text: '<script>alert("x")</script>' },
    { kind: 'removed', text: "it's" },
  ]);

  // Raw entities must not leak through.
  assert.ok(!html.includes('<script>'), 'literal <script> tag must not appear in rendered HTML');
  assert.ok(html.includes('&amp;'), '& should be escaped to &amp;');
  assert.ok(html.includes('&lt;script&gt;'), '< and > should be escaped');
  assert.ok(html.includes('&quot;'), '" should be escaped to &quot;');
  assert.ok(html.includes('&#39;'), "' should be escaped to &#39;");
});

test('renderDiffHtml : emits one span per segment with diff-{kind} class', () => {
  const { renderDiffHtml } = loadModule();
  const html = renderDiffHtml([
    { kind: 'unchanged', text: 'hello ' },
    { kind: 'added', text: 'big ' },
    { kind: 'removed', text: 'small ' },
    { kind: 'unchanged', text: 'world' },
  ]);

  // Count span openings : one per segment.
  const openings = html.match(/<span /g) || [];
  assert.equal(openings.length, 4, 'expected 4 span elements for 4 segments');

  assert.ok(html.includes('class="diff-unchanged"'), 'unchanged class missing');
  assert.ok(html.includes('class="diff-added"'), 'added class missing');
  assert.ok(html.includes('class="diff-removed"'), 'removed class missing');

  // Closing tag count matches.
  const closings = html.match(/<\/span>/g) || [];
  assert.equal(closings.length, 4, 'span open/close mismatch');
});
