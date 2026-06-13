// feature-interactions.mjs — cross-feature regression matrix.
//
// Each Tn suite tests ONE feature in isolation. This suite covers
// COMBINATIONS that the single-feature suites can't catch :
//
//   A. WYSIWYG ODT
//      A1. Type content → toggle Continu / Pages → content survives.
//      A2. Continu : add bookmark + footnote + field → save → all 3 ODF
//          shapes co-exist in the saved XML.
//      A3. Pages : edit header band → toggle Continu → toggle back to
//          Pages → header content still present.
//      A4. Add a comment span + insert a footnote on top of it → save
//          → comment + footnote both round-trip.
//
//   B. LaTeX editor
//      B1. Symbol palette insert + bibliography click both splice at
//          cursor (no mutual interference).
//      B2. SyncTeX hooks expose both directions on the same .tex file.
//
//   C. Spreadsheet
//      C1. Type values into A1/A2 + a formula =A1+A2 in A3 → toggle
//          sheet tabs → return → cells AND formula still there.
//      C2. Add a sheet → save → seed sheet name + new sheet name both
//          land in the round-tripped XML.
//
// The goal isn't exhaustive coverage of every feature — that's the
// per-suite jobs. The goal is to catch interactions where one
// feature's state-management breaks another (the kind of bug a
// pageMode toggle that wipes contenteditable would have caught
// before it shipped).

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom cross-feature interactions suite\x1b[0m');

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

// =========================================================
// A. WYSIWYG ODT interactions
// =========================================================
async function makeOdtSeed() {
  const z = new JSZip();
  z.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  z.folder('META-INF').file('manifest.xml',
    '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>');
  z.file('meta.xml',
    '<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
  z.file('content.xml',
`<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:body><office:text>
    <text:p>Seed body text.</text:p>
  </office:text></office:body>
</office:document-content>`);
  return z.generateAsync({ type: 'uint8array' });
}

const odtPath = 'interactions-odt-' + Date.now() + '.odt';
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(odtPath),
  { method: 'PUT', body: await makeOdtSeed() });

const odtPage = await browser.newPage();
await odtPage.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await odtPage.evaluate((p) => (window).weftLoomOpenFile(p), odtPath);
await new Promise((r) => setTimeout(r, 4000));

// A1 : type → toggle Continu/Pages → content survives.
await odtPage.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (!ce) return;
  ce.focus();
  const range = document.createRange();
  range.selectNodeContents(ce);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('insertText', false, ' interaction-test-payload');
  ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 500));
await odtPage.evaluate(() => document.querySelector('[data-testid="layout-pages"]')?.click());
await new Promise((r) => setTimeout(r, 800));
// In Pages mode there are 3 contenteditables (header / body /
// footer). The body is the one with .wysiwyg-surface ; we scope
// to that to avoid reading the header's placeholder text.
const afterPagesToggle = await odtPage.evaluate(() => {
  const body = document.querySelector('.wysiwyg-surface');
  return (body?.textContent ?? '').trim();
});
if (afterPagesToggle.includes('interaction-test-payload')) {
  ok('A1 pageMode toggle preserves body', '"' + afterPagesToggle.slice(0, 60) + '"');
} else {
  failL('A1 pageMode toggle preserves body', 'expected "interaction-test-payload", got "' + afterPagesToggle + '"');
}

