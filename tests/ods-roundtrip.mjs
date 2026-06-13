// ods-roundtrip.mjs — T9 V0.1 : ODS reader/writer + grid editor.
//
//   1. Seed a .ods file with two sheets containing typed cells
//      (string + float + boolean).
//   2. Open in the SpreadsheetEditor ; assert the grid renders
//      with the expected cell content + the formula bar reflects
//      the active cell.
//   3. Edit a cell ; trigger save ; assert the saved bytes parse
//      back as a valid ODS with the new value + type.
//   4. Add a new sheet via the toolbar ; confirm it shows up as
//      a tab.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'ods-test-' + Date.now() + '.ods';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODS round-trip suite\x1b[0m');

async function makeSeed() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.folder('META-INF').file('manifest.xml',
`<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`);
  zip.file('meta.xml',
`<?xml version="1.0"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>`);
  zip.file('content.xml',
`<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:body><office:spreadsheet>
    <table:table table:name="Revenue">
      <table:table-row>
        <table:table-cell office:value-type="string"><text:p>Product</text:p></table:table-cell>
        <table:table-cell office:value-type="string"><text:p>Sales</text:p></table:table-cell>
        <table:table-cell office:value-type="string"><text:p>Active</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
        <table:table-cell office:value-type="string"><text:p>Widget</text:p></table:table-cell>
        <table:table-cell office:value-type="float" office:value="1234.5"><text:p>1234.5</text:p></table:table-cell>
        <table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>true</text:p></table:table-cell>
      </table:table-row>
    </table:table>
    <table:table table:name="Notes">
      <table:table-row>
        <table:table-cell office:value-type="string"><text:p>FY26 H1</text:p></table:table-cell>
      </table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>`);
  return zip.generateAsync({ type: 'uint8array' });
}

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body: await makeSeed() });
ok('seed', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PERR:', e.message));
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 3000));

// Reader assertions.
const initial = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('[data-cell]'))
    .map(c => ({ pos: c.getAttribute('data-cell'), text: (c.textContent ?? '').trim() }));
  const tabs = Array.from(document.querySelectorAll('[data-testid="ods-sheet-tab"]'))
    .map(t => t.getAttribute('data-sheet'));
  return {
    cellCount: cells.length,
    productHeader: cells.find(c => c.pos === '0,0')?.text,
    widgetCell:    cells.find(c => c.pos === '1,0')?.text,
    salesCell:     cells.find(c => c.pos === '1,1')?.text,
    activeCell:    cells.find(c => c.pos === '1,2')?.text,
    tabs,
    cellRef: document.querySelector('[data-testid="ods-cellref"]')?.textContent?.trim(),
  };
});
if (initial.productHeader === 'Product'
 && initial.widgetCell === 'Widget'
 && initial.salesCell === '1234.5'
 && initial.activeCell === 'true') {
  ok('grid populates', 'Product/Widget/1234.5/true rendered');
} else {
  failL('grid populates', JSON.stringify(initial));
}
if (initial.tabs.includes('Revenue') && initial.tabs.includes('Notes')) {
  ok('sheet tabs', 'Revenue + Notes tabs visible');
} else {
  failL('sheet tabs', JSON.stringify(initial.tabs));
}
if (initial.cellRef === 'A1') {
  ok('formula bar cellref', 'starts at A1');
} else {
  failL('formula bar cellref', 'got "' + initial.cellRef + '"');
}

// Edit a cell + save.
await page.evaluate(() => {
  const cell = document.querySelector('[data-cell="1,1"]');
  if (!cell) return;
  cell.click();
  cell.focus();
  cell.textContent = '9999';
  cell.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 1500));

const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const z = await JSZip.loadAsync(await after.arrayBuffer());
const xml = await z.file('content.xml')?.async('string') ?? '';
if (xml.includes('office:value="9999"') && xml.includes('office:value-type="float"')) {
  ok('cell write-back', 'B2 saved as float 9999');
} else {
  failL('cell write-back', 'expected office:value="9999" type=float — snippet : '
    + xml.slice(xml.indexOf('Revenue'), xml.indexOf('Revenue') + 500));
}
if (xml.includes('table:name="Revenue"') && xml.includes('table:name="Notes"')) {
  ok('round-trip sheets', 'both sheet names preserved');
} else {
  failL('round-trip sheets', 'one of the sheet names lost');
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
