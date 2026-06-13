// inline-math.mjs — CodeMirror inline KaTeX rendering regression
// test.
//
// Seeds a .tex file with one inline `$E=mc^2$`, one display
// `$$\int...$$`, one TeX-style `\(\alpha\)`, and one TeX-style
// `\[\beta\]`. Opens it ; verifies that 4 KaTeX widgets appear
// in the CodeMirror DOM ; clicks into one of them + asserts the
// raw source becomes visible again (cursor-inside disables the
// widget so the user can edit).

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
// Unique filename per run so Yjs's server-side state cache doesn't
// replay a stale empty doc for this test path.
const PATH = 'inline-math-test-' + Date.now() + '.tex';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom inline math rendering suite\x1b[0m');

// Compact seed : 4 math segments, no surrounding prose, so the
// Yjs seed-from-disk path doesn't choke on large escape-heavy
// content.
const body = '\\documentclass{article}\n\\begin{document}\n'
  + '$E = mc^2$ inline\n\n'
  + '\\(\\alpha + \\beta\\) tex-inline\n\n'
  + '$$\\int x dx = x^2/2$$\n\n'
  + '\\[\\sum_{i=1}^{n} i\\]\n\n'
  + '\\end{document}\n';

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body });
ok('seed', PATH + ' (' + body.length + ' bytes)');

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
page.on('console', msg => {
  if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text().slice(0, 200));
});
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 4500));

// Newly-opened editor defaults to caret at position 0, which is
// outside every math segment ; all 4 widgets should render
// without needing to dispatch a selection effect.
const probe = await page.evaluate(() => ({
  docLen: (document.querySelector('.cm-content')?.textContent ?? '').length,
  docFirst80: (document.querySelector('.cm-content')?.textContent ?? '').slice(0, 80),
  tabs: Array.from(document.querySelectorAll('[data-testid="tab"], .tab')).map(t => t.textContent?.trim()).slice(0, 4),
  fileInUrl: new URL(location.href).searchParams.get('file'),
}));
if (probe.docLen < 50) {
  failL('doc loaded', 'editor still empty after 4 s : '
    + JSON.stringify(probe) + ' errors: ' + errors.slice(0, 3).join(' | '));
} else {
  ok('doc loaded', probe.docLen + ' chars in buffer');
}

const counts = await page.evaluate(() => {
  return {
    inline: document.querySelectorAll('.cm-inline-math:not(.cm-inline-math-display)').length,
    display: document.querySelectorAll('.cm-inline-math-display').length,
    katexAny: document.querySelectorAll('.katex').length,
    errors: document.querySelectorAll('.cm-inline-math-error').length,
  };
});
// Expected : 2 inline (`$E=mc^2$` + `\(\alpha+\beta\)`), 2 display
// (`$$\int...$$` + `\[\sum...\]`). The katex.renderToString output
// always contains a `.katex` element, so katexAny ≥ 4 is the
// strict check.
if (counts.inline === 2 && counts.display === 2) {
  ok('widget counts', '2 inline + 2 display math segments rendered');
} else {
  failL('widget counts',
    'expected 2 inline + 2 display, got ' + JSON.stringify(counts));
}
if (counts.katexAny >= 4) {
  ok('katex output', counts.katexAny + ' .katex spans in DOM');
} else {
  failL('katex output', 'expected ≥4 .katex spans, got ' + counts.katexAny);
}
if (counts.errors === 0) {
  ok('no render errors', '0 .cm-inline-math-error widgets');
} else {
  failL('no render errors', counts.errors + ' KaTeX errors');
}

// Click directly on the first rendered KaTeX widget : CodeMirror
// catches the click + places the caret inside the segment, the
// view-plugin's caret-inside heuristic then hides the widget so
// the user can edit the source.
const clicked = await page.evaluate(() => {
  const widget = document.querySelector('.cm-inline-math:not(.cm-inline-math-display)');
  if (!widget) return false;
  const rect = widget.getBoundingClientRect();
  const ev = new MouseEvent('mousedown', {
    bubbles: true, cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  });
  widget.dispatchEvent(ev);
  widget.click();
  return true;
});
await new Promise((r) => setTimeout(r, 600));
const afterCount = await page.evaluate(() => ({
  inline: document.querySelectorAll('.cm-inline-math:not(.cm-inline-math-display)').length,
  display: document.querySelectorAll('.cm-inline-math-display').length,
}));
if (clicked && afterCount.inline < 2) {
  ok('cursor-inside reveals source',
    'inline widget count dropped from 2 to ' + afterCount.inline + ' after caret-in');
} else {
  failL('cursor-inside reveals source',
    'expected fewer inline widgets after click, got ' + JSON.stringify(afterCount));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
