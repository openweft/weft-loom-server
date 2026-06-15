// diag-wysiwyg-popover.mjs — open .tex in WYSIWYG, click a math
// node, assert the popover opens with the right tex, edit the
// textarea, click Apply, assert data-tex updates + KaTeX re-renders.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-popover-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}
Pythagoras : $a^2 + b^2 = c^2$.
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
await page.evaluate(() => localStorage.setItem('weft-loom-tex-wysiwyg', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 4000));

// 1. Click the inline math node.
const mathEl = await page.$('.math-inline');
console.log('math node found:', !!mathEl);
await mathEl?.click();
await new Promise((r) => setTimeout(r, 400));

// 2. Popover opens with the right tex.
const popoverState = await page.evaluate(() => {
  const p = document.querySelector('[data-testid="math-popover"]');
  if (!p) return { open: false };
  const ta = p.querySelector('textarea');
  const preview = p.querySelector('.math-popover-preview');
  return {
    open: true,
    texInTextarea: ta ? ta.value : null,
    previewHasKatex: preview && preview.querySelector('.katex') !== null,
  };
});
console.log('popover after click:', popoverState);

// 3. Type a new tex + click Apply.
await page.evaluate(() => {
  const ta = document.querySelector('[data-testid="math-popover"] textarea');
  ta.value = 'E = mc^2';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 300));
const applyBtn = await page.evaluateHandle(() =>
  Array.from(document.querySelectorAll('[data-testid="math-popover"] button'))
    .find((b) => b.textContent?.includes('Apply')));
await applyBtn.asElement()?.click();
await new Promise((r) => setTimeout(r, 600));

// 4. Math node updated.
const afterApply = await page.evaluate(() => {
  const m = document.querySelector('.math-inline');
  return {
    dataTex: m?.getAttribute('data-tex') ?? null,
    katexRendered: m?.querySelector('.katex') !== null,
    popoverClosed: !document.querySelector('[data-testid="math-popover"]'),
  };
});
console.log('after apply:', afterApply);

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
