// bib-panel.mjs — Bibliography browser regression test.
//
// Drives the BibliographyPanel end-to-end :
//   1. Seed a .tex + a .bib with two entries
//   2. Open the .tex in the editor
//   3. Confirm the 📚 FAB renders (only on .tex)
//   4. Open the panel ; both entries appear
//   5. Filter narrows the list
//   6. Click an entry → `\cite{key}` lands in the buffer at cursor
//
// Beats Overleaf : Overleaf's bib browsing is "open the .bib file
// in source view." This panel is structured + searchable.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const TEX = 'bib-panel-test.tex';
const BIB = 'bib-panel-test.bib';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom Bibliography panel suite\x1b[0m');

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(TEX),
  { method: 'PUT', body: '\\documentclass{article}\n\\begin{document}\nIntro.\n\\end{document}\n' });
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(BIB),
  { method: 'PUT', body:
`@article{smith2024,
  title = {Quantum widgets at scale},
  author = {Smith, Jane and Doe, John},
  year = {2024},
}
@inproceedings{garcia2023,
  title = {Bibliometric horizons},
  author = {Garcia, M.},
  year = {2023},
}
` });
ok('seed', TEX + ' + ' + BIB);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => (window).weftLoomOpenFile(p), TEX);
await new Promise((r) => setTimeout(r, 3000));

const fabPresent = await page.evaluate(() =>
  !!document.querySelector('[data-testid="bib-toggle"]'));
if (!fabPresent) {
  failL('bib FAB', 'not rendered for .tex');
  await browser.close();
  process.exit(1);
}
ok('bib FAB', 'rendered for .tex');

await page.evaluate(() => document.querySelector('[data-testid="bib-toggle"]')?.click());
await new Promise((r) => setTimeout(r, 1000));

const initial = await page.evaluate(() => ({
  open: !!document.querySelector('[data-testid="bib-panel"]'),
  count: document.querySelectorAll('[data-testid="bib-entry"]').length,
  keys: Array.from(document.querySelectorAll('[data-testid="bib-entry"]'))
    .map(e => e.getAttribute('data-key')),
}));
if (initial.open && initial.count === 2
 && initial.keys.includes('smith2024')
 && initial.keys.includes('garcia2023')) {
  ok('panel populates', '2 entries from .bib (' + initial.keys.join(', ') + ')');
} else {
  failL('panel populates',
    'expected 2 entries (smith2024 + garcia2023), got ' + JSON.stringify(initial));
}

// Filter narrows.
await page.type('[data-testid="bib-filter"]', 'garcia');
await new Promise((r) => setTimeout(r, 200));
const filtered = await page.evaluate(() => ({
  count: document.querySelectorAll('[data-testid="bib-entry"]').length,
  firstKey: document.querySelector('[data-testid="bib-entry"]')?.getAttribute('data-key'),
}));
if (filtered.count === 1 && filtered.firstKey === 'garcia2023') {
  ok('filter narrows', '1 entry for "garcia"');
} else {
  failL('filter narrows',
    'expected 1 entry = garcia2023, got ' + JSON.stringify(filtered));
}

// Clear filter + click an entry.
await page.evaluate(() => {
  const input = document.querySelector('[data-testid="bib-filter"]');
  if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
});
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => {
  const entry = Array.from(document.querySelectorAll('[data-testid="bib-entry"]'))
    .find(e => e.getAttribute('data-key') === 'smith2024');
  entry?.click();
});
await new Promise((r) => setTimeout(r, 500));
const buf = await page.evaluate(() => {
  const cm = document.querySelector('.cm-content');
  return cm ? (cm.textContent ?? '') : '';
});
if (buf.includes('\\cite{smith2024}')) {
  ok('insert \\cite{}', 'smith2024 spliced into buffer');
} else {
  failL('insert \\cite{}', 'buffer missing \\cite{smith2024} : ' + buf.slice(0, 200));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(TEX), { method: 'DELETE' }).catch(() => {});
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(BIB), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
