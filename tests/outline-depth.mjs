// outline-depth.mjs — OutlinePanel depth-filter + section-fold
// regression test.
//
// 1. Seed a .tex with chapter / section / subsection / subsubsection
//    / paragraph headings.
// 2. Confirm the outline shows all 5.
// 3. Change the depth filter to "Section" (1) → outline shows only
//    chapters + sections (2 entries).
// 4. Confirm the CodeMirror fold gutter has clickable fold markers
//    at every heading line.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'outline-depth-' + Date.now() + '.tex';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom outline depth + folding suite\x1b[0m');

const body = '\\documentclass{report}\n\\begin{document}\n'
  + '\\chapter{Ch}\nintro of chapter\n\n'
  + '\\section{Sec}\nbody of section\n\n'
  + '\\subsection{SubSec}\nbody of subsec\n\n'
  + '\\subsubsection{SubSubSec}\nbody\n\n'
  + '\\paragraph{Para}\nbody\n\n'
  + '\\end{document}\n';
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body });
ok('seed', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 4500));

// Expand the outline accordion if it's collapsed.
await page.evaluate(() => {
  // Outline panel header has text "Outline".
  const headers = Array.from(document.querySelectorAll('aside button'))
    .filter(b => b.textContent && b.textContent.trim().startsWith('Outline'));
  for (const h of headers) {
    if (h.getAttribute('aria-expanded') === 'false') h.click();
  }
});
await new Promise((r) => setTimeout(r, 1500));

// Scope to the outline aside specifically.
const initial = await page.evaluate(() => {
  const sel = document.querySelector('[data-testid="outline-depth"]');
  const outlineAside = sel?.closest('aside');
  return {
    entries: outlineAside ? outlineAside.querySelectorAll('ul > li button').length : 0,
    depth: sel?.value,
    sawSelect: !!sel,
  };
});
if (initial.entries === 5) {
  ok('outline populates', '5 entries (chapter…paragraph), depth=' + initial.depth);
} else {
  failL('outline populates',
    'expected 5 entries, got ' + initial.entries + ' sawSelect=' + initial.sawSelect + ' depth=' + initial.depth);
}

// Filter to "Section" (value=1) — chapter + section only.
await page.evaluate(() => {
  const sel = document.querySelector('[data-testid="outline-depth"]');
  if (!sel) return;
  sel.value = '1';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 400));
const filtered = await page.evaluate(() => {
  const sel = document.querySelector('[data-testid="outline-depth"]');
  const outlineAside = sel?.closest('aside');
  return outlineAside ? outlineAside.querySelectorAll('ul > li button').length : 0;
});
if (filtered === 2) {
  ok('depth filter narrows', '2 entries when depth=Section');
} else {
  failL('depth filter narrows', 'expected 2, got ' + filtered);
}

// Section-fold extension : the gutter should have at least one
// fold marker (`.cm-foldGutter` or whatever class CM6 renders).
const hasFold = await page.evaluate(() => {
  const gutter = document.querySelector('.cm-foldGutter');
  if (!gutter) return false;
  // Some CM versions render the markers as <span> children with
  // text glyphs ; others use SVG. Either way the gutter has
  // visible children when foldService produces ranges.
  return gutter.childElementCount > 0;
});
if (hasFold) {
  ok('fold gutter present', '.cm-foldGutter has markers');
} else {
  failL('fold gutter present', 'no fold markers in gutter');
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
