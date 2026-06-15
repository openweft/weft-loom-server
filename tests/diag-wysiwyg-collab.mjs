// diag-wysiwyg-collab.mjs — V0.9 end-to-end : two puppeteer pages
// open the same .tex in WYSIWYG, one edits, the other receives.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-collab-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}
Initial body text.
\\end{document}
`;

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'PUT', body: SRC,
});

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pageA = await br.newPage();
const pageB = await br.newPage();
await pageA.setViewport({ width: 1400, height: 900 });
await pageB.setViewport({ width: 1400, height: 900 });

// Open both pages in WYSIWYG mode on the same file.
for (const p of [pageA, pageB]) {
  await p.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2000));
  await p.evaluate(() => localStorage.setItem('weft-loom-tex-wysiwyg', 'wysiwyg'));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));
  await p.evaluate((path) => window.weftLoomOpenFile(path), F);
  await new Promise((r) => setTimeout(r, 4500));
}

// Initial state : both pages show "Initial body text."
const initial = {
  A: await pageA.evaluate(() =>
    document.querySelector('[data-testid="latex-wysiwyg-surface"]')?.textContent ?? null),
  B: await pageB.evaluate(() =>
    document.querySelector('[data-testid="latex-wysiwyg-surface"]')?.textContent ?? null),
};
console.log('initial state:', initial);

// Page A edits : append " EDIT-FROM-A" to the body.
await pageA.evaluate(() => {
  const surf = document.querySelector('[data-testid="latex-wysiwyg-surface"]');
  if (!surf) return;
  const p = surf.querySelector('p');
  if (!p) return;
  p.textContent = (p.textContent ?? '') + ' EDIT-FROM-A';
  // Fire input event so onInput → pushToYtext.
  surf.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2000));

const afterAEdit = {
  A: await pageA.evaluate(() =>
    document.querySelector('[data-testid="latex-wysiwyg-surface"]')?.textContent ?? null),
  B: await pageB.evaluate(() =>
    document.querySelector('[data-testid="latex-wysiwyg-surface"]')?.textContent ?? null),
};
console.log('after A edits:', afterAEdit);

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
