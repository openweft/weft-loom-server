// diag-wysiwyg-katex.mjs — assert KaTeX renders math in WYSIWYG.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-katex-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}
Pythagoras : $a^2 + b^2 = c^2$.
\\[
\\int_0^\\infty e^{-x} dx = 1
\\]
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
// Force WYSIWYG mode for this run.
await page.evaluate(() => localStorage.setItem('weft-loom-tex-wysiwyg', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 4000));

const inspection = await page.evaluate(() => {
  const surf = document.querySelector('[data-testid="latex-wysiwyg-surface"]');
  if (!surf) return { mounted: false };
  const inline = surf.querySelector('.math-inline');
  const display = surf.querySelector('.math-display');
  return {
    mounted: true,
    inline: {
      present: !!inline,
      hasKatexHtml: inline?.querySelector('.katex') !== null,
      dataTex: inline?.getAttribute('data-tex') ?? null,
      contenteditable: inline?.getAttribute('contenteditable') ?? null,
    },
    display: {
      present: !!display,
      hasKatexHtml: display?.querySelector('.katex') !== null,
      dataTex: display?.getAttribute('data-tex') ?? null,
    },
  };
});
console.log(JSON.stringify(inspection, null, 2));

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
