// odt-fields-outline.mjs — combined regression for two features :
//
//   1. ODT field round-trip (T10 V0.1)
//      - seed an ODT with <text:page-number/>, <text:title/>,
//        <text:user-field-get text:name="ClientName"/>
//      - confirm the WYSIWYG surfaces them as <span class="odt-field">
//      - confirm the saved ODT re-emits the ODF field elements
//
//   2. ODT/RTF outline support
//      - seed an ODT with <text:h text:outline-level=1..3>
//      - confirm the OutlinePanel shows the headings

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'odt-fields-' + Date.now() + '.odt';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODT fields + outline suite\x1b[0m');

// Seed a minimal ODT with fields + 3 headings.
async function makeSeed() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.folder('META-INF').file('manifest.xml',
`<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`);
  zip.file('meta.xml',
`<?xml version="1.0"?>
<office:document-meta
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  office:version="1.2">
  <office:meta>
    <dc:title>Seed Doc</dc:title>
    <meta:user-defined meta:name="ClientName">Acme</meta:user-defined>
    <meta:user-defined meta:name="ProjectCode">P-42</meta:user-defined>
  </office:meta>
</office:document-meta>`);
  zip.file('content.xml',
`<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  office:version="1.2">
  <office:body><office:text>
    <text:h text:outline-level="1">Top Chapter</text:h>
    <text:p>Page <text:page-number text:select-page="current">3</text:page-number> of <text:page-count>10</text:page-count>, title : <text:title>Seed Doc</text:title>.</text:p>
    <text:h text:outline-level="2">Sub heading</text:h>
    <text:p>Client : <text:user-field-get text:name="ClientName">Acme</text:user-field-get>.</text:p>
    <text:h text:outline-level="3">Deeper</text:h>
    <text:p>Body.</text:p>
  </office:text></office:body>
</office:document-content>`);
  return zip.generateAsync({ type: 'uint8array' });
}

const seedBytes = await makeSeed();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body: seedBytes });
ok('seed', PATH + ' (' + seedBytes.byteLength + ' bytes)');

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 4000));

// 1) Field surfacing in the WYSIWYG.
const fields = await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  const spans = Array.from(ce?.querySelectorAll('span.odt-field') ?? []);
  return spans.map(s => ({
    kind: s.getAttribute('data-kind'),
    name: s.getAttribute('data-name'),
    text: s.textContent ?? '',
  }));
});
const kinds = fields.map(f => f.kind);
if (kinds.includes('page-number') && kinds.includes('page-count')
 && kinds.includes('title')      && kinds.includes('user-field-get')) {
  ok('fields read', '4 fields surfaced as .odt-field spans');
} else {
  failL('fields read', 'got kinds=' + JSON.stringify(kinds));
}
const userField = fields.find(f => f.kind === 'user-field-get');
if (userField && userField.name === 'ClientName' && userField.text === 'Acme') {
  ok('user-field name+value', 'data-name=ClientName, text="Acme"');
} else {
  failL('user-field name+value', JSON.stringify(userField));
}

// 2) Headings in the OutlinePanel.
// Expand the outline accordion if collapsed.
await page.evaluate(() => {
  const headers = Array.from(document.querySelectorAll('aside button'))
    .filter(b => b.textContent && b.textContent.trim().startsWith('Outline'));
  for (const h of headers) {
    if (h.getAttribute('aria-expanded') === 'false') h.click();
  }
});
await new Promise((r) => setTimeout(r, 1500));

const outlineEntries = await page.evaluate(() => {
  const sel = document.querySelector('[data-testid="outline-depth"]');
  const aside = sel?.closest('aside');
  if (!aside) return [];
  return Array.from(aside.querySelectorAll('ul > li button')).map(b => b.textContent?.trim() ?? '');
});
if (outlineEntries.length === 3
 && outlineEntries[0].includes('Top Chapter')
 && outlineEntries[1].includes('Sub heading')
 && outlineEntries[2].includes('Deeper')) {
  ok('odt outline', '3 headings surfaced (chapter/sub/deeper)');
} else {
  failL('odt outline',
    'expected 3 headings, got ' + outlineEntries.length + ' : ' + JSON.stringify(outlineEntries));
}

// 3) Write-path : trigger a save (debounced) + verify the new ODT
// re-emits <text:page-number/> + <text:user-field-get text:name="ClientName"/>
await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (!ce) return;
  ce.focus();
  // Append an extra space to mark the doc dirty + trigger save.
  document.execCommand('insertText', false, ' ');
  ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2000));
const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const buf = await after.arrayBuffer();
const z = await JSZip.loadAsync(buf);
const xml = await z.file('content.xml')?.async('string') ?? '';
const metaXml = await z.file('meta.xml')?.async('string') ?? '';
if (xml.includes('<text:page-number') && xml.includes('<text:title')
 && xml.includes('<text:user-field-get') && xml.includes('text:name="ClientName"')) {
  ok('fields write-back', 'page-number + title + user-field-get all re-emitted');
} else {
  failL('fields write-back',
    'expected all 4 field tags, got snippet :\n'
    + xml.slice(xml.indexOf('<office:body>'), xml.indexOf('<office:body>') + 600));
}
if (metaXml.includes('meta:name="ClientName"')
 && metaXml.includes('>Acme<')
 && metaXml.includes('meta:name="ProjectCode"')) {
  ok('userDefined round-trip', 'ClientName + ProjectCode preserved in meta.xml');
} else {
  failL('userDefined round-trip',
    'meta.xml snippet : ' + metaXml.slice(0, 500));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
