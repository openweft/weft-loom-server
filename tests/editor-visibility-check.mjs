// editor-visibility-check.mjs — node-only unit tests for the
// pure helpers in editorVisibilityCheck.ts. The browser-side
// extension (ViewPlugin + getComputedStyle path) is best covered
// via the existing puppeteer suite ; here we pin the colour math
// so a regression in luminance / contrast / RGB parsing surfaces
// without spinning the SPA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The TS file isn't directly importable from node — instead we
// extract the pure helpers via a minimal eval pass that strips
// the imports + type annotations. Keeps the test independent of
// the build toolchain.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, '../web/src/lib/editorVisibilityCheck.ts'),
  'utf8',
);

// Surgically extract the three pure helpers. Brittle but
// transparent — easier to debug than a vite-driven test runner.
function pluckFunction(name) {
  const re = new RegExp(`function ${name}\\b[\\s\\S]*?\\n\\}\\n`, 'm');
  const m = src.match(re);
  if (!m) throw new Error('helper not found : ' + name);
  return m[0]
    // strip TS type annotations on params + return types
    .replace(/:\s*\[number,\s*number,\s*number\]\s*\|\s*null/g, '')
    .replace(/:\s*\[number,\s*number,\s*number\]/g, '')
    .replace(/:\s*number\b/g, '')
    .replace(/:\s*string\b/g, '');
}

const helpers = ['luminanceFor', 'contrastRatio', 'parseRGB']
  .map(pluckFunction)
  .join('\n');
const f = new Function(helpers + '\nreturn { luminanceFor, contrastRatio, parseRGB };');
const { luminanceFor, contrastRatio, parseRGB } = f();

test('parseRGB : standard rgb()', () => {
  assert.deepEqual(parseRGB('rgb(255, 0, 0)'), [255, 0, 0]);
});

test('parseRGB : rgba() ignores alpha', () => {
  assert.deepEqual(parseRGB('rgba(10, 20, 30, 0.5)'), [10, 20, 30]);
});

test('parseRGB : transparent → null', () => {
  assert.equal(parseRGB('transparent'), null);
  assert.equal(parseRGB('rgba(0, 0, 0, 0)'), null);
});

test('parseRGB : malformed → null', () => {
  assert.equal(parseRGB('not a color'), null);
  assert.equal(parseRGB(''), null);
});

test('contrastRatio : identical colours = 1.0', () => {
  const ratio = contrastRatio([100, 100, 100], [100, 100, 100]);
  assert.equal(ratio, 1.0);
});

test('contrastRatio : black on white = 21.0', () => {
  const ratio = contrastRatio([0, 0, 0], [255, 255, 255]);
  assert.ok(Math.abs(ratio - 21.0) < 0.01,
    'black/white ratio ≈ 21, got ' + ratio);
});

test('contrastRatio : near-identical greys fall below MIN_CONTRAST=2.0', () => {
  // The "invisible text" symptom : fg = #2e2e2e on bg = #1e1e1e.
  const ratio = contrastRatio([0x2e, 0x2e, 0x2e], [0x1e, 0x1e, 0x1e]);
  assert.ok(ratio < 2.0, 'near-identical greys must trigger : got ' + ratio);
});

test('contrastRatio : VSCode Dark+ default fg/bg passes', () => {
  // d4d4d4 on 1e1e1e — the working VSCode dark theme.
  const ratio = contrastRatio([0xd4, 0xd4, 0xd4], [0x1e, 0x1e, 0x1e]);
  assert.ok(ratio > 4.5, 'standard dark theme must pass WCAG-AA : got ' + ratio);
});
