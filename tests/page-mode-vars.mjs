// page-mode-vars.mjs — combined smoke for two T11/T10 touches :
//
//   1. WYSIWYG toolbar exposes a "Continu / Pages" layout toggle
//      with a paper-size dropdown ; switching to Pages renders
//      rulers + a page-paper canvas.
//   2. MetadataPanel surfaces an editable Variables section for
//      ODT files ; adding a new variable + a value pushes it
//      through window.weftLoomODTVars + the next save round-trips
//      it into <meta:user-defined> in meta.xml.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'page-vars-' + Date.now() + '.odt';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom page-mode + meta vars suite\x1b[0m');

async function makeSeed() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.folder('META-INF').file('manifest.xml',
`<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`);
  zip.file('meta.xml',
`<?xml version="1.0"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
  <office:meta><dc:title>Vars Seed</dc:title></office:meta>
</office:document-meta>`);
  zip.file('content.xml',
`<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text><text:p>Hello variables.</text:p></office:text></office:body>
</office:document-content>`);
  return zip.generateAsync({ type: 'uint8array' });
}

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body: await makeSeed() });
ok('seed', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 3500));

// 1) Layout toggle.
const toggles = await page.evaluate(() => ({
  cont: !!document.querySelector('[data-testid="layout-continuous"]'),
  pages: !!document.querySelector('[data-testid="layout-pages"]'),
  wrapBefore: !!document.querySelector('[data-testid="page-mode-wrap"]'),
}));
if (toggles.cont && toggles.pages && !toggles.wrapBefore) {
  ok('layout toggle', 'Continu + Pages buttons present, default Continu');
} else {
  failL('layout toggle', JSON.stringify(toggles));
}

await page.evaluate(() => document.querySelector('[data-testid="layout-pages"]')?.click());
await new Promise((r) => setTimeout(r, 400));
const afterPages = await page.evaluate(() => ({
  wrap: !!document.querySelector('[data-testid="page-mode-wrap"]'),
  paper: !!document.querySelector('.page-paper'),
  rulerH: !!document.querySelector('.ruler-h'),
  rulerV: !!document.querySelector('.ruler-v'),
  paperSelect: !!document.querySelector('[data-testid="layout-paper"]'),
}));
if (afterPages.wrap && afterPages.paper && afterPages.rulerH && afterPages.rulerV && afterPages.paperSelect) {
  ok('pages mode', 'wrap + paper + rulers + size dropdown rendered');
} else {
  failL('pages mode', JSON.stringify(afterPages));
}

// 2) Metadata panel : open the accordion if collapsed, then add a var.
await page.evaluate(() => {
  const headers = Array.from(document.querySelectorAll('aside button'))
    .filter(b => b.textContent && b.textContent.trim().startsWith('Metadata'));
  for (const h of headers) if (h.getAttribute('aria-expanded') === 'false') h.click();
});
await new Promise((r) => setTimeout(r, 800));

const initialVars = await page.evaluate(() =>
  document.querySelectorAll('[data-testid="meta-var-row"]').length);
if (initialVars === 0) {
  ok('initial vars empty', 'no user-defined vars in seed');
} else {
  failL('initial vars empty', 'expected 0 rows, got ' + initialVars);
}

await page.evaluate(() => {
  const name = document.querySelector('[data-testid="meta-var-new-name"]');
  const val  = document.querySelector('[data-testid="meta-var-new-value"]');
  if (name) { name.value = 'Project'; name.dispatchEvent(new Event('input', { bubbles: true })); }
  if (val)  { val.value  = 'Atlas';  val.dispatchEvent(new Event('input', { bubbles: true })); }
});
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => document.querySelector('[data-testid="meta-var-add"]')?.click());
// give save() PUT a chance to land + the 1.5s panel poll to re-read it.
await new Promise((r) => setTimeout(r, 3500));

const afterAdd = await page.evaluate(() => ({
  rows: document.querySelectorAll('[data-testid="meta-var-row"]').length,
  firstName: document.querySelector('[data-testid="meta-var-name"]')?.value,
  firstValue: document.querySelector('[data-testid="meta-var-value"]')?.value,
}));
if (afterAdd.rows === 1 && afterAdd.firstName === 'Project' && afterAdd.firstValue === 'Atlas') {
  ok('add variable', 'row Project=Atlas present');
} else {
  failL('add variable', JSON.stringify(afterAdd));
}

// Fetch the saved bytes ; assert <meta:user-defined> shows up.
const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const z = await JSZip.loadAsync(await after.arrayBuffer());
const metaXml = await z.file('meta.xml')?.async('string') ?? '';
if (metaXml.includes('meta:name="Project"') && metaXml.includes('>Atlas<')) {
  ok('round-trip to meta.xml', 'Project / Atlas survived save');
} else {
  failL('round-trip to meta.xml', 'meta.xml snippet : ' + metaXml.slice(0, 500));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
