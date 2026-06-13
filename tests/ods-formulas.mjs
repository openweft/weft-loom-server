// ods-formulas.mjs — T9 V0.2 : HyperFormula-evaluated cells.
//
//   1. Seed a .ods with A1=10, A2=20, A3=of:=A1+A2 ; expect the
//      cell to render as "30" and the formula bar to show "=A1+A2".
//   2. Edit B1 = "=2*3" via the formula bar ; assert the grid
//      shows 6 in B1.
//   3. Save ; assert the saved bytes carry table:formula="of:=2*3"
//      so round-trip survives.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'ods-formulas-' + Date.now() + '.ods';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODS formulas suite\x1b[0m');

async function makeSeed() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.folder('META-INF').file('manifest.xml',
`<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"/>`);
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
    <table:table table:name="Sheet1">
      <table:table-row>
        <table:table-cell office:value-type="float" office:value="10"><text:p>10</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
        <table:table-cell office:value-type="float" office:value="20"><text:p>20</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
        <table:table-cell table:formula="of:=A1+A2" office:value-type="float" office:value="30"><text:p>30</text:p></table:table-cell>
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
await new Promise((r) => setTimeout(r, 3500));

// 1) Formula cell renders the computed value.
const seeded = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('[data-cell]'))
    .map(c => ({ pos: c.getAttribute('data-cell'), text: (c.textContent ?? '').trim(), formula: c.getAttribute('data-formula') }));
  return {
    a1: cells.find(c => c.pos === '0,0')?.text,
    a2: cells.find(c => c.pos === '1,0')?.text,
    a3: cells.find(c => c.pos === '2,0')?.text,
    a3_formulaFlag: cells.find(c => c.pos === '2,0')?.formula,
  };
});
if (seeded.a1 === '10' && seeded.a2 === '20' && seeded.a3 === '30' && seeded.a3_formulaFlag === '1') {
  ok('formula evaluates', 'A3 = A1+A2 → 30, marked as formula');
} else {
  failL('formula evaluates', JSON.stringify(seeded));
}

// 2) Type a new formula via the formula bar. The seed has only
// column A so we click "+ Col" to add B first, then target B1.
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'))
    .filter(b => b.textContent?.trim() === '+ Col');
  btns[0]?.click();
});
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => {
  const cell = document.querySelector('[data-cell="0,1"]');
  cell?.click();
});
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => {
  const fb = document.querySelector('[data-testid="ods-formula-bar"]');
  if (fb) {
    fb.value = '=2*3';
    fb.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await new Promise((r) => setTimeout(r, 800));
const b1 = await page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('[data-cell]'));
  return cells.find(c => c.getAttribute('data-cell') === '0,1')?.textContent?.trim();
});
if (b1 === '6') {
  ok('formula bar editing', '=2*3 → 6 rendered in B1');
} else {
  failL('formula bar editing', 'expected 6, got "' + b1 + '"');
}

// 3) Save + round-trip.
await new Promise((r) => setTimeout(r, 1500));
const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const z = await JSZip.loadAsync(await after.arrayBuffer());
const xml = await z.file('content.xml')?.async('string') ?? '';
if (xml.includes('table:formula="of:=2*3"') || xml.includes('table:formula="of:=2 * 3"')) {
  ok('formula round-trip', 'table:formula preserved in saved XML');
} else {
  failL('formula round-trip', 'expected table:formula="of:=2*3" — snippet : '
    + xml.slice(xml.indexOf('Sheet1'), xml.indexOf('Sheet1') + 600));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
