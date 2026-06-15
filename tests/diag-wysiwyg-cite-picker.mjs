// diag-wysiwyg-cite-picker.mjs — V0.6 end-to-end : seed a .bib +
// .tex, open in WYSIWYG, click Cite button, search, click entry,
// assert \cite{key} renders at the caret with the author-year
// label looked up from the bib.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const BIB = 'cite-picker-' + Date.now() + '.bib';
const F = 'cite-picker-' + Date.now() + '.tex';

const BIB_SRC = `@article{einstein1905,
  author = {Einstein, Albert},
  year = {1905},
  title = {Zur Elektrodynamik bewegter Körper}
}
@book{knuth1984,
  author = {Knuth, Donald E.},
  year = {1984},
  title = {The TeXbook}
}
`;

const TEX_SRC = `\\documentclass{article}
\\begin{document}
First paragraph.
\\end{document}
`;

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(BIB), {
  method: 'PUT', body: BIB_SRC,
});
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'PUT', body: TEX_SRC,
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
await new Promise((r) => setTimeout(r, 4000));

// Click the Cite button.
const citeBtn = await page.evaluateHandle(() =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Cite') && b.title?.includes('Insert citation')));
await citeBtn.asElement()?.click();
await new Promise((r) => setTimeout(r, 500));

const opened = await page.evaluate(() => ({
  picker: !!document.querySelector('[data-testid="cite-picker"]'),
  rowCount: document.querySelectorAll('[data-testid="cite-picker"] .cite-picker-row').length,
}));
console.log('cite picker opened:', opened);

// Type "knuth" + verify the filter narrows the list.
await page.focus('[data-testid="cite-picker-filter"]');
await page.keyboard.type('knuth');
await new Promise((r) => setTimeout(r, 400));
const filtered = await page.evaluate(() => ({
  rowCount: document.querySelectorAll('[data-testid="cite-picker"] .cite-picker-row').length,
  firstKey: document.querySelector('[data-testid="cite-picker"] .cite-picker-row .font-mono')?.textContent ?? null,
}));
console.log('after typing "knuth":', filtered);

// Press Enter to insert.
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 400));

const inserted = await page.evaluate(() => {
  const cite = document.querySelector('[data-testid="latex-wysiwyg-surface"] .latex-cite');
  return {
    pickerClosed: !document.querySelector('[data-testid="cite-picker"]'),
    citeKey: cite?.getAttribute('data-key') ?? null,
    citeText: cite?.textContent ?? null,
  };
});
console.log('after Enter:', inserted);

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(BIB), {
  method: 'DELETE',
}).catch(() => {});
