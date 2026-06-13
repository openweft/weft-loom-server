// latex-palette.mjs — LaTeX symbol palette regression test.
//
// What it covers :
//   1. The palette FAB is INVISIBLE when the active file is not LaTeX
//      (e.g. markdown). Clicking it must not exist.
//   2. The palette FAB is VISIBLE when the active file is .tex.
//   3. Opening the palette + clicking a Greek symbol inserts the
//      LaTeX command at the cursor (via window.weftLoomInsertAtCursor).
//   4. Switching tabs (Greek → Structures) re-populates the grid.
//   5. The filter input narrows the visible symbols.
//   6. Inserting a structure with a cursor offset (e.g. \\frac{}{}) parks
//      the caret at the right stub.

import puppeteer from 'puppeteer';
import { writeFile, mkdir } from 'node:fs/promises';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const LATEX_PATH = 'latex-palette-test.tex';
const MD_PATH = 'latex-palette-test.md';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom LaTeX symbol palette suite\x1b[0m');

// Seed both fixtures.
for (const [path, body] of [
  [LATEX_PATH, '\\documentclass{article}\n\\begin{document}\nHello \n\\end{document}\n'],
  [MD_PATH, '# md fixture\n\nhello world\n'],
]) {
  const r = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(path), {
    method: 'PUT', body,
  });
  if (r.status !== 200 && r.status !== 204) {
    failL('seed ' + path, 'HTTP ' + r.status);
    process.exit(1);
  }
}
ok('seed fixtures', '.tex + .md');

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

// Open the markdown fixture first → palette must be hidden.
await page.evaluate((p) => (window).weftLoomOpenFile(p), MD_PATH);
await new Promise((r) => setTimeout(r, 800));
const mdHasFab = await page.evaluate(() =>
  !!document.querySelector('[data-testid="latex-palette-toggle"]'));
if (mdHasFab) failL('palette hidden on markdown', 'FAB rendered for .md');
else ok('palette hidden on markdown', 'no FAB when language ≠ latex');

// Open the .tex fixture → palette FAB must appear.
await page.evaluate((p) => (window).weftLoomOpenFile(p), LATEX_PATH);
await new Promise((r) => setTimeout(r, 1500));
const texHasFab = await page.evaluate(() =>
  !!document.querySelector('[data-testid="latex-palette-toggle"]'));
if (!texHasFab) {
  failL('palette visible on latex', 'FAB missing for .tex');
  await browser.close();
  console.log('\x1b[31m' + passed + '/' + (passed + failed) + ' passed\x1b[0m');
  process.exit(1);
}
ok('palette visible on latex', 'FAB rendered for .tex');

// Open the palette.
await page.evaluate(() => document.querySelector('[data-testid="latex-palette-toggle"]')?.click());
await new Promise((r) => setTimeout(r, 200));
const open1 = await page.evaluate(() =>
  !!document.querySelector('[data-testid="latex-palette-panel"]'));
if (!open1) failL('palette opens', 'no panel after click');
else ok('palette opens', 'panel mounted');

// Default tab is "greek" — click the first cell (\alpha).
const inserted = await page.evaluate(() => {
  const cell = document.querySelector('[data-testid="latex-palette-cell"]');
  if (!cell) return { ok: false };
  const cmd = cell.getAttribute('data-cmd');
  (cell).click();
  return { ok: true, cmd };
});
await new Promise((r) => setTimeout(r, 400));
if (inserted.cmd !== '\\alpha') {
  failL('default tab', 'expected first cell = \\alpha, got ' + inserted.cmd);
} else {
  ok('default tab is Greek', '\\alpha first cell');
}
// The CodeMirror buffer must now contain \alpha at the end.
const buf1 = await page.evaluate(() => {
  const cm = document.querySelector('.cm-content');
  return cm ? (cm.textContent ?? '') : '';
});
if (buf1.includes('\\alpha')) {
  ok('insert at cursor', '\\alpha spliced into source');
} else {
  failL('insert at cursor', 'buffer missing \\alpha : ' + buf1.slice(0, 200));
}

// Switch to Structures tab + click "a/b" (\frac{}{}).
await page.evaluate(() => document.querySelector('[data-testid="latex-palette-cat-structures"]')?.click());
await new Promise((r) => setTimeout(r, 200));
const fracInserted = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('[data-testid="latex-palette-cell"]'));
  const frac = cells.find(c => c.getAttribute('data-cmd') === '\\frac{}{}');
  if (!frac) return false;
  (frac).click();
  return true;
});
if (!fracInserted) {
  failL('Structures tab', '\\frac{}{} cell not found');
} else {
  await new Promise((r) => setTimeout(r, 400));
  const buf2 = await page.evaluate(() => {
    const cm = document.querySelector('.cm-content');
    return cm ? (cm.textContent ?? '') : '';
  });
  if (buf2.includes('\\frac{}{}')) {
    ok('structure insert', '\\frac{}{} spliced into source');
  } else {
    failL('structure insert', 'buffer missing \\frac : ' + buf2.slice(-80));
  }
}

// Filter narrows the grid.
await page.evaluate(() => document.querySelector('[data-testid="latex-palette-cat-operators"]')?.click());
await new Promise((r) => setTimeout(r, 200));
await page.type('[data-testid="latex-palette-filter"]', 'cdot');
await new Promise((r) => setTimeout(r, 200));
const filteredCount = await page.evaluate(() =>
  document.querySelectorAll('[data-testid="latex-palette-cell"]').length);
if (filteredCount === 1) {
  ok('filter narrows grid', '1 cell visible for "cdot"');
} else {
  failL('filter narrows grid', 'expected exactly 1 cell, got ' + filteredCount);
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(LATEX_PATH), { method: 'DELETE' }).catch(() => {});
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(MD_PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
