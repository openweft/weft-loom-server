// diag-wysiwyg-v13.mjs — V0.13 end-to-end : verify MathLive
// visual mode loads + Zotero settings inputs surface.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'wysiwyg-v13-' + Date.now() + '.tex';

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
await page.evaluate(() => localStorage.setItem('weft-loom-tex-wysiwyg', 'wysiwyg'));
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 4500));

// 1. Open math popover by clicking the rendered inline math
await page.evaluate(() => {
  const m = document.querySelector('.math-inline');
  m?.click();
});
await new Promise((r) => setTimeout(r, 500));

const popoverState = await page.evaluate(() => {
  const p = document.querySelector('[data-testid="math-popover"]');
  if (!p) return { open: false };
  const buttons = Array.from(p.querySelectorAll('button')).map((b) => b.textContent?.trim());
  return {
    open: true,
    hasSourceToggle: buttons.some((t) => t === 'Source'),
    hasVisualToggle: buttons.some((t) => t === 'Visual'),
  };
});
console.log('math popover state:', popoverState);

// 2. Click Visual → mathlive loads
const visualBtn = await page.evaluateHandle(() => {
  const p = document.querySelector('[data-testid="math-popover"]');
  return Array.from(p?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.trim() === 'Visual');
});
await visualBtn.asElement()?.click();
await new Promise((r) => setTimeout(r, 3000)); // wait for lazy import

const visualMode = await page.evaluate(() => {
  const p = document.querySelector('[data-testid="math-popover"]');
  if (!p) return { mathField: false };
  return {
    mathField: !!p.querySelector('math-field'),
  };
});
console.log('after Visual click:', visualMode);

// 3. Open Settings + verify Zotero inputs present
await br.close();
const br2 = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const p2 = await br2.newPage();
await p2.setViewport({ width: 1400, height: 900 });
await p2.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
// Trigger settings open via Cmd+, or window event
await p2.evaluate(() => {
  // Find a settings button or trigger
  const btns = Array.from(document.querySelectorAll('button'));
  const settingsBtn = btns.find((b) => /Settings/i.test(b.textContent || b.getAttribute('aria-label') || ''));
  settingsBtn?.click();
});
await new Promise((r) => setTimeout(r, 800));

const settingsInputs = await p2.evaluate(() => {
  // Look for Zotero-labeled fields anywhere on the page
  const all = Array.from(document.querySelectorAll('input, label, span, button'));
  const hasZoteroText = all.some((el) => /zotero/i.test(el.textContent || ''));
  const inputs = Array.from(document.querySelectorAll('input'));
  const hasPasswordInput = inputs.some((i) => i.type === 'password');
  return { hasZoteroText, hasPasswordInput };
});
console.log('settings panel:', settingsInputs);

await br2.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
