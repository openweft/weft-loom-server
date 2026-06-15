// diag-open-existing.mjs — opens the user's actual untitled-jg18.tex
// and dumps EVERYTHING we know about the editor state for analysis.
// Not a pass/fail test, a diagnostic dump.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const F = 'untitled-jg18.tex';

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });

const events = [];
const requests = [];
page.on('console', (m) => events.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => events.push({ type: 'pageerror', text: e.message }));
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/api/') || u.startsWith('ws://')) {
    requests.push({ method: r.method(), url: u.replace(ROOT, '') });
  }
});
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('untitled-jg18') || u.includes('seed-claim')) {
    requests.push({ status: r.status(), url: u.replace(ROOT, '') });
  }
});

await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

console.log('=== state BEFORE opening file ===');
const before = await page.evaluate(() => ({
  cmEditorExists: !!document.querySelector('.cm-editor'),
  weftOpen: typeof window.weftLoomOpenFile,
  awareness: typeof window.weftLoomAwareness,
}));
console.log(JSON.stringify(before, null, 2));

console.log('\n=== opening ' + F + ' ===');
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 5000));

console.log('\n=== state AFTER opening file (5s wait) ===');
const after = await page.evaluate(() => {
  const editor = document.querySelector('.cm-editor');
  const content = document.querySelector('.cm-content');
  const lines = Array.from(document.querySelectorAll('.cm-line')).map((l) => ({
    text: l.textContent,
    html: l.innerHTML.slice(0, 80),
  }));
  return {
    editorExists: !!editor,
    contentExists: !!content,
    invisibleAttr: editor?.getAttribute('data-weft-loom-invisible') ?? null,
    contentRect: content?.getBoundingClientRect() ?? null,
    cmLineCount: lines.length,
    cmLineFirst5: lines.slice(0, 5),
    docText: lines.map((l) => l.text).join('\n').slice(0, 300),
    computedStyle: content ? {
      color: getComputedStyle(content).color,
      bg: getComputedStyle(content).backgroundColor,
      opacity: getComputedStyle(content).opacity,
      visibility: getComputedStyle(content).visibility,
      fontSize: getComputedStyle(content).fontSize,
    } : null,
  };
});
console.log(JSON.stringify(after, null, 2));

console.log('\n=== ALL console events ===');
events
  .slice(0, 40)
  .forEach((e) => console.log('  [' + e.type + '] ' + e.text.slice(0, 250)));

console.log('\n=== network requests (filtered) ===');
requests.slice(0, 30).forEach((r) =>
  console.log('  ' + (r.method || r.status) + ' ' + r.url));

await br.close();