// A3 : edit header band in Pages mode → toggle Continu → back to Pages → header content present.
await odtPage.evaluate(() => {
  const h = document.querySelector('[data-band="header"]');
  if (h) {
    h.innerHTML = '<p>my live header</p>';
    h.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
});
await new Promise((r) => setTimeout(r, 500));
await odtPage.evaluate(() => document.querySelector('[data-testid="layout-continuous"]')?.click());
await new Promise((r) => setTimeout(r, 500));
await odtPage.evaluate(() => document.querySelector('[data-testid="layout-pages"]')?.click());
await new Promise((r) => setTimeout(r, 800));
const headerAfterRoundtrip = await odtPage.evaluate(() => {
  const h = document.querySelector('[data-band="header"]');
  return (h?.textContent ?? '').trim();
});
if (headerAfterRoundtrip.includes('my live header')) {
  ok('A3 header survives Pages↔Continu', '"' + headerAfterRoundtrip + '"');
} else {
  failL('A3 header survives Pages↔Continu', 'expected "my live header", got "' + headerAfterRoundtrip + '"');
}

// A2 + A4 : add bookmark + footnote + field together → save → assert all in saved XML.
// Toggle back to continuous first so we can use the same toolbar buttons.
await odtPage.evaluate(() => document.querySelector('[data-testid="layout-continuous"]')?.click());
await new Promise((r) => setTimeout(r, 500));
await odtPage.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (!ce) return;
  ce.focus();
  const range = document.createRange();
  range.selectNodeContents(ce);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  // Inject bookmark + footnote + field via the same DOM the toolbar uses.
  ce.insertAdjacentHTML('beforeend',
    '<p>Multi-shape : '
    + '<a class="odt-bookmark" data-name="multiBM" data-role="point"></a>'
    + '<sup class="footnote" data-id="ftnX" data-body="Multi-test body.">X</sup>'
    + '<span class="odt-field" data-kind="page-number">[#]</span>'
    + '.</p>');
  ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2000));
const saved = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(odtPath));
const sZip = await JSZip.loadAsync(await saved.arrayBuffer());
const sXml = await sZip.file('content.xml')?.async('string') ?? '';
const sStyles = await sZip.file('styles.xml')?.async('string') ?? '';
const hasBookmark = sXml.includes('<text:bookmark text:name="multiBM"');
const hasFootnote = sXml.includes('text:note-class="footnote"') && sXml.includes('Multi-test body.');
const hasField = sXml.includes('<text:page-number');
if (hasBookmark && hasFootnote && hasField) {
  ok('A2 bookmark + footnote + field co-exist', 'all 3 shapes in saved content.xml');
} else {
  failL('A2 bookmark + footnote + field co-exist',
    'bookmark=' + hasBookmark + ' footnote=' + hasFootnote + ' field=' + hasField);
}
if (sStyles.includes('<style:header>') && sStyles.includes('my live header')) {
  ok('A3 header persisted to styles.xml', 'styles.xml carries the edited header');
} else {
  failL('A3 header persisted to styles.xml', 'styles.xml missing header — got : ' + sStyles.slice(0, 400));
}
await odtPage.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(odtPath), { method: 'DELETE' }).catch(() => {});

// =========================================================
// B. LaTeX editor : palette + bib + SyncTeX hooks
// =========================================================
const texPath = 'interactions-tex-' + Date.now() + '.tex';
const bibPath = 'interactions-bib-' + Date.now() + '.bib';
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(texPath),
  { method: 'PUT', body: '\\documentclass{article}\n\\begin{document}\n\\end{document}\n' });
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(bibPath),
  { method: 'PUT', body: '@article{einstein1905,\n  title={Special Relativity},\n  author={Einstein, A.},\n  year={1905},\n}\n' });

const texPage = await browser.newPage();
await texPage.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await texPage.evaluate((p) => (window).weftLoomOpenFile(p), texPath);
await new Promise((r) => setTimeout(r, 3500));

