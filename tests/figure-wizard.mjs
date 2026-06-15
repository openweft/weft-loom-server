// figure-wizard.mjs — unit tests for figureGen.ts, the pure helper that
// powers the Visual Figure Wizard dialog. Node 24 strips the TS types
// natively so we can import the .ts module directly without a loader.
//
// Run :
//   cd weft-loom-server && \
//     export PATH=/opt/homebrew/opt/node@24/bin:$PATH && \
//     node --test tests/figure-wizard.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(
  __dirname,
  '..',
  'web',
  'src',
  'lib',
  'figureGen.ts',
);
const { generateFigureLatex } = await import(modPath);

test('path only → minimal figure block, default placement [h], no width / caption / label', () => {
  const out = generateFigureLatex({ path: 'x.png' });
  const expected =
    '\\begin{figure}[h]\n' +
    '\\centering\n' +
    '\\includegraphics{x.png}\n' +
    '\\end{figure}\n';
  assert.equal(out, expected);
});

test('path + width + caption + label → full block with all four content lines', () => {
  const out = generateFigureLatex({
    path: 'figs/plot.png',
    width: '5cm',
    caption: 'Caption text',
    label: 'plot',
  });
  const expected =
    '\\begin{figure}[h]\n' +
    '\\centering\n' +
    '\\includegraphics[width=5cm]{figs/plot.png}\n' +
    '\\caption{Caption text}\n' +
    '\\label{fig:plot}\n' +
    '\\end{figure}\n';
  assert.equal(out, expected);
});

test('placement="t" flows through to \\begin{figure}[t]', () => {
  const out = generateFigureLatex({ path: 'x.png', placement: 't' });
  assert.ok(out.startsWith('\\begin{figure}[t]\n'), 'opens with [t]');
});

test('placement="H" (capital, float package) is preserved', () => {
  const out = generateFigureLatex({ path: 'x.png', placement: 'H' });
  assert.ok(out.startsWith('\\begin{figure}[H]\n'), 'opens with [H]');
});

test('invalid placement falls back to "h"', () => {
  const out = generateFigureLatex({ path: 'x.png', placement: 'xyz' });
  assert.ok(out.startsWith('\\begin{figure}[h]\n'), 'falls back to [h]');
});

test('empty caption but non-empty label → \\label line present, no \\caption line', () => {
  const out = generateFigureLatex({
    path: 'x.png',
    caption: '',
    label: 'only-label',
  });
  assert.ok(out.includes('\\label{fig:only-label}'), 'label line present');
  assert.ok(!out.includes('\\caption'), 'no caption line');
});

test('whitespace-only width is treated as empty (no [width=…])', () => {
  const out = generateFigureLatex({ path: 'x.png', width: '   ' });
  assert.ok(out.includes('\\includegraphics{x.png}'), 'no width spec');
  assert.ok(!out.includes('[width='), 'no width brackets');
});

test('width "0.5\\textwidth" flows through verbatim into the brackets', () => {
  const out = generateFigureLatex({
    path: 'x.png',
    width: '0.5\\textwidth',
  });
  assert.ok(
    out.includes('\\includegraphics[width=0.5\\textwidth]{x.png}'),
    'width spec preserved verbatim',
  );
});
