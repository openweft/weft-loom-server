// shortcut-help.mjs — V0.11 keyboard shortcut cheat sheet modal.
// Asserts :
//   1. Cmd+/ from anywhere outside the editor opens the modal
//   2. The modal lists shortcuts in categorized sections (File,
//      View, Edit, LaTeX, …) with each shortcut split into <kbd>
//      chips
//   3. The search box narrows the list — typing "save" leaves
//      only the matching entries
//   4. Escape closes the modal

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom shortcut-help suite\x1b[0m');

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

// Modal should NOT be open at boot.
let open = await page.evaluate(() => !!document.querySelector('[data-testid="shortcut-help"]'));
if (!open) ok('closed by default'); else failL('closed by default', 'modal visible at boot');

// Trigger Cmd+/ from the body (not from the editor — the global
// shortcut hook should fire before any element-level keymap).
await page.focus('body');
const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
await page.keyboard.down(modKey);
await page.keyboard.press('/');
await page.keyboard.up(modKey);
await new Promise((r) => setTimeout(r, 250));

open = await page.evaluate(() => !!document.querySelector('[data-testid="shortcut-help"]'));
if (open) ok('Cmd+/ opens the modal'); else failL('Cmd+/ opens the modal', 'no [data-testid=shortcut-help]');

// At least 6 sections should render with non-empty entries.
const sections = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid="shortcut-help"] section'));
  return rows.map((s) => ({
    title: s.querySelector('h3')?.textContent?.trim(),
    rows: s.querySelectorAll('li').length,
  }));
});
if (sections.length >= 6 && sections.every((s) => s.rows > 0)) {
  ok('sections render', sections.length + ' sections : ' + sections.map((s) => s.title).join(', '));
} else {
  failL('sections render', JSON.stringify(sections));
}

// kbd chips should be present in each row.
const chipCount = await page.evaluate(() =>
  document.querySelectorAll('[data-testid="shortcut-help"] .kbd').length);
if (chipCount >= 12) {
  ok('kbd chips render', chipCount + ' <kbd> elements');
} else {
  failL('kbd chips render', chipCount + ' chips');
}

// Type "save" in the search box.
await page.click('[data-testid="shortcut-help-filter"]');
await page.keyboard.type('save');
await new Promise((r) => setTimeout(r, 200));
const filtered = await page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('[data-testid="shortcut-help"] li'))
    .map((l) => l.textContent?.toLowerCase().trim() ?? '');
  return labels;
});
const allMentionSave = filtered.length > 0 && filtered.every((l) => l.includes('save'));
if (allMentionSave) {
  ok('filter narrows the list', filtered.length + ' rows all mention "save"');
} else {
  failL('filter narrows the list', JSON.stringify(filtered));
}

// Clear filter so the next Escape test gets the full DOM back.
await page.evaluate(() => {
  const inp = document.querySelector('[data-testid="shortcut-help-filter"]');
  inp.value = '';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 150));

// Escape closes.
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 250));
const closed = await page.evaluate(() => !document.querySelector('[data-testid="shortcut-help"]'));
if (closed) ok('Escape closes the modal'); else failL('Escape closes the modal', 'still open');

await br.close();

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
