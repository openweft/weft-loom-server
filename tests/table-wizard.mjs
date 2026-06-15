// table-wizard.mjs — unit tests for tableGen.ts, the pure helper that
// powers the Visual Table Wizard dialog. Node 24 strips the TS types
// natively so we can import the .ts module directly without a loader.
//
// Run :
//   cd weft-loom-server && \
//     export PATH=/opt/homebrew/opt/node@24/bin:$PATH && \
//     node --test tests/table-wizard.mjs

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
  'tableGen.ts',
);
const { generateTabularLatex } = await import(modPath);

test('3×3, all left-aligned, no borders produces a plain tabular block', () => {
  const out = generateTabularLatex({
    rows: 3,
    cols: 3,
    alignments: ['l', 'l', 'l'],
    bordered: false,
    hlines: false,
  });
  const expected =
    '\\begin{tabular}{lll}\n' +
    ' &  &  \\\\\n' +
    ' &  &  \\\\\n' +
    ' &  &  \\\\\n' +
    '\\end{tabular}';
  assert.equal(out, expected);
  // No float wrapper without a caption / label.
  assert.ok(!out.includes('\\begin{table}'));
  assert.ok(!out.includes('\\caption'));
  assert.ok(!out.includes('\\label'));
});

test('2×2 bordered + hlines wraps every row with \\hline and pipes every column', () => {
  const out = generateTabularLatex({
    rows: 2,
    cols: 2,
    alignments: ['l', 'l'],
    bordered: true,
    hlines: true,
  });
  const expected =
    '\\begin{tabular}{|l|l|}\n' +
    '\\hline\n' +
    ' &  \\\\\n' +
    '\\hline\n' +
    ' &  \\\\\n' +
    '\\hline\n' +
    '\\end{tabular}';
  assert.equal(out, expected);
});

test('caption + label wrap the tabular in a \\begin{table}[h] float', () => {
  const out = generateTabularLatex({
    rows: 1,
    cols: 2,
    alignments: ['l', 'l'],
    bordered: false,
    hlines: false,
    caption: 'My caption',
    label: 'mytable',
  });
  // Float wrapper present
  assert.ok(out.startsWith('\\begin{table}[h]\n'), 'float opens on first line');
  assert.ok(out.includes('\\centering'), 'has \\centering');
  // Tabular nested + indented inside the float
  assert.ok(out.includes('  \\begin{tabular}{ll}'), 'tabular indented inside float');
  assert.ok(out.includes('  \\end{tabular}'), 'tabular close indented inside float');
  // Caption + label rendered with the tab: prefix
  assert.ok(out.includes('\\caption{My caption}'), 'caption present');
  assert.ok(out.includes('\\label{tab:mytable}'), 'label prefixed with tab:');
  assert.ok(out.endsWith('\\end{table}'), 'float closes last');
});

test('only-caption (no label) still triggers the float wrapper but omits \\label', () => {
  const out = generateTabularLatex({
    rows: 1,
    cols: 1,
    alignments: ['l'],
    bordered: false,
    hlines: false,
    caption: 'Solo caption',
    label: '',
  });
  assert.ok(out.includes('\\begin{table}[h]'), 'has float');
  assert.ok(out.includes('\\caption{Solo caption}'), 'has caption');
  assert.ok(!out.includes('\\label'), 'no label line when label is empty');
});

test('only-label (no caption) still triggers the float wrapper but omits \\caption', () => {
  const out = generateTabularLatex({
    rows: 1,
    cols: 1,
    alignments: ['l'],
    bordered: false,
    hlines: false,
    caption: '',
    label: 'lonely',
  });
  assert.ok(out.includes('\\begin{table}[h]'), 'has float');
  assert.ok(!out.includes('\\caption'), 'no caption line when caption is empty');
  assert.ok(out.includes('\\label{tab:lonely}'), 'has label');
});

test('whitespace-only caption/label do not trigger the float wrapper', () => {
  const out = generateTabularLatex({
    rows: 1,
    cols: 1,
    alignments: ['l'],
    bordered: false,
    hlines: false,
    caption: '   ',
    label: '\t\n',
  });
  assert.ok(!out.includes('\\begin{table}'), 'blank caption/label is not a float trigger');
  assert.ok(out.startsWith('\\begin{tabular}'));
});

test('mixed alignments [c, r] flow through to the spec', () => {
  const out = generateTabularLatex({
    rows: 2,
    cols: 2,
    alignments: ['c', 'r'],
    bordered: false,
    hlines: false,
  });
  assert.ok(out.startsWith('\\begin{tabular}{cr}'), 'spec is "cr"');
});

test('mixed alignments + borders interleave pipes between every column', () => {
  const out = generateTabularLatex({
    rows: 1,
    cols: 3,
    alignments: ['l', 'c', 'r'],
    bordered: true,
    hlines: false,
  });
  assert.ok(out.startsWith('\\begin{tabular}{|l|c|r|}'), 'spec is "|l|c|r|"');
});

test('alignments shorter than cols are padded with l', () => {
  const out = generateTabularLatex({
    rows: 1,
    cols: 3,
    alignments: ['c'], // only one supplied, 2 missing
    bordered: false,
    hlines: false,
  });
  assert.ok(out.startsWith('\\begin{tabular}{cll}'), 'padded to "cll"');
});