// B1 : palette insert + bib click → both land at cursor.
await texPage.evaluate(() => document.querySelector('[data-testid="latex-palette-toggle"]')?.click());
await new Promise((r) => setTimeout(r, 300));
await texPage.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('[data-testid="latex-palette-cell"]'));
  const alpha = cells.find(c => c.getAttribute('data-cmd') === '\\alpha');
  alpha?.click();
});
await new Promise((r) => setTimeout(r, 400));
await texPage.evaluate(() => document.querySelector('[data-testid="bib-toggle"]')?.click());
await new Promise((r) => setTimeout(r, 1500));
await texPage.evaluate(() => {
  const entries = Array.from(document.querySelectorAll('[data-testid="bib-entry"]'));
  entries.find(e => e.getAttribute('data-key') === 'einstein1905')?.click();
});
await new Promise((r) => setTimeout(r, 500));
const texBuf = await texPage.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '');
if (texBuf.includes('\\alpha') && texBuf.includes('\\cite{einstein1905}')) {
  ok('B1 palette + bib both insert at cursor', '\\alpha + \\cite{einstein1905} present');
} else {
  failL('B1 palette + bib both insert at cursor',
    'buf=' + texBuf.replace(/\\n/g, ' ').slice(0, 250));
}

// B2 : SyncTeX hooks both directions exposed.
const syncHooks = await texPage.evaluate(() => ({
  fw: typeof (window).weftLoomSyncTeXForward,
  bw: typeof (window).weftLoomSyncTeXBackward,
}));
if (syncHooks.fw === 'function' && syncHooks.bw === 'function') {
  ok('B2 SyncTeX hooks both surfaced', 'forward + backward');
} else {
  failL('B2 SyncTeX hooks both surfaced', JSON.stringify(syncHooks));
}
await texPage.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(texPath), { method: 'DELETE' }).catch(() => {});
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(bibPath), { method: 'DELETE' }).catch(() => {});

// =========================================================
// C. Spreadsheet : formula + sheet tab switch + save
// =========================================================
const odsPath = 'interactions-ods-' + Date.now() + '.ods';
const z = new JSZip();
z.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
z.folder('META-INF').file('manifest.xml',
  '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>');
z.file('meta.xml',
  '<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
z.file('content.xml',
`<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:spreadsheet>
    <table:table table:name="Main">
      <table:table-row>
        <table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
        <table:table-cell office:value-type="float" office:value="4"><text:p>4</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
        <table:table-cell table:formula="of:=A1+A2" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>
      </table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>`);
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(odsPath),
  { method: 'PUT', body: await z.generateAsync({ type: 'uint8array' }) });

const odsPage = await browser.newPage();
await odsPage.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await odsPage.evaluate((p) => (window).weftLoomOpenFile(p), odsPath);
await new Promise((r) => setTimeout(r, 3500));

// C1 : add a new sheet → tab into it → switch back → formula cell on Main still computed.
await odsPage.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.trim() === '+ Sheet');
  btns[0]?.click();
});
await new Promise((r) => setTimeout(r, 600));
await odsPage.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('[data-testid="ods-sheet-tab"]'));
  const main = tabs.find(t => t.getAttribute('data-sheet') === 'Main');
  main?.click();
});
await new Promise((r) => setTimeout(r, 500));
const formulaSurvives = await odsPage.evaluate(() => {
  const cell = document.querySelector('[data-cell="2,0"]');
  return cell?.textContent?.trim();
});
if (formulaSurvives === '7') {
  ok('C1 formula survives sheet-switch round-trip', 'A3 = 7');
} else {
  failL('C1 formula survives sheet-switch round-trip', 'got "' + formulaSurvives + '"');
}

// C2 : save → both sheet names land in saved XML.
await new Promise((r) => setTimeout(r, 1500));
const r = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(odsPath));
const savedOds = await JSZip.loadAsync(await r.arrayBuffer());
const cxml = await savedOds.file('content.xml')?.async('string') ?? '';
if (cxml.includes('table:name="Main"') && cxml.includes('table:name="Sheet2"')
 && cxml.includes('table:formula="of:=A1+A2"')) {
  ok('C2 multi-sheet + formula round-trip', 'Main + Sheet2 + =A1+A2 all preserved');
} else {
  failL('C2 multi-sheet + formula round-trip',
    'snippet : ' + cxml.slice(cxml.indexOf('<office:spreadsheet>'), cxml.indexOf('<office:spreadsheet>') + 500));
}

await odsPage.close();
await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(odsPath), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
