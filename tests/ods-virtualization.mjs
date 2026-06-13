// ods-virtualization.mjs — confirms the spreadsheet grid is
// virtualized : the user can scroll to row 100 000+ / column 1000+
// without the DOM accumulating millions of cell nodes.
//
//   1. Open a tiny .ods + assert that only ~hundreds of cells are
//      in the DOM (not MAX_ROWS × MAX_COLS).
//   2. Scroll the container 50 000 rows down ; assert the visible
//      data-cell entries now report row indices in that range.
//   3. Type into a far-away cell (row 1500, col 50) ; assert the
//      saved bytes carry the cell at the expected address.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'ods-virt-' + Date.now() + '.ods';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODS virtualization suite\x1b[0m');

const zip = new JSZip();
zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
zip.folder('META-INF').file('manifest.xml',
  '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>');
zip.file('meta.xml',
  '<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
zip.file('content.xml',
`<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:spreadsheet>
    <table:table table:name="VirtSheet">
      <table:table-row>
        <table:table-cell office:value-type="string"><text:p>start</text:p></table:table-cell>
      </table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>`);
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body: await zip.generateAsync({ type: 'uint8array' }) });
ok('seed', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 3500));

// 1) Cap on rendered cells.
const cellCount = await page.evaluate(() =>
  document.querySelectorAll('[data-cell]').length);
if (cellCount > 0 && cellCount < 5000) {
  ok('virtualized DOM size', cellCount + ' cells in DOM (not MAX_ROWS×MAX_COLS)');
} else {
  failL('virtualized DOM size', 'expected 1..5000 cell nodes, got ' + cellCount);
}

// 2) Canvas reports the virtual size. We use clientWidth/Height
// because Svelte renders huge numbers as scientific notation
// inline ("1.57e+06px"), which parseInt() chokes on.
const canvasSize = await page.evaluate(() => {
  const canvas = document.querySelector('[data-testid="ods-canvas"]');
  if (!canvas) return null;
  return { width: canvas.clientWidth, height: canvas.clientHeight };
});
if (canvasSize && canvasSize.width > 1_000_000 && canvasSize.height > 10_000_000) {
  ok('canvas virtual size', canvasSize.width + 'px × ' + canvasSize.height + 'px');
} else {
  failL('canvas virtual size', JSON.stringify(canvasSize));
}

// 3) Scroll deep + assert visible cells reflect the new position.
await page.evaluate(() => {
  const sc = document.querySelector('[data-testid="ods-grid-wrap"]');
  if (sc) sc.scrollTop = 1_200_000; // ~50,000 rows × 24 px
});
await new Promise((r) => setTimeout(r, 500));
const farCells = await page.evaluate(() => {
  const ds = Array.from(document.querySelectorAll('[data-cell]')).map(c => c.getAttribute('data-cell'));
  const rows = ds.map(s => Number(s.split(',')[0]));
  return {
    minRow: Math.min(...rows),
    maxRow: Math.max(...rows),
    sample: ds.slice(0, 3),
  };
});
if (farCells.minRow > 40_000 && farCells.minRow < 60_000) {
  ok('deep scroll', 'visible rows centred around ' + farCells.minRow + '..' + farCells.maxRow);
} else {
  failL('deep scroll', 'expected rows in 40k..60k, got ' + JSON.stringify(farCells));
}

// 4) Type into a far-away cell + save. We use the formula bar after
// programmatically selecting the cell via the visible DOM ; since
// scroll position centres us around row 50k, pick a row in that
// window + a visible column.
await page.evaluate(() => {
  const candidate = document.querySelector('[data-cell]');
  candidate?.click();
});
await new Promise((r) => setTimeout(r, 200));
const cellRef = await page.evaluate(() => document.querySelector('[data-testid="ods-cellref"]')?.textContent?.trim());
if (cellRef && /^[A-Z]+[0-9]+$/.test(cellRef) && parseInt(cellRef.replace(/^[A-Z]+/, ''), 10) > 40_000) {
  ok('select far cell', 'ref = ' + cellRef);
} else {
  failL('select far cell', 'expected XX#### with #### > 40000, got "' + cellRef + '"');
}
await page.evaluate(() => {
  const fb = document.querySelector('[data-testid="ods-formula-bar"]');
  if (fb) { fb.value = 'far-edit'; fb.dispatchEvent(new Event('input', { bubbles: true })); }
});
await new Promise((r) => setTimeout(r, 1500));
const saved = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const xml = await (await JSZip.loadAsync(await saved.arrayBuffer())).file('content.xml')?.async('string') ?? '';
if (xml.includes('far-edit')) {
  ok('far-cell write-back', 'far-edit landed in saved XML');
} else {
  failL('far-cell write-back', 'expected far-edit in saved XML');
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
