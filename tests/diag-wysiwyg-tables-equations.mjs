// diag-wysiwyg-tables-equations.mjs — V0.5 end-to-end : open a
// .tex with tabular + equation env, assert they render in WYSIWYG.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-tables-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}
\\section{Tables + Equations}

\\begin{equation}
E = mc^2
\\end{equation}

\\begin{align}
x &= 1 \\\\
y &= 2
\\end{align}

\\begin{tabular}{|l|c|r|}
\\hline
Name & Age & Score \\\\
Alice & 30 & 95 \\\\
Bob & 25 & 88 \\\\
\\hline
\\end{tabular}

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

const inspection = await page.evaluate(() => {
  const surf = document.querySelector('[data-testid="latex-wysiwyg-surface"]');
  return {
    mounted: !!surf,
    tableCount: surf ? surf.querySelectorAll('table.latex-tabular').length : 0,
    tableSpec: surf?.querySelector('table.latex-tabular')?.getAttribute('data-spec') ?? null,
    cellCount: surf?.querySelectorAll('table.latex-tabular td').length ?? 0,
    firstCellText: surf?.querySelector('table.latex-tabular td')?.textContent ?? null,
    mathEnvCount: surf?.querySelectorAll('.math-env').length ?? 0,
    mathEnvNames: Array.from(surf?.querySelectorAll('.math-env') ?? [])
      .map((el) => el.getAttribute('data-env')),
    katexCount: surf?.querySelectorAll('.katex').length ?? 0,
  };
});
console.log(JSON.stringify(inspection, null, 2));

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
