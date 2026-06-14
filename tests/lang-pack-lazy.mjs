// lang-pack-lazy.mjs — regression guard for CodeMirror language pack
// code-splitting.
//
// Each @codemirror/lang-* package is 50-150 KB. The Editor used to
// import every pack synchronously, dragging all of them into the
// main cold-load chunk. We refactored Editor.svelte to lazy-load
// the packs via dynamic import() inside loadLanguagePack(), driven
// by the existing languageCompartment.reconfigure path. This test
// asserts the split actually shipped :
//
//   1. After the SPA boots (before any file open) NO /assets/*lang-
//      latex*.js chunk has been requested. (If the synchronous
//      import sneaks back in, every pack would be inlined into the
//      main chunk OR pre-fetched on boot, breaking the asserted
//      isolation.)
//   2. Opening a .tex file triggers a network request for the latex
//      chunk (legacy-modes/stex shipped via the dynamic import).
//   3. Opening a second .tex file in the same session does NOT
//      trigger a second chunk fetch — the module-scope packCache
//      Map hands back the resolved Extension instantly.
//
// Detection : page.on('request') captures every URL the page asks
// for. We match on '/assets/' AND ('stex' OR 'legacy-modes' OR
// 'lang-latex') to be resilient to whatever chunk filename Vite
// picks. Editor.svelte's loadLanguagePack uses
// `import('@codemirror/legacy-modes/mode/stex')` for latex, so the
// emitted chunk name contains 'stex' OR 'legacy-modes'.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH1 = 'lang-pack-lazy-' + Date.now() + '-a.tex';
const PATH2 = 'lang-pack-lazy-' + Date.now() + '-b.tex';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom language pack lazy-load suite\x1b[0m');

// Seed two .tex files so we can probe the cache hit path. Content
// is minimal — the lazy-load assertion only cares about the chunk
// network log, not what's in the buffer.
const body = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n';
for (const p of [PATH1, PATH2]) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(p),
    { method: 'PUT', body });
}
ok('seed', PATH1 + ' + ' + PATH2);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();

// Capture every JS-asset request — that's what Vite emits under
// /assets/. Heuristic match for the latex pack covers whatever
// hashed filename Vite picks. We log the FULL list once at the end
// for diagnostics.
const assetReqs = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('/assets/') && (u.endsWith('.js') || u.includes('.js?'))) {
    assetReqs.push(u);
  }
});

const isLatexChunk = (u) =>
  /\/assets\/[^?]*(stex|legacy-modes|lang-latex|lang-stex)[^?]*\.js/i.test(u);

await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
// Generous wait : SPA boots, settings hydrate, file list renders.
// No file is open yet so no language pack should have been touched.
await new Promise((r) => setTimeout(r, 3000));

const preOpenLatexChunks = assetReqs.filter(isLatexChunk);
if (preOpenLatexChunks.length === 0) {
  ok('cold-load excludes latex pack',
    assetReqs.length + ' /assets/*.js requests, 0 match latex pack');
} else {
  failL('cold-load excludes latex pack',
    'expected 0 latex-pack chunks before any file open, saw : '
    + preOpenLatexChunks.join(', '));
}

// First .tex open : should fetch the latex chunk.
const beforeOpen1 = assetReqs.length;
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH1);
// Editor mount + seed-from-disk path + dynamic import resolution
// all happen in this window. 4500 ms mirrors the inline-math suite
// where the editor doc + KaTeX widgets settle.
await new Promise((r) => setTimeout(r, 4500));

const afterOpen1 = assetReqs.slice(beforeOpen1);
const latex1 = afterOpen1.filter(isLatexChunk);
if (latex1.length >= 1) {
  ok('first .tex open fetches latex chunk',
    latex1[0].replace(ROOT, ''));
} else {
  failL('first .tex open fetches latex chunk',
    'expected >=1 latex chunk after opening ' + PATH1
    + '. /assets/*.js since open : ' + JSON.stringify(afterOpen1, null, 0));
}

// Second .tex open : cache hit → NO new latex chunk request.
// (Other chunks may still come in — e.g. on-demand panels — so we
// scope the assertion strictly to the latex-pack matcher.)
const beforeOpen2 = assetReqs.length;
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH2);
await new Promise((r) => setTimeout(r, 3000));
const afterOpen2 = assetReqs.slice(beforeOpen2);
const latex2 = afterOpen2.filter(isLatexChunk);
if (latex2.length === 0) {
  ok('second .tex open hits packCache',
    '0 latex chunks requested ' + '(' + afterOpen2.length + ' other /assets/*.js)');
} else {
  failL('second .tex open hits packCache',
    'expected 0 latex chunks on cache-hit, got : ' + latex2.join(', '));
}

// Sanity guard for the cross-feature suites : language detection
// + syntax highlighting on .tex still works after the brief lazy-
// load window. We probe for a .cm-content + at least one CodeMirror
// span the stex StreamLanguage produces.
const synOk = await page.evaluate(() => {
  const content = document.querySelector('.cm-content');
  if (!content) return { hasContent: false };
  // The stex StreamLanguage tags \documentclass / \begin /
  // \end with a "keyword" tag → cm-* class. Any cm-content
  // child span carrying a class beyond plain "cm-line" is enough
  // evidence the parser ran.
  const spans = content.querySelectorAll('.cm-line span[class]');
  return { hasContent: true, spans: spans.length };
});
if (synOk.hasContent && synOk.spans > 0) {
  ok('syntax highlight after lazy load',
    synOk.spans + ' highlighted spans inside .cm-content');
} else {
  failL('syntax highlight after lazy load',
    JSON.stringify(synOk));
}

await browser.close();
for (const p of [PATH1, PATH2]) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(p),
    { method: 'DELETE' }).catch(() => {});
}

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
