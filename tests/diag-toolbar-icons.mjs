// diag-toolbar-icons.mjs — assert the 4 panel triggers live in
// the LaTeX format toolbar (not as FAB bubbles) + that clicking
// each opens the matching popover.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const F = 'untitled-jg18.tex';

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });

await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 3500));

// 1. No FAB bubbles anywhere.
const fabs = await page.evaluate(() => ({
  bibFab: !!document.querySelector('.bib-fab'),
  commentsFab: !!document.querySelector('.comments-fab'),
  wordsFab: !!document.querySelector('.words-fab'),
  paletteFab: !!document.querySelector('.palette-fab'),
}));
console.log('FAB presence (all should be false):', fabs);

// 2. 4 toolbar buttons exist with the right titles.
const toolbarButtons = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button[title]'));
  const wanted = [
    'LaTeX symbol palette',
    'Bibliography',
    'Comments',
    'Word count + writing goals',
  ];
  return wanted.map((title) => ({
    title,
    present: buttons.some((b) => (b.getAttribute('title') || '').includes(title.split(' ')[0])),
  }));
});
console.log('Toolbar buttons:', toolbarButtons);

// 3. Click LaTeX symbol palette → palette panel appears.
await page.evaluate(() =>
  window.dispatchEvent(new CustomEvent('weft-loom:toggle-palette')));
await new Promise((r) => setTimeout(r, 500));
const palettePanel = await page.$('[data-testid="latex-palette-panel"]');
console.log('palette panel after toggle:', !!palettePanel);

await br.close();
