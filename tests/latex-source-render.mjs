// latex-source-render.mjs — regression for the user-reported issue
// "les sources latex ne s'affichent pas correctement quand j'ouvre un
// fichier". Covers every angle of opening a .tex file :
//
//   1. Seed a fixture on disk
//   2. Open via weftLoomOpenFile (the path FileExplorer uses)
//   3. Verify the editor mounts
//   4. Verify the content matches the on-disk bytes line-for-line
//   5. Verify LaTeX syntax highlighting fires (CodeMirror emits
//      hashed ͼ-prefixed classes on tokens — their presence proves
//      the language pack is reconfigured + the parser actually parsed)
//   6. Verify the statusbar reports "LaTeX" as the active language
//   7. Switch to a different file + back — verify content + tokens
//      survive the round-trip (catches Compartment / seed races)
//   8. Open a freshly-seeded NEW file (never opened before) and
//      verify it still shows content (catches the seed-claim path)

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F1 = 'latex-render-' + Date.now() + '.tex';
const F2 = 'latex-render-' + Date.now() + '-other.tex';
const F3 = 'latex-render-' + Date.now() + '-fresh.tex';

const SRC1 = '\\documentclass{article}\n\\begin{document}\nHello \\textbf{world}.\n\\section{Intro}\nFoo bar baz.\n\\end{document}\n';
const SRC2 = '\\documentclass{report}\n\\begin{document}\nDIFFERENT file content here.\n\\end{document}\n';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom LaTeX source render suite\x1b[0m');

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F1), { method: 'PUT', body: SRC1 });
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F2), { method: 'PUT', body: SRC2 });
ok('seed fixtures', F1 + ' + ' + F2);

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

// (2) Open via weftLoomOpenFile
await page.evaluate((p) => window.weftLoomOpenFile(p), F1);
await new Promise((r) => setTimeout(r, 3500));

// (3) Editor mounted ?
const mounted = await page.evaluate(() => ({
  editor: !!document.querySelector('.cm-editor'),
  content: !!document.querySelector('.cm-content'),
}));
if (mounted.editor && mounted.content) ok('editor mounted', 'cm-editor + cm-content present');
else failL('editor mounted', JSON.stringify(mounted));

// (4) Content matches on-disk bytes. CodeMirror keeps a trailing
// empty .cm-line when the source ends in \n, so we compare the
// trimmed text against the trimmed source.
const renderedText = await page.evaluate(() => {
  const lines = Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent);
  return lines.join('\n');
});
const expectedText = SRC1.replace(/\n+$/, '');
const actualTrimmed = renderedText.replace(/\n+$/, '');
if (actualTrimmed === expectedText) {
  ok('content matches on-disk source', expectedText.length + ' bytes');
} else if (actualTrimmed.length === 0) {
  failL('content empty', '/// USER-REPORTED BUG /// editor mounted with no content (' + expectedText.length + ' bytes expected)');
} else {
  failL('content mismatch', 'expected ' + JSON.stringify(expectedText.slice(0, 60)) + ', got ' + JSON.stringify(actualTrimmed.slice(0, 60)));
}

// (5) Syntax-highlight tokens
const sx = await page.evaluate(() => {
  // CodeMirror compiles styleTags down to hashed class names with
  // the ͼ U+036C prefix. Their presence proves the language pack
  // PARSED the buffer (not just dumped it as plain text).
  const tokens = Array.from(document.querySelectorAll('.cm-content [class*="ͼ"]'));
  const sample = tokens[0]?.outerHTML?.slice(0, 100) ?? '';
  return { count: tokens.length, sample };
});
if (sx.count >= 4) {
  ok('LaTeX syntax highlighting active', sx.count + ' tokens highlighted');
} else {
  failL('LaTeX syntax highlighting active', JSON.stringify(sx));
}

// (6) Statusbar language indicator — surfaced via a span with
// title="Editor language" in StatusBar.svelte (no testid).
const lang = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[title="Editor language"]'))
    .map((el) => el.textContent?.trim())
    .find((t) => t && t.length > 0) ?? '');
if (lang && /latex/i.test(lang)) {
  ok('language detected as LaTeX', lang);
} else {
  failL('language detected as LaTeX', JSON.stringify(lang));
}

// (7) Switch to a different file, then back — content must survive
await page.evaluate((p) => window.weftLoomOpenFile(p), F2);
await new Promise((r) => setTimeout(r, 2500));
const text2 = (await page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'))).replace(/\n+$/, '');
if (text2 === SRC2.replace(/\n+$/, '')) {
  ok('second file content', SRC2.length + ' bytes');
} else {
  failL('second file content', 'got: ' + JSON.stringify(text2.slice(0, 80)));
}
await page.evaluate((p) => window.weftLoomOpenFile(p), F1);
await new Promise((r) => setTimeout(r, 2500));
const text1again = (await page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'))).replace(/\n+$/, '');
if (text1again === expectedText) {
  ok('content survives round-trip', 'F1 → F2 → F1');
} else {
  failL('content survives round-trip', 'got: ' + JSON.stringify(text1again.slice(0, 80)));
}

// (8) Fresh file never opened before — seed it on disk right before
// opening so the SPA hits the seed-claim path.
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F3), {
  method: 'PUT', body: '\\documentclass{article}\\begin{document}\nFresh seed test.\n\\end{document}\n',
});
await new Promise((r) => setTimeout(r, 200));
await page.evaluate((p) => window.weftLoomOpenFile(p), F3);
await new Promise((r) => setTimeout(r, 4000));
const freshText = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'));
if (freshText.includes('Fresh seed test.')) {
  ok('fresh file via seed-claim path', freshText.length + ' bytes');
} else {
  failL('fresh file via seed-claim path', 'got: ' + JSON.stringify(freshText.slice(0, 80)));
}

if (pageErrors.length > 0) {
  failL('no page errors', pageErrors.slice(0, 3).join(' | '));
} else {
  ok('no page errors');
}

await br.close();
// Cleanup
for (const f of [F1, F2, F3]) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(f), { method: 'DELETE' }).catch(() => {});
}

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
