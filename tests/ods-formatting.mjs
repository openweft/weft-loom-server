// ods-formatting.mjs — header-click selection + Excel-style
// formatting toolbar.
//
//   1. Click a column header (B) selects every cell in column B.
//   2. Click a row header (3) selects every cell in row 3.
//   3. Click the corner selects the whole sheet.
//   4. Apply bold to a column selection → every cell in that
//      column inherits the bold style on screen.
//   5. Apply a background colour to a row selection → every cell
//      in that row gets the background.
//   6. Save → saved ODF carries <style:style style:family="table-cell">
//      definitions referenced by table:style-name attributes.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'ods-fmt-' + Date.now() + '.ods';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODS formatting suite\x1b[0m');

const z = new JSZip();
z.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
z.folder('META-INF').file('manifest.xml',
  '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>');
z.file('meta.xml',
  '<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
const row = (vs) => '<table:table-row>' + vs.map(v => '<table:table-cell office:value-type="string"><text:p>' + v + '</text:p></table:table-cell>').join('') + '</table:table-row>';
z.file('content.xml',
`<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:spreadsheet>
    <table:table table:name="Fmt">
      ${row(['A1','B1','C1'])}
      ${row(['A2','B2','C2'])}
      ${row(['A3','B3','C3'])}
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

// 1) Click column B header.
await page.evaluate(() => document.querySelector('[data-colheader="1"]')?.click());
await new Promise((r) => setTimeout(r, 300));
const colState = await page.evaluate(() => {
  const inRange = Array.from(document.querySelectorAll('.ods-cell-range'))
    .map(c => c.getAttribute('data-cell'));
  const hl = Array.from(document.querySelectorAll('.ods-colheader-sel'))
    .map(c => c.textContent);
  return { inRange, highlightedCols: hl };
});
if (colState.highlightedCols.includes('B')) {
  ok('col header click highlights col', colState.highlightedCols.join(','));
} else {
  failL('col header click highlights col', JSON.stringify(colState));
}
// Column 1 cells in row 0, 2 (row 1 is the selected/anchor cell)
// should be in the range.
const colInRange = colState.inRange.filter(id => id?.endsWith(',1'));
if (colInRange.length >= 2) {
  ok('col header click selects col cells', colInRange.length + ' cells highlighted');
} else {
  failL('col header click selects col cells', JSON.stringify(colInRange));
}

// 2) Click row 3 header (data-rowheader="2").
await page.evaluate(() => document.querySelector('[data-rowheader="2"]')?.click());
await new Promise((r) => setTimeout(r, 300));
const rowState = await page.evaluate(() => {
  const inRange = Array.from(document.querySelectorAll('.ods-cell-range'))
    .map(c => c.getAttribute('data-cell'));
  return { row2Range: inRange.filter(id => id?.startsWith('2,')) };
});
if (rowState.row2Range.length >= 2) {
  ok('row header click selects row cells', rowState.row2Range.length + ' cells highlighted');
} else {
  failL('row header click selects row cells', JSON.stringify(rowState));
}

// 3) Click corner = select all.
await page.evaluate(() => document.querySelector('.ods-corner-sticky')?.click());
await new Promise((r) => setTimeout(r, 300));
const allHl = await page.evaluate(() =>
  document.querySelectorAll('.ods-cell-range').length);
if (allHl >= 8) {  // 3×3 minus the anchor = 8
  ok('corner click selects all', allHl + ' cells highlighted');
} else {
  failL('corner click selects all', 'expected ≥ 8, got ' + allHl);
}

// 4) Select column B, apply bold.
await page.evaluate(() => document.querySelector('[data-colheader="1"]')?.click());
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => document.querySelector('[data-testid="ods-bold"]')?.click());
await new Promise((r) => setTimeout(r, 300));
const boldCells = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('[data-cell]'))
    .filter(c => c.getAttribute('data-cell')?.endsWith(',1'))
    .map(c => ({
      id: c.getAttribute('data-cell'),
      bold: getComputedStyle(c).fontWeight === '700' || getComputedStyle(c).fontWeight === 'bold',
    }));
});
const allBold = boldCells.filter(c => /^[0-2],1$/.test(c.id)).every(c => c.bold);
if (allBold) {
  ok('bold applied to col B', boldCells.filter(c => c.bold).length + ' cells bolded');
} else {
  failL('bold applied to col B', JSON.stringify(boldCells.slice(0, 6)));
}

// 5) Select row 2, set background to red.
await page.evaluate(() => document.querySelector('[data-rowheader="1"]')?.click());
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => {
  const inp = document.querySelector('[data-testid="ods-bg-color"]');
  if (inp) { inp.value = '#ff0000'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
});
await new Promise((r) => setTimeout(r, 400));
const bgCells = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('[data-cell]'))
    .filter(c => c.getAttribute('data-cell')?.startsWith('1,'))
    .map(c => ({
      id: c.getAttribute('data-cell'),
      bg: getComputedStyle(c).backgroundColor,
    }));
});
const allRed = bgCells.filter(c => /^1,[0-2]$/.test(c.id))
  .every(c => c.bg === 'rgb(255, 0, 0)');
if (allRed) {
  ok('background applied to row 2', bgCells.length + ' cells red');
} else {
  failL('background applied to row 2', JSON.stringify(bgCells.slice(0, 6)));
}

// 6) Save + verify ODF carries the style definitions.
await new Promise((r) => setTimeout(r, 1500));
const saved = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const xml = await (await JSZip.loadAsync(await saved.arrayBuffer())).file('content.xml')?.async('string') ?? '';
if (xml.includes('style:family="table-cell"')
 && xml.includes('fo:font-weight="bold"')
 && xml.includes('fo:background-color="#ff0000"')
 && /table:style-name="ce\d+"/.test(xml)) {
  ok('formatting round-trip', 'styles + cell refs in saved XML');
} else {
  failL('formatting round-trip',
    'snippet : ' + xml.slice(xml.indexOf('<office:body>'), xml.indexOf('<office:body>') + 800));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
