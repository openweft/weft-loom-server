// ods-layout.mjs — pixel-level guard for the virtualized grid
// layout. Catches the two bugs the user just reported :
//
//   1. The grid was rendering in flow-layout (each cell took
//      ROW_H of vertical space) because a later
//      `.ods-cell { position: relative }` rule overrode the
//      `position: absolute` from the main rule. Result : cell
//      with text "B1" landed at the B2 visual position.
//   2. Headers were semi-transparent so the cell content showed
//      through when scrolling.
//
// We assert :
//   - All cells in row 0 share the SAME top pixel value.
//   - All cells in col 0 share the SAME left pixel value.
//   - Row 1 cells sit exactly ROW_H pixels below row 0.
//   - Col 1 cells sit exactly COL_W pixels right of col 0.
//   - Column header background is opaque (alpha = 1).
//   - Row header background is opaque.
//   - Headers have a higher z-index than the data cells so they
//     don't get visually covered during scroll.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'ods-layout-' + Date.now() + '.ods';
const ROW_H = 24;
const COL_W = 96;

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODS layout suite\x1b[0m');

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
    <table:table table:name="L">
      ${row(['A1', 'B1', 'C1'])}
      ${row(['A2', 'B2', 'C2'])}
      ${row(['A3', 'B3', 'C3'])}
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

// 1) Cell alignment.
const positions = await page.evaluate(() => {
  const want = ['0,0', '0,1', '0,2', '1,0', '1,1', '1,2', '2,0', '2,1'];
  return want.map(id => {
    const el = document.querySelector('[data-cell="' + id + '"]');
    if (!el) return { id, missing: true };
    const r = el.getBoundingClientRect();
    return { id, text: (el.textContent ?? '').trim(), top: Math.round(r.top), left: Math.round(r.left) };
  });
});
const byId = Object.fromEntries(positions.map(p => [p.id, p]));
const row0Tops = [byId['0,0'].top, byId['0,1'].top, byId['0,2'].top];
const row1Tops = [byId['1,0'].top, byId['1,1'].top, byId['1,2'].top];
const col0Lefts = [byId['0,0'].left, byId['1,0'].left, byId['2,0'].left];
const col1Lefts = [byId['0,1'].left, byId['1,1'].left, byId['2,1'].left];

if (new Set(row0Tops).size === 1) ok('row 0 cells aligned vertically', 'all at top=' + row0Tops[0]);
else failL('row 0 cells aligned vertically', JSON.stringify(row0Tops));

if (new Set(col0Lefts).size === 1) ok('col 0 cells aligned horizontally', 'all at left=' + col0Lefts[0]);
else failL('col 0 cells aligned horizontally', JSON.stringify(col0Lefts));

if (new Set(row1Tops).size === 1) ok('row 1 cells aligned vertically', 'all at top=' + row1Tops[0]);
else failL('row 1 cells aligned vertically', JSON.stringify(row1Tops));

if (row1Tops[0] - row0Tops[0] === ROW_H) {
  ok('row spacing', 'row 1 is ' + ROW_H + 'px below row 0');
} else {
  failL('row spacing', 'expected ' + ROW_H + 'px gap, got ' + (row1Tops[0] - row0Tops[0]));
}

if (col1Lefts[0] - col0Lefts[0] === COL_W) {
  ok('col spacing', 'col 1 is ' + COL_W + 'px right of col 0');
} else {
  failL('col spacing', 'expected ' + COL_W + 'px gap, got ' + (col1Lefts[0] - col0Lefts[0]));
}

// 2) B1 cell aligns with its rowheader "1" + colheader "B".
const ref = await page.evaluate(() => {
  const b1 = document.querySelector('[data-cell="0,1"]');
  if (!b1) return null;
  const cb = b1.getBoundingClientRect();
  const colB = Array.from(document.querySelectorAll('.ods-colheader')).find(c => c.textContent === 'B');
  const row1 = Array.from(document.querySelectorAll('.ods-rowheader')).find(c => c.textContent === '1');
  return {
    cellLeft: Math.round(cb.left), cellTop: Math.round(cb.top),
    colBLeft: colB ? Math.round(colB.getBoundingClientRect().left) : null,
    row1Top:  row1 ? Math.round(row1.getBoundingClientRect().top) : null,
  };
});
if (ref && ref.cellLeft === ref.colBLeft) {
  ok('B1 cell aligns with col B header', 'left=' + ref.cellLeft);
} else {
  failL('B1 cell aligns with col B header', JSON.stringify(ref));
}
if (ref && ref.cellTop === ref.row1Top) {
  ok('B1 cell aligns with row 1 header', 'top=' + ref.cellTop);
} else {
  failL('B1 cell aligns with row 1 header', JSON.stringify(ref));
}

// 3) Headers are OPAQUE (no alpha bleed-through).
const headerOpacity = await page.evaluate(() => {
  const colhRow = document.querySelector('.ods-colheader-row');
  const rowhCol = document.querySelector('.ods-rowheader-col');
  const cell = document.querySelector('.ods-colheader');
  if (!colhRow || !rowhCol || !cell) return null;
  const colBg = getComputedStyle(colhRow).backgroundColor;
  const rowBg = getComputedStyle(rowhCol).backgroundColor;
  const cellBg = getComputedStyle(cell).backgroundColor;
  // Parse rgb(a) string ; alpha < 1 = transparent.
  const alphaOf = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return 1;
    const parts = m[1].split(',').map(p => p.trim());
    return parts.length === 4 ? Number(parts[3]) : 1;
  };
  return {
    colRowAlpha: alphaOf(colBg),
    rowColAlpha: alphaOf(rowBg),
    cellAlpha:   alphaOf(cellBg),
    colBg, rowBg, cellBg,
  };
});
if (headerOpacity
 && headerOpacity.colRowAlpha === 1
 && headerOpacity.rowColAlpha === 1
 && headerOpacity.cellAlpha === 1) {
  ok('headers are opaque', 'all alpha = 1');
} else {
  failL('headers are opaque', JSON.stringify(headerOpacity));
}

// 4) Headers stack above cells (z-index check).
const zIndex = await page.evaluate(() => {
  const colhRow = document.querySelector('.ods-colheader-row');
  const rowhCol = document.querySelector('.ods-rowheader-col');
  const corner  = document.querySelector('.ods-corner-sticky');
  const cell    = document.querySelector('[data-cell]');
  return {
    colRow: colhRow ? Number(getComputedStyle(colhRow).zIndex) : NaN,
    rowCol: rowhCol ? Number(getComputedStyle(rowhCol).zIndex) : NaN,
    corner: corner ? Number(getComputedStyle(corner).zIndex) : NaN,
    cell: cell ? getComputedStyle(cell).zIndex : 'n/a',
  };
});
if (zIndex.colRow >= 4 && zIndex.rowCol >= 4 && zIndex.corner > zIndex.colRow) {
  ok('header z-index above cells',
    'colRow=' + zIndex.colRow + ' rowCol=' + zIndex.rowCol + ' corner=' + zIndex.corner);
} else {
  failL('header z-index above cells', JSON.stringify(zIndex));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
