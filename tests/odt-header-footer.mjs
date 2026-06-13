// odt-header-footer.mjs — T10 V0.2 : ODT header + footer round-trip.
//
//   1. Seed ODT with styles.xml carrying <style:header> + <style:footer>.
//   2. Open file ; switch to Pages mode ; assert the header + footer
//      bands render with the seed content.
//   3. Edit the header band ; trigger a save ; assert the saved
//      styles.xml carries the new header text.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'odt-hf-' + Date.now() + '.odt';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODT header/footer suite\x1b[0m');

async function makeSeed() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.folder('META-INF').file('manifest.xml',
`<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`);
  zip.file('meta.xml',
`<?xml version="1.0"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>`);
  zip.file('content.xml',
`<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:body><office:text>
    <text:p>Body content goes here.</text:p>
  </office:text></office:body>
</office:document-content>`);
  zip.file('styles.xml',
`<?xml version="1.0"?>
<office:document-styles
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  office:version="1.2">
  <office:master-styles>
    <style:master-page style:name="Standard">
      <style:header><text:p>Seed header — confidential</text:p></style:header>
      <style:footer><text:p>Seed footer — page</text:p></style:footer>
    </style:master-page>
  </office:master-styles>
</office:document-styles>`);
  return zip.generateAsync({ type: 'uint8array' });
}

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body: await makeSeed() });
ok('seed', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 4000));

// Switch to Pages mode so the header/footer bands render.
await page.evaluate(() => document.querySelector('[data-testid="layout-pages"]')?.click());
await new Promise((r) => setTimeout(r, 500));

const bands = await page.evaluate(() => {
  return {
    header: (document.querySelector('[data-band="header"]')?.textContent ?? '').trim(),
    footer: (document.querySelector('[data-band="footer"]')?.textContent ?? '').trim(),
  };
});
if (bands.header.includes('Seed header')) {
  ok('header read', '"' + bands.header.slice(0, 40) + '"');
} else {
  failL('header read', 'expected "Seed header" in band, got "' + bands.header + '"');
}
if (bands.footer.includes('Seed footer')) {
  ok('footer read', '"' + bands.footer.slice(0, 40) + '"');
} else {
  failL('footer read', 'expected "Seed footer" in band, got "' + bands.footer + '"');
}

// Edit the header ; save round-trip.
await page.evaluate(() => {
  const h = document.querySelector('[data-band="header"]');
  if (h) {
    h.innerHTML = '<p>Edited header — V0.2 test</p>';
    h.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
});
await new Promise((r) => setTimeout(r, 2000));

const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const z = await JSZip.loadAsync(await after.arrayBuffer());
const stylesXml = await z.file('styles.xml')?.async('string') ?? '';
if (stylesXml.includes('<style:header>') && stylesXml.includes('Edited header')) {
  ok('header write', 'styles.xml carries the edited header');
} else {
  failL('header write',
    'expected <style:header> with "Edited header" — styles.xml :\n' + stylesXml);
}
if (stylesXml.includes('<style:footer>') && stylesXml.includes('Seed footer')) {
  ok('footer preserved', 'footer untouched in round-trip');
} else {
  failL('footer preserved',
    'expected Seed footer to survive — styles.xml :\n' + stylesXml);
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
