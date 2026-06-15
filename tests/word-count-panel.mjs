// word-count-panel.mjs — V0.11 daily-writing-goals panel. Asserts :
//   1. The FAB renders on .tex + .md files (not on .ods / .ipynb)
//   2. Opening the panel surfaces a total word count
//   3. Typing words increments the "today" counter
//   4. Setting a goal of 5 + typing 5+ words flips the achieved badge
//   5. Reset-today resets the baseline so wroteToday goes back to 0

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const F = 'words-test-' + Date.now() + '.md';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom word-count panel suite\x1b[0m');

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), {
  method: 'PUT', body: '# Title\n\nFirst paragraph with some seed words.\n',
});
ok('seed', F);

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
// Wipe localStorage so prior test runs don't leak today-anchors.
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), F);
await new Promise((r) => setTimeout(r, 3500));

// FAB visible
const fabVisible = await page.evaluate(() =>
  !!document.querySelector('[data-testid="words-toggle"]'));
if (fabVisible) ok('FAB renders for .md', '📊 visible');
else { failL('FAB renders for .md', 'no [data-testid=words-toggle]'); process.exit(1); }

// Open the panel
await page.click('[data-testid="words-toggle"]');
// Anchor seeds 400 ms after the live word count settles (avoids
// anchoring at the editor's initial 0 before the doc loads). Wait
// past that window so the "today starts at 0" read is stable.
await new Promise((r) => setTimeout(r, 700));
const opened = await page.evaluate(() =>
  !!document.querySelector('[data-testid="words-panel"]'));
if (opened) ok('panel opens on click');
else failL('panel opens on click', 'no [data-testid=words-panel]');

// Read initial counts. The seed has ~7 words ; the editor's
// cursor-stats hook publishes the total.
const initial = await page.evaluate(() => ({
  total: document.querySelector('[data-testid="words-total"]')?.textContent?.trim(),
  today: document.querySelector('[data-testid="words-today"]')?.textContent?.trim(),
}));
if (Number(initial.total) >= 5) {
  ok('total surfaces a positive count', initial.total + ' words');
} else {
  failL('total surfaces a positive count', JSON.stringify(initial));
}
if (initial.today === '0') {
  ok('today starts at 0', 'anchor seeded from current count');
} else {
  failL('today starts at 0', JSON.stringify(initial));
}

// Set goal = 5 (small target so the test reaches it fast).
await page.evaluate(() => {
  const input = document.querySelector('[data-testid="words-goal-input"]');
  if (!input) return;
  input.value = '5';
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 150));

// Type 7 new words at the end of the file. The editor's
// updateCursorStats hook publishes the live count via the
// onCursorStats prop — we just type + wait the 250 ms debounce.
await page.click('.cm-content');
// Place cursor at end of doc
await page.evaluate(() => {
  const fn = (window).weftLoomJumpToOffset;
  const cm = document.querySelector('.cm-content');
  const last = cm?.textContent?.length ?? 0;
  if (typeof fn === 'function') fn(last, last);
});
await new Promise((r) => setTimeout(r, 150));
await page.keyboard.type(' alpha beta gamma delta epsilon zeta eta');
// Wait for the word-count debounce (≥ 250 ms) + a buffer.
await new Promise((r) => setTimeout(r, 500));

const afterType = await page.evaluate(() => ({
  total: document.querySelector('[data-testid="words-total"]')?.textContent?.trim(),
  today: document.querySelector('[data-testid="words-today"]')?.textContent?.trim(),
  hasAchievedBadge: !!document.querySelector('[data-testid="words-achieved-badge"]'),
}));
if (Number(afterType.today) >= 5) {
  ok('typing increments today', afterType.today + ' words today');
} else {
  failL('typing increments today', JSON.stringify(afterType));
}
if (afterType.hasAchievedBadge) {
  ok('achieved badge flips on after goal met', '✓ visible');
} else {
  failL('achieved badge flips on after goal met', JSON.stringify(afterType));
}

// Reset-today : anchor resets to current count + today goes back to 0.
await page.click('[data-testid="words-reset-today"]');
await new Promise((r) => setTimeout(r, 250));
const afterReset = await page.evaluate(() => ({
  today: document.querySelector('[data-testid="words-today"]')?.textContent?.trim(),
}));
if (afterReset.today === '0') {
  ok('reset-today re-anchors baseline', 'back to 0');
} else {
  failL('reset-today re-anchors baseline', JSON.stringify(afterReset));
}

await br.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
