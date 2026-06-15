// diag-wysiwyg-v08.mjs — V0.8 end-to-end : auto-numbered refs,
// find&replace popover, image drag-drop wire-up (we don't fake a
// real drop but verify the dropzone is wired).

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-v08-' + Date.now() + '.tex';

const SRC = `\\documentclass{article}
\\begin{document}

\\section{Intro}\\label{sec:intro}

See \\ref{sec:intro} and \\ref{eq:einstein}.

\\begin{equation}
\\label{eq:einstein}
E = mc^2
\\end{equation}

The quick brown fox jumps over the lazy dog.
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

// 1. Refs resolved : sec:intro should show "Section 1", eq:einstein should show "Eq. (1)"
const refsInspection = await page.evaluate(() => {
  const refs = Array.from(document.querySelectorAll('.latex-ref')).map((el) => ({
    label: el.getAttribute('data-label'),
    text: el.textContent,
  }));
  return refs;
});
console.log('refs resolved:', refsInspection);

// 2. Open Find & Replace via the toolbar button
const findBtn = await page.evaluateHandle(() =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Find')));
await findBtn.asElement()?.click();
await new Promise((r) => setTimeout(r, 400));

const findOpen = await page.evaluate(() => ({
  popoverPresent: !!document.querySelector('input[placeholder*="Find"]') ||
                   document.querySelector('.card input[type="text"], .card input:not([type])') !== null,
}));
console.log('find popover opened:', findOpen);

// 3. Type "fox" + count matches by looking for <mark.wysiwyg-find-hit> nodes
await page.evaluate(() => {
  const inputs = document.querySelectorAll('input');
  let findInput = null;
  for (const inp of inputs) {
    if (inp.placeholder && /find|search/i.test(inp.placeholder)) {
      findInput = inp;
      break;
    }
  }
  if (!findInput) {
    // Fallback : the first text input inside a popover-style card
    findInput = document.querySelector('.card input');
  }
  if (findInput) {
    findInput.focus();
    findInput.value = 'fox';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await new Promise((r) => setTimeout(r, 500));

const findMatches = await page.evaluate(() => ({
  hitCount: document.querySelectorAll('mark.wysiwyg-find-hit').length,
}));
console.log('after typing "fox":', findMatches);

// 4. Drop-zone wiring : dispatch a synthetic dragover + see preventDefault
const dropWired = await page.evaluate(() => {
  const surf = document.querySelector('[data-testid="latex-wysiwyg-surface"]');
  if (!surf) return { wired: false };
  const ev = new DragEvent('dragover', { bubbles: true, cancelable: true });
  surf.dispatchEvent(ev);
  return { wired: ev.defaultPrevented };
});
console.log('drop-zone wired:', dropWired);

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
