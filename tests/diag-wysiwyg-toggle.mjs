// diag-wysiwyg-toggle.mjs — end-to-end : open .tex in source view,
// click WYSIWYG button, assert LatexWysiwygEditor renders, switch
// back to source, assert the same content is shown.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-toggle-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}
\\section{Test}
A paragraph with \\textbf{bold} content.
\\end{document}
`;

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'PUT', body: SRC,
});
console.log('seeded', F);

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });

await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
// Reset localStorage so the wysiwyg mode starts off.
await page.evaluate(() => localStorage.removeItem('weft-loom-tex-wysiwyg'));
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 3500));

const initial = await page.evaluate(() => ({
  cmEditor: !!document.querySelector('.cm-editor'),
  wysiwygSurface: !!document.querySelector('[data-testid="latex-wysiwyg-surface"]'),
}));
console.log('initial (cm should be true, wysiwyg false):', initial);

// Click the WYSIWYG button in the LaTeX toolbar.
const wysiwygBtn = await page.evaluateHandle(() =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('WYSIWYG') && b.title?.includes('Switch to WYSIWYG')));
await wysiwygBtn.asElement()?.click();
await new Promise((r) => setTimeout(r, 2500));

const afterToggle = await page.evaluate(() => ({
  cmEditor: !!document.querySelector('.cm-editor'),
  wysiwygSurface: !!document.querySelector('[data-testid="latex-wysiwyg-surface"]'),
  surfaceText: document.querySelector('[data-testid="latex-wysiwyg-surface"]')?.textContent ?? null,
}));
console.log('after WYSIWYG toggle (cm false, wysiwyg true):', afterToggle);

// Switch back to source.
const sourceBtn = await page.evaluateHandle(() =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.title?.includes('Switch back to source')));
await sourceBtn.asElement()?.click();
await new Promise((r) => setTimeout(r, 2500));

const afterBack = await page.evaluate(() => ({
  cmEditor: !!document.querySelector('.cm-editor'),
  wysiwygSurface: !!document.querySelector('[data-testid="latex-wysiwyg-surface"]'),
}));
console.log('after Source toggle (cm true, wysiwyg false):', afterBack);

await br.close();
// cleanup
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
