// diag-wysiwyg-overleaf-parity.mjs — end-to-end : verify the
// WYSIWYG surface renders the same constructs Overleaf does
// (math, citations, refs, images) + the split-view mode.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-overleaf-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}
\\section{Intro}
See \\cite{einstein1905} on \\ref{sec:intro} \\label{sec:intro}.
$E = mc^2$ and \\frac{1}{2}.
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
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 4500));

const render = await page.evaluate(() => ({
  citeCount: document.querySelectorAll('.latex-cite').length,
  citeText: document.querySelector('.latex-cite')?.textContent ?? null,
  refCount: document.querySelectorAll('.latex-ref').length,
  labelCount: document.querySelectorAll('.latex-label').length,
  mathCount: document.querySelectorAll('.math-inline, .math-display').length,
  katexCount: document.querySelectorAll('.katex').length,
  rawLatexCount: document.querySelectorAll('.latex-raw').length, // \frac
}));
console.log('WYSIWYG render:', render);

// Cycle wysiwyg → split via the "Source" button in the WYSIWYG
// toolbar (dispatches the same toggle event the source-view
// "WYSIWYG" button does).
await page.evaluate(() => window.dispatchEvent(new CustomEvent('weft-loom:toggle-wysiwyg-mode')));
await new Promise((r) => setTimeout(r, 1500));

const split = await page.evaluate(() => ({
  cmEditor: !!document.querySelector('.cm-editor'),
  wysiwygSurface: !!document.querySelector('[data-testid="latex-wysiwyg-surface"]'),
  storage: localStorage.getItem('weft-loom-tex-wysiwyg'),
}));
console.log('after toggle (should be split — both editors visible):', split);

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
