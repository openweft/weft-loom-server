// multi-cursor.mjs — verify CodeMirror multi-cursor wiring :
//   1. EditorState.allowMultipleSelections is on
//   2. Cmd+D selects the next occurrence (VSCode-style)
//   3. The state's SelectionRange list grows to 2 entries
//   4. Typing replaces both occurrences simultaneously
//
// Overleaf doesn't expose multi-cursor — this is a "fait mieux" feature.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'mc-test-' + Date.now() + '.txt';
const SEED = 'foo bar foo baz foo qux\nfoo on next line too';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom multi-cursor suite\x1b[0m');

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), {
  method: 'PUT', body: SEED,
});
ok('seed', PATH);

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 3500));

// Focus the editor + place the cursor at offset 0 (start of file).
await page.click('.cm-content');
await page.evaluate(() => {
  const fn = (window).weftLoomJumpToOffset;
  if (typeof fn === 'function') fn(0, 0);
});
await new Promise((r) => setTimeout(r, 200));

// Cmd+D #1 : selects the word the cursor is on ("foo" at offset 0).
const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
await page.keyboard.down(modKey);
await page.keyboard.press('d');
await page.keyboard.up(modKey);
await new Promise((r) => setTimeout(r, 200));

const afterFirstD = await page.evaluate(() => {
  // CodeMirror surfaces the live state via the .cm-editor's CmView,
  // but we don't have a stable public API. Easier : count the
  // .cm-selectionBackground rectangles drawn by drawSelection().
  return {
    selRects: document.querySelectorAll('.cm-selectionBackground').length,
    cursors:  document.querySelectorAll('.cm-cursor, .cm-cursor-primary').length,
  };
});
if (afterFirstD.selRects >= 1) {
  ok('Cmd+D #1 selects current word', afterFirstD.selRects + ' rects');
} else {
  failL('Cmd+D #1 selects current word', JSON.stringify(afterFirstD));
}

// Cmd+D #2 : adds the next occurrence — now 2 selection rects.
await page.keyboard.down(modKey);
await page.keyboard.press('d');
await page.keyboard.up(modKey);
await new Promise((r) => setTimeout(r, 200));
const afterSecondD = await page.evaluate(() => ({
  selRects: document.querySelectorAll('.cm-selectionBackground').length,
}));
if (afterSecondD.selRects >= 2) {
  ok('Cmd+D #2 adds next occurrence', afterSecondD.selRects + ' rects');
} else {
  failL('Cmd+D #2 adds next occurrence', JSON.stringify(afterSecondD));
}

// Cmd+D #3 : 3 occurrences of "foo" on the first line — should hit 3.
await page.keyboard.down(modKey);
await page.keyboard.press('d');
await page.keyboard.up(modKey);
await new Promise((r) => setTimeout(r, 200));
const afterThirdD = await page.evaluate(() => ({
  selRects: document.querySelectorAll('.cm-selectionBackground').length,
}));
if (afterThirdD.selRects >= 3) {
  ok('Cmd+D #3 grows the multi-selection further', afterThirdD.selRects + ' rects');
} else {
  failL('Cmd+D #3 grows the multi-selection further', JSON.stringify(afterThirdD));
}

// Type 'X' — every selected occurrence should be replaced with 'X'.
await page.keyboard.type('X');
await new Promise((r) => setTimeout(r, 300));
const docText = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'));
// Original "foo bar foo baz foo qux" should now have at least 3 'X'
// occurrences replacing the foo's (Cmd+D added at most 4 — 3 on line 1
// + line 2's "foo on next line"). Test for ≥3 replacements + check
// that NO bare "foo" survives on the first line.
const xCount = (docText.match(/X/g) ?? []).length;
const firstLine = docText.split('\n')[0] ?? '';
if (xCount >= 3 && !firstLine.includes('foo')) {
  ok('typing replaces all selections simultaneously', xCount + ' X chars, no foo on line 1');
} else {
  failL('typing replaces all selections simultaneously', JSON.stringify({ xCount, firstLine }));
}

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
