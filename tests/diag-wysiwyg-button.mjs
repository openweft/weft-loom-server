// diag-wysiwyg-button.mjs — assert the WYSIWYG toolbar button
// dispatches the toggle event + the PreviewPane responds.

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

// 1. The "Rich Text" + "Source" toggle is gone.
const obsoleteToggles = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  return {
    richText: buttons.some((b) => b.textContent?.includes('Rich Text')),
    source: buttons.some((b) => b.textContent?.includes('Source') && b.textContent?.includes('</>')),
  };
});
console.log('Obsolete toggles (both should be false):', obsoleteToggles);

// 2. The WYSIWYG button is present.
const wysiwygBtn = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) =>
    x.textContent?.includes('WYSIWYG'));
  return { present: !!b, title: b?.getAttribute('title') ?? '' };
});
console.log('WYSIWYG button:', wysiwygBtn);

// 3. Clicking the WYSIWYG button toggles the PreviewPane.
const before = await page.evaluate(() => !!document.querySelector('[data-testid="preview-pane"]') ||
  !!document.querySelector('.preview-pane'));
const wysiwygEl = await page.evaluateHandle(() =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('WYSIWYG')));
await wysiwygEl.asElement()?.click();
await new Promise((r) => setTimeout(r, 600));
const after = await page.evaluate(() => !!document.querySelector('[data-testid="preview-pane"]') ||
  !!document.querySelector('.preview-pane'));
console.log('Preview pane before WYSIWYG click:', before, '/ after:', after, '/ toggled:', before !== after);

await br.close();
