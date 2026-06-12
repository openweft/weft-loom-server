// wysiwyg-odt-toolbar.mjs — exercises the V0.8 toolbar surface on an
// open ODT file : insert link, insert footnote, align right, strike,
// super, sub via the toolbar buttons (no execCommand from the test
// directly — we click() the buttons by aria-label/title).
//
// Why this complements wysiwyg-odt.mjs : the round-trip suite confirms
// the writer + reader. This suite confirms the *toolbar* still wires
// the right execCommand / insertHTML calls, since the user-visible
// path is "select text, click button" not "drive insertHTML from
// puppeteer."

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'wysiwyg-odt-toolbar-test.odt';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

// Tiny seed : a single paragraph the toolbar will mutate.
async function makeSeed() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.folder('META-INF').file('manifest.xml',
`<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>`);
  zip.file('content.xml',
`<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text>
    <text:p>Hello toolbar world.</text:p>
  </office:text></office:body>
</office:document-content>`);
  return zip.generateAsync({ type: 'uint8array' });
}

console.log('\n\x1b[1mweft-loom WYSIWYG ODT toolbar suite\x1b[0m');

const seedBytes = await makeSeed();
const seed = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), {
  method: 'PUT', body: seedBytes,
});
if (seed.status !== 200 && seed.status !== 204) {
  failL('seed fixture', 'HTTP ' + seed.status);
  process.exit(1);
}
ok('seed fixture', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// Pre-stub the prompt() dialogs so insertLink + insertFootnote get
// deterministic inputs without blocking on UI.
page.on('dialog', async (d) => {
  if (d.message().toLowerCase().includes('url')) await d.accept('https://example.org/');
  else if (d.message().toLowerCase().includes('footnote')) await d.accept('Toolbar-added body.');
  else await d.dismiss();
});

await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 3000));

// Helper : select all text inside the contenteditable so subsequent
// toolbar clicks apply to the whole paragraph.
async function selectAll() {
  await page.evaluate(() => {
    const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!ce) return;
    ce.focus();
    const range = document.createRange();
    range.selectNodeContents(ce);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}
// Helper : click a toolbar button by its title attribute.
async function clickToolbar(title) {
  const found = await page.evaluate((t) => {
    const btn = document.querySelector('button[title="' + t + '"]');
    if (btn) { btn.click(); return true; }
    return false;
  }, title);
  if (!found) failL('toolbar click', 'button with title="' + title + '" not found');
}

// 1) Bold via toolbar (sanity — existing path) — picks up the V0.7
//    strike/sub/super work too.
await selectAll();
await clickToolbar('Bold (⌘B)');
const hasBold = await page.evaluate(() => !!document.querySelector('[contenteditable="true"] b, [contenteditable="true"] strong'));
if (hasBold) ok('toolbar bold', '<b> / <strong> applied'); else failL('toolbar bold', 'no bold element');

// 2) Strike via toolbar
await selectAll();
await clickToolbar('Strikethrough');
const hasStrike = await page.evaluate(() => !!document.querySelector('[contenteditable="true"] s, [contenteditable="true"] strike'));
if (hasStrike) ok('toolbar strike', '<s>/<strike> applied'); else failL('toolbar strike', 'no strike element');

// 3) Superscript via toolbar
await selectAll();
await clickToolbar('Superscript');
const hasSup = await page.evaluate(() => !!document.querySelector('[contenteditable="true"] sup:not(.footnote)'));
if (hasSup) ok('toolbar superscript', '<sup> applied'); else failL('toolbar superscript', 'no non-footnote sup element');

// 4) Subscript via toolbar (clear the sup first by re-toggling)
await selectAll();
await clickToolbar('Superscript');
await selectAll();
await clickToolbar('Subscript');
const hasSub = await page.evaluate(() => !!document.querySelector('[contenteditable="true"] sub'));
if (hasSub) ok('toolbar subscript', '<sub> applied'); else failL('toolbar subscript', 'no sub element');

// 5) Align right via toolbar
await selectAll();
await clickToolbar('Align right');
const isRightAligned = await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"]');
  const p = ce?.querySelector('p');
  const inline = p?.getAttribute('style') ?? '';
  const computed = p ? window.getComputedStyle(p).textAlign : '';
  return inline.includes('text-align') || computed === 'right';
});
if (isRightAligned) ok('toolbar align right', 'paragraph carries right alignment'); else failL('toolbar align right', 'no text-align on first <p>');

// 6) Insert link via toolbar (prompt stub returns https://example.org/)
await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"]');
  ce?.focus();
  const range = document.createRange();
  range.selectNodeContents(ce);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
});
await clickToolbar('Insert link');
await new Promise((r) => setTimeout(r, 300));
const linkHref = await page.evaluate(() => {
  const a = document.querySelector('[contenteditable="true"] a');
  return a?.getAttribute('href') ?? '';
});
if (linkHref === 'https://example.org/') ok('toolbar insert link', 'href = https://example.org/');
else failL('toolbar insert link', 'expected example.org href, got "' + linkHref + '"');

// 7) Insert footnote via toolbar (prompt stub returns the body)
await clickToolbar('Insert footnote');
await new Promise((r) => setTimeout(r, 500));
const footnote = await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"]');
  const ftn = ce?.querySelector('sup.footnote');
  return {
    id: ftn?.getAttribute('data-id') ?? '',
    body: ftn?.getAttribute('data-body') ?? '',
    cite: ftn?.textContent ?? '',
    debug: ce?.innerHTML.slice(0, 400) ?? '',
  };
});
if (footnote.id && footnote.body === 'Toolbar-added body.' && footnote.cite) {
  ok('toolbar insert footnote', 'id=' + footnote.id + ' cite=' + footnote.cite);
} else {
  failL('toolbar insert footnote',
    'expected ftnN/cite="N"/body="Toolbar-added body." got '
    + JSON.stringify({ id: footnote.id, body: footnote.body, cite: footnote.cite })
    + ' html=' + footnote.debug);
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
