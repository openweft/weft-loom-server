// diag-wysiwyg-v10.mjs — V0.10 end-to-end : every Phase-1 module
// surfaces in the WYSIWYG editor toolbar + the corresponding panel
// mounts on click.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-v10-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}
Some \\textbf{prose} for the editor.
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

// Toolbar buttons should be present.
const buttons = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('button'));
  return {
    table: all.some((b) => b.textContent?.includes('▦ Table')),
    figure: all.some((b) => b.textContent?.includes('🖼 Figure')),
    changes: all.some((b) => b.textContent?.includes('🔖 Changes')),
    find: all.some((b) => b.textContent?.includes('🔍 Find')),
    symbols: all.some((b) => b.textContent?.includes('Σ Symbols')),
    cite: all.some((b) => b.textContent?.includes('📚 Cite')),
  };
});
console.log('toolbar buttons:', buttons);

// Spell filter : the math/cite/ref nodes should have spellcheck="false".
await page.evaluate(() => {
  // Insert a fake math node to test spell filter
  const surf = document.querySelector('[data-testid="latex-wysiwyg-surface"]');
  if (!surf) return;
  const span = document.createElement('span');
  span.className = 'math-inline';
  span.setAttribute('data-tex', 'x');
  span.textContent = '$x$';
  surf.appendChild(span);
});
await new Promise((r) => setTimeout(r, 300));
const spell = await page.evaluate(() => {
  const m = document.querySelector('[data-testid="latex-wysiwyg-surface"] .math-inline');
  return { mathSpellAttr: m?.getAttribute('spellcheck') ?? null };
});
console.log('spell filter on new math node:', spell);

// Click Table button → wizard opens
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('▦ Table'));
  btn?.click();
});
await new Promise((r) => setTimeout(r, 400));
const tableWiz = await page.evaluate(() => ({
  modalPresent: !!document.querySelector('.modal-open'),
  hasRowsInput: Array.from(document.querySelectorAll('input[type="number"]')).length > 0,
}));
console.log('table wizard opened:', tableWiz);

// Templates gallery via window event
await page.evaluate(() => window.dispatchEvent(new CustomEvent('weft-loom:open-project-templates')));
await new Promise((r) => setTimeout(r, 500));
const gallery = await page.evaluate(() => ({
  galleryPresent: document.querySelectorAll('.modal-open').length >= 1,
}));
console.log('templates gallery via event:', gallery);

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
