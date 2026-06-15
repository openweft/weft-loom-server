// latex-render-after-reload.mjs — repro for the user-reported bug
// "j'ai des fichiers tex ou markdown qui ne s'affiche pas dans
// l'editeur. je vois les numero de lignes set la minimap" for
// files like untitled-jg18.tex.
//
// Steps :
//   1. PUT a LaTeX file on disk with article-template content
//   2. Open it in the SPA, type a character (forces ytext to
//      diverge from the seed + the relay caches the buffer)
//   3. Reload the page (Cmd+R equivalent)
//   4. Wait for the editor to remount + sync with the relay
//   5. Assert .cm-line elements collectively contain the file content
//      — NOT just empty .cm-line shells (the bug shape)
//   6. Assert no [editor-visibility] warning fired
//
// Why a separate test : latex-source-render.mjs covers open + tab
// switch + fresh-file paths but never does a full page reload, so
// the binding.attach() race against a pre-populated relay state
// went undetected.

import puppeteer from 'puppeteer';

const ROOT = process.env.WEFT_LOOM_TEST_ROOT || 'http://127.0.0.1:8081';
const PROJECT = 'demo';
const F = 'untitled-' + Math.random().toString(36).slice(2, 6) + '.tex';

const SRC = `\\documentclass[a4paper,11pt]{article}
\\begin{document}
\\section{Reload regression}
Body content the reader must see after a page refresh.
\\end{document}
`;

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom LaTeX render after page reload\x1b[0m');

// (1) Seed on disk via API.
const put = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'PUT', body: SRC,
});
if (!put.ok) {
  failL('seed fixture via PUT', 'HTTP ' + put.status);
  process.exit(1);
}
ok('seed fixture via PUT', F);

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });

const consoleEvents = [];
page.on('console', (m) => {
  consoleEvents.push({ type: m.type(), text: m.text() });
});
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// (2) Open the SPA + the file ; type to force ytext to diverge.
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 3500));

// Click into the editor + type a character.
await page.focus('.cm-content');
await page.keyboard.type(' X');
await new Promise((r) => setTimeout(r, 1000));

const beforeReload = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'));
if (beforeReload.includes('Reload regression')) {
  ok('content visible before reload', beforeReload.length + ' bytes rendered');
} else {
  failL('content visible before reload', 'got: ' + JSON.stringify(beforeReload.slice(0, 80)));
  await br.close();
  process.exit(1);
}

// (3) Reload — same URL, same SPA, fresh Y.Doc + EditorView.
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3500));

// Re-open the file. With staleClaimAfter=3s + observer-driven wait,
// the editor should populate in well under 2 seconds even when the
// reload happens inside the claim window.
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 2000));

// (4) Assert the editor has the content. THIS is where the user's
// bug fires : .cm-line elements exist but their textContent is
// empty because the ytext was relay-synced BEFORE binding.attach.
const afterReload = await page.evaluate(() => {
  const lines = Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent);
  return {
    text: lines.join('\n'),
    lineCount: lines.length,
    emptyLines: lines.filter((l) => l === '' || l === '​').length,
    hasInvisibleAttr: !!document.querySelector('.cm-editor[data-weft-loom-invisible]'),
  };
});

if (afterReload.text.includes('Reload regression')) {
  ok('content visible after reload', afterReload.lineCount + ' lines');
} else if (afterReload.lineCount > 1 && afterReload.text.replace(/\s/g, '') === '') {
  // The bug shape : multiple .cm-line elements but all empty.
  failL('content visible after reload',
    `/// USER-REPORTED BUG /// ${afterReload.lineCount} empty cm-line shells, doc visually empty (invisible attr=${afterReload.hasInvisibleAttr})`);
} else {
  failL('content visible after reload',
    `got: ${JSON.stringify(afterReload.text.slice(0, 80))} (lines=${afterReload.lineCount})`);
}

// (5) Assert the visibility instrumentation did NOT mark the
// editor as invisible. If it did, this test should fail loud
// with the diagnostic reason from the console.
const visibilityWarnings = consoleEvents.filter((e) =>
  e.text.includes('[editor-visibility]'));
if (visibilityWarnings.length === 0) {
  ok('no [editor-visibility] warning');
} else {
  failL('no [editor-visibility] warning',
    visibilityWarnings.slice(0, 3).map((w) => w.text).join(' | '));
}

if (pageErrors.length > 0) {
  failL('no page errors', pageErrors.slice(0, 3).join(' | '));
} else {
  ok('no page errors');
}

await br.close();
// Cleanup
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'DELETE',
}).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
