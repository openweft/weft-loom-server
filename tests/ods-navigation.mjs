// ods-navigation.mjs — keyboard navigation in the spreadsheet.
//
// Excel-style arrows : right / left / up / down / Tab / Enter /
// Home / End / PageDown / PageUp all navigate the selection,
// scroll the target into view when needed, and update the
// cell-ref label in the formula bar. Caret position inside a
// cell never gates navigation (that bug was the user's "arrows
// don't work" report).
//
// Each assertion synthesises a keydown on the active cell + reads
// the cell-ref label to confirm the new selection.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'ods-nav-' + Date.now() + '.ods';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODS navigation suite\x1b[0m');

const z = new JSZip();
z.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
z.folder('META-INF').file('manifest.xml',
  '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>');
z.file('meta.xml',
  '<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
// Seed with a 3×3 grid of typed values so right/left can't claim
// "the cell is empty, defer to default browser behaviour."
const rowXML = (vals) => '<table:table-row>' + vals.map(v => '<table:table-cell office:value-type="string"><text:p>' + v + '</text:p></table:table-cell>').join('') + '</table:table-row>';
z.file('content.xml',
`<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:spreadsheet>
    <table:table table:name="Nav">
      ${rowXML(['A1', 'B1', 'C1'])}
      ${rowXML(['A2', 'B2', 'C2'])}
      ${rowXML(['A3', 'B3', 'C3'])}
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>`);
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body: await z.generateAsync({ type: 'uint8array' }) });
ok('seed', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 3500));

// Helper : current cell ref in the formula bar.
async function ref() {
  return page.evaluate(() => document.querySelector('[data-testid="ods-cellref"]')?.textContent?.trim());
}
async function active() {
  return page.evaluate(() => {
    const a = document.activeElement;
    return a ? a.getAttribute?.('data-cell') ?? a.tagName : 'none';
  });
}
// Helper : press a key using puppeteer's real keyboard so the
// event behaves like a user keystroke. We extra-wait after each
// press so focusCell's nested setTimeouts can land before the
// next key fires ; otherwise focus is sometimes still on the
// PREVIOUS cell when the new key arrives.
async function press(key, opts = {}) {
  if (opts.shiftKey) {
    await page.keyboard.down('Shift');
    await page.keyboard.press(key);
    await page.keyboard.up('Shift');
  } else {
    await page.keyboard.press(key);
  }
  await new Promise((r) => setTimeout(r, 400));
}

// Click into A1 via puppeteer's real mouse so contenteditable
// actually grabs focus (programmatic .click() fires the event
// but doesn't move browser focus to the editable element).
await page.click('[data-cell="0,0"]');
await new Promise((r) => setTimeout(r, 250));
if ((await ref()) === 'A1') ok('start at A1', 'ref = A1');
else failL('start at A1', 'got ' + await ref());

await press('ArrowRight');
if ((await ref()) === 'B1') ok('ArrowRight → B1', 'B1');
else failL('ArrowRight → B1', 'got ' + await ref());

await press('ArrowRight');
if ((await ref()) === 'C1') ok('ArrowRight → C1', 'C1');
else failL('ArrowRight → C1', 'got ' + await ref());

await press('ArrowLeft');
if ((await ref()) === 'B1') ok('ArrowLeft → B1', 'B1');
else failL('ArrowLeft → B1', 'got ' + await ref());

await press('ArrowDown');
if ((await ref()) === 'B2') ok('ArrowDown → B2', 'B2 [active=' + await active() + ']');
else failL('ArrowDown → B2', 'got ' + await ref());

await press('ArrowLeft');
if ((await ref()) === 'A2') ok('ArrowLeft → A2', 'A2');
else failL('ArrowLeft → A2', 'got ' + await ref() + ' [active=' + await active() + ']');

await press('ArrowUp');
if ((await ref()) === 'A1') ok('ArrowUp → A1', 'A1');
else failL('ArrowUp → A1', 'got ' + await ref());

// Tab + shift-Tab.
await press('Tab');
if ((await ref()) === 'B1') ok('Tab → B1', 'B1');
else failL('Tab → B1', 'got ' + await ref());
await press('Tab', { shiftKey: true });
if ((await ref()) === 'A1') ok('Shift+Tab → A1', 'A1');
else failL('Shift+Tab → A1', 'got ' + await ref());

// Enter (commit + down).
await press('Enter');
if ((await ref()) === 'A2') ok('Enter → A2', 'A2');
else failL('Enter → A2', 'got ' + await ref());

// The bug the user reported : arrows kept working in a populated
// cell. Scroll back to A1 first so the cell exists in the
// virtualized DOM, then click it.
await page.evaluate(() => {
  const sc = document.querySelector('[data-testid="ods-grid-wrap"]');
  if (sc) { sc.scrollTop = 0; sc.scrollLeft = 0; }
});
await new Promise((r) => setTimeout(r, 400));
await page.click('[data-cell="0,0"]');
await new Promise((r) => setTimeout(r, 250));
// Type some content into A1 via execCommand so the contenteditable
// has a non-zero caret position when we press ArrowRight.
await page.evaluate(() => {
  document.execCommand('insertText', false, 'X');
});
await new Promise((r) => setTimeout(r, 200));
await press('ArrowRight');
if ((await ref()) === 'B1') ok('ArrowRight after typing', 'B1 (caret position no longer gates nav)');
else failL('ArrowRight after typing', 'got ' + await ref());

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
