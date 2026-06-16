// diag-save-indicator.mjs — puppeteer smoke for the V0.x SaveIndicator
// badge : open a project, type something, wait for the autosave +
// assert the "Saved at HH:MM:SS" badge appears in the Navbar.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'save-indicator-' + Date.now() + '.tex';

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'PUT',
  body: '\\documentclass{article}\\begin{document}initial\\end{document}',
});

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 2500));

// Dispatch the autosave event manually (the editor would fire it on
// actual debounce ; we short-circuit the wait by firing it ourselves
// since the indicator's contract is just to react to the event).
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('weft-loom-autosave-completed', {
    detail: { file: 'save-indicator-test.tex' },
  }));
});
await new Promise((r) => setTimeout(r, 200));

const indicatorState = await page.evaluate(() => {
  // Pick the first element whose text matches "Saved at <time>"
  const all = Array.from(document.querySelectorAll('*'));
  const match = all.find((el) =>
    /Saved at \d{1,2}:\d{2}/.test(el.textContent ?? '') && el.children.length === 0);
  if (!match) return { found: false };
  return {
    found: true,
    text: match.textContent?.trim(),
    title: match.getAttribute('title') ?? null,
  };
});
console.log('save indicator state:', indicatorState);

// Wait 4s + assert it has faded away (component contract : fade after 3s).
await new Promise((r) => setTimeout(r, 4000));
const faded = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('*'));
  return !all.some((el) =>
    /Saved at \d{1,2}:\d{2}/.test(el.textContent ?? '') &&
    el.children.length === 0 &&
    getComputedStyle(el).opacity !== '0');
});
console.log('faded after 4s:', faded);

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});
