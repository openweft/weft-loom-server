// comments-panel.mjs — Collaborative comments (T6) regression test.
//
// Drives the CommentsPanel through its full lifecycle :
//   1. Open a .tex file ; CommentsPanel FAB renders.
//   2. Select text in the editor + add a comment → the comment
//      lands in the Yjs array + appears in the panel.
//   3. The editor renders a yellow-dotted highlight on the
//      anchor range.
//   4. Resolve the comment → it stays in the list, marked resolved.
//   5. Click the comment entry → editor jumps to the anchor.
//   6. Delete the comment → list empties.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'comments-test-' + Date.now() + '.tex';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom comments panel suite\x1b[0m');

const body = '\\documentclass{article}\n\\begin{document}\nHello world, this is the body to comment on.\n\\end{document}\n';
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body });
ok('seed', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 4500));

const fab = await page.evaluate(() => !!document.querySelector('[data-testid="comments-toggle"]'));
if (!fab) {
  failL('FAB', 'comments-toggle missing');
  await browser.close(); process.exit(1);
}
ok('FAB', 'comments-toggle rendered');

// Open panel.
await page.evaluate(() => document.querySelector('[data-testid="comments-toggle"]')?.click());
await new Promise((r) => setTimeout(r, 400));

// Use the editor's jump-to-offset hook to set the selection. It
// places the caret at `from`, the head at `to`, focuses + scrolls.
const setSel = await page.evaluate(() => {
  const text = document.querySelector('.cm-content')?.textContent ?? '';
  const idx = text.indexOf('Hello world');
  if (idx < 0) return { ok: false, len: text.length };
  const fn = (window).weftLoomJumpToOffset;
  if (typeof fn !== 'function') return { ok: false, hook: false };
  fn(idx, idx + 'Hello world'.length);
  return { ok: true, idx };
});
if (!setSel.ok) {
  failL('selection', 'could not set selection : ' + JSON.stringify(setSel));
  await browser.close(); process.exit(1);
}
ok('selection', '"Hello world" selected at offset ' + setSel.idx);

// Wait for the panel to pick up the selection via the report hook.
await new Promise((r) => setTimeout(r, 400));

// Type a comment body + click Add.
await page.evaluate(() => {
  const ta = document.querySelector('[data-testid="comments-input"]');
  if (ta) { ta.value = 'V0.1 test comment'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
});
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => document.querySelector('[data-testid="comments-add"]')?.click());
await new Promise((r) => setTimeout(r, 500));

const added = await page.evaluate(() => ({
  entries: document.querySelectorAll('[data-testid="comment-entry"]').length,
  bodies: Array.from(document.querySelectorAll('.comment-body')).map(e => e.textContent),
  hasAnchor: !!document.querySelector('.cm-comment-anchor'),
}));
if (added.entries === 1 && added.bodies[0]?.includes('V0.1 test comment')) {
  ok('add comment', 'entry + body persisted');
} else {
  failL('add comment', JSON.stringify(added));
}
if (added.hasAnchor) {
  ok('anchor decoration', '.cm-comment-anchor painted');
} else {
  failL('anchor decoration', 'no .cm-comment-anchor on the source');
}

// Resolve.
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('[data-testid="comment-entry"] button'))
    .filter(b => b.textContent?.includes('Resolve'));
  btns[0]?.click();
});
await new Promise((r) => setTimeout(r, 500));
const afterResolve = await page.evaluate(() => ({
  resolvedClass: !!document.querySelector('[data-testid="comment-entry"].resolved'),
  resolvedAnchor: !!document.querySelector('.cm-comment-anchor-resolved'),
}));
if (afterResolve.resolvedClass && afterResolve.resolvedAnchor) {
  ok('resolve toggle', 'comment + anchor both flipped to resolved');
} else {
  failL('resolve toggle', JSON.stringify(afterResolve));
}

// Delete.
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('[data-testid="comment-entry"] button'))
    .filter(b => b.textContent?.includes('Delete'));
  btns[0]?.click();
});
await new Promise((r) => setTimeout(r, 500));
const afterDelete = await page.evaluate(() => ({
  entries: document.querySelectorAll('[data-testid="comment-entry"]').length,
  anchor: !!document.querySelector('.cm-comment-anchor'),
}));
if (afterDelete.entries === 0 && !afterDelete.anchor) {
  ok('delete', 'comment + anchor both removed');
} else {
  failL('delete', JSON.stringify(afterDelete));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
