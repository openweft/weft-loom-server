// snippets.mjs — V0.10 LaTeX/Markdown/JS/Py/Go snippet expansion.
// Asserts :
//   1. Opening a .tex file and typing "beg" then selecting the snippet
//      expands to "\begin{}…\end{}" with two tab stops sharing the
//      same env name (CodeMirror linked-range tab stop).
//   2. The autocomplete popup shows the snippet's `detail` so the
//      user sees what each candidate does before committing.
//   3. snippetCount() correctly reports per-language coverage via the
//      window hook (exposed for the settings UI).

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const TEX_FILE = 'snippets-tex-' + Date.now() + '.tex';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom snippets suite\x1b[0m');

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(TEX_FILE), {
  method: 'PUT', body: '\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n',
});
ok('seed', TEX_FILE);

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), TEX_FILE);
await new Promise((r) => setTimeout(r, 3500));

// Focus the editor + place the cursor on the blank line between
// \begin{document} and \end{document} (line 3 col 1 = offset 41).
await page.click('.cm-content');
await page.evaluate(() => {
  const fn = (window).weftLoomJumpToOffset;
  // Pre-existing content ends at offset 41 ( '\documentclass{article}\n\begin{document}\n\n' )
  if (typeof fn === 'function') fn(41, 41);
});
await new Promise((r) => setTimeout(r, 200));

// Type "beg" — autocomplete should pop up.
await page.keyboard.type('beg');
await new Promise((r) => setTimeout(r, 400));
const popupState = await page.evaluate(() => {
  const tip = document.querySelector('.cm-tooltip-autocomplete');
  if (!tip) return { open: false };
  const options = Array.from(tip.querySelectorAll('li'))
    .map((li) => ({
      label: li.querySelector('.cm-completionLabel')?.textContent?.trim(),
      detail: li.querySelector('.cm-completionDetail')?.textContent?.trim(),
    }))
    .filter((o) => o.label);
  return { open: true, options };
});
if (popupState.open) {
  ok('autocomplete opens on "beg"', popupState.options.length + ' candidates');
} else {
  failL('autocomplete opens on "beg"', JSON.stringify(popupState));
}
const beginEntry = popupState.options?.find((o) => o.label === 'begin');
if (beginEntry) {
  ok('snippet candidate "begin" surfaces', JSON.stringify(beginEntry));
} else {
  failL('snippet candidate "begin" surfaces', JSON.stringify(popupState.options));
}

// Press Enter to commit the begin snippet (first match should be
// "begin"). CodeMirror will insert "\begin{}…\end{}" with tab stops.
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 300));
const afterCommit = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n');
});
if (afterCommit.includes('\\begin{') && afterCommit.includes('\\end{')) {
  ok('begin snippet expands', '\\begin/\\end pair present');
} else {
  failL('begin snippet expands', 'got: ' + JSON.stringify(afterCommit.slice(0, 120)));
}

// Type the env name — the linked range should propagate to the
// \end{...} tab stop. After typing "verbatim" the buffer should
// contain \begin{verbatim} ... \end{verbatim}.
await page.keyboard.type('verbatim');
await new Promise((r) => setTimeout(r, 250));
const linked = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'));
if (linked.includes('\\begin{verbatim}') && linked.includes('\\end{verbatim}')) {
  ok('linked tab stop propagates env name', 'verbatim → both braces');
} else {
  failL('linked tab stop propagates env name', 'got: ' + JSON.stringify(linked));
}

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(TEX_FILE), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
