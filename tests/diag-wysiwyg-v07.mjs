// diag-wysiwyg-v07.mjs — V0.7 end-to-end : verify
// LatexTableToolbar appears on cell-click + inserts rows ;
// Σ Symbols button toggles the LatexSymbolPalette ; cursor
// stats fire on selection change.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-v07-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}
\\begin{tabular}{ll}
a & b \\\\
c & d \\\\
\\end{tabular}

\\begin{figure}[h]
\\centering
\\includegraphics{plot.png}
\\caption{The plot}
\\label{fig:plot}
\\end{figure}

\\begin{theorem}
Every prime greater than 2 is odd.
\\end{theorem}
\\end{document}
`;

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'PUT', body: SRC,
});

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(() => localStorage.setItem('weft-loom-tex-wysiwyg', 'wysiwyg'));
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 4500));

// 1. Figure + theorem + table all rendered.
const initial = await page.evaluate(() => ({
  table: !!document.querySelector('table.latex-tabular'),
  figure: !!document.querySelector('figure.latex-figure-env'),
  theorem: !!document.querySelector('.latex-theorem'),
  theoremText: document.querySelector('.latex-theorem-header')?.textContent ?? null,
  initialRowCount: document.querySelectorAll('table.latex-tabular tr').length,
}));
console.log('initial render:', initial);

// 2. Click a cell → table toolbar appears.
await page.evaluate(() => {
  const td = document.querySelector('table.latex-tabular td');
  td?.click();
});
await new Promise((r) => setTimeout(r, 500));

const afterCellClick = await page.evaluate(() => ({
  toolbarPresent: !!document.querySelector('.card.shadow-xl button'),
  toolbarButtonCount: document.querySelectorAll('.shadow-xl button').length,
}));
console.log('after cell click:', afterCellClick);

// 3. Find + click the "Row ↓" button.
const rowDownBtn = await page.evaluateHandle(() =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Row ↓')));
await rowDownBtn.asElement()?.click();
await new Promise((r) => setTimeout(r, 600));

const afterRowAdd = await page.evaluate(() => ({
  rowCount: document.querySelectorAll('table.latex-tabular tr').length,
}));
console.log('after Row ↓ click:', afterRowAdd);

// 4. Click Σ Symbols → palette opens.
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Σ Symbols'));
  btn?.click();
});
await new Promise((r) => setTimeout(r, 400));

const palette = await page.evaluate(() => ({
  open: !!document.querySelector('[data-testid="latex-palette-panel"]'),
  filterPresent: !!document.querySelector('[data-testid="latex-palette-filter"]'),
}));
console.log('palette state:', palette);

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
