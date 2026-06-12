// wysiwyg-odt.mjs — sibling of wysiwyg-rtf.mjs, exercises the
// pure-browser ODT load + save path through the WysiwygEditor.
//
// Invariants :
//
//   1. Opening a `.odt` file mounts the WYSIWYG surface
//      (contenteditable + toolbar), NOT the raw-source CodeMirror.
//      The user flagged authoring word-processor formats as raw
//      code as bad UX — this test trips on any regression that
//      puts CodeMirror back in front of an .odt file.
//
//   2. The ODT round-trip preserves the anchor text + the new
//      content typed in the editor : seed minimal-but-valid ODT
//      bytes, open, edit, wait for the debounced save, fetch back,
//      verify the saved bytes are a valid ZIP + the unzipped
//      content.xml contains both the seed text and the edit.
//
// V0.1 doesn't try to assert on inline formatting (bold/italic/
// underline) because the contenteditable's per-char fragmentation
// is the same as RTF — we just check that the round-trip preserves
// the body text. The writer's automatic-styles table is exercised
// in the odt.test.ts unit suite (TODO V0.2 follow-up).

import puppeteer from 'puppeteer';
// jszip lives in web/node_modules ; the tests/ runner doesn't have
// its own copy. Resolve via the relative path so the harness stays
// portable.
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'wysiwyg-odt-test.odt';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

// Build a minimal ODT byte stream we can PUT to the server. Same
// shape the writer produces, kept verbatim here so the test isn't
// reduced to "the writer can read what the writer writes."
async function makeSeedODT() {
  const zip = new JSZip();
  // 1×1 transparent PNG — embedded under Pictures/seed.png and
  // referenced from the body so the read-path test can check the
  // editor surfaces the image as an <img> tag.
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
  const pngBytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.folder('META-INF').file('manifest.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="Pictures/seed.png" manifest:media-type="image/png"/>
</manifest:manifest>
`);
  zip.file('meta.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
  <office:meta><dc:title>Seed</dc:title></office:meta>
</office:document-meta>
`);
  zip.file('content.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  office:version="1.2">
  <office:body>
    <office:text>
      <text:p>Hello ODT world.</text:p>
      <text:p><draw:frame draw:name="seed" text:anchor-type="as-char" svg:width="1in" svg:height="1in"><draw:image xlink:href="Pictures/seed.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>
    </office:text>
  </office:body>
</office:document-content>
`);
  zip.file('Pictures/seed.png', pngBytes);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

console.log('\n\x1b[1mweft-loom WYSIWYG ODT suite\x1b[0m');

// 1) seed the fixture
const seedBytes = await makeSeedODT();
const seed = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), {
  method: 'PUT',
  body: seedBytes,
});
if (seed.status !== 200 && seed.status !== 204) {
  failL('seed fixture', 'HTTP ' + seed.status);
  process.exit(1);
}
ok('seed fixture', PATH + ' (' + seedBytes.byteLength + ' bytes)');

// 2) launch puppeteer + open the file via weftLoomOpenFile
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

const opened = await page.evaluate((p) => {
  const fn = window.weftLoomOpenFile;
  if (typeof fn !== 'function') return false;
  fn(p);
  return true;
}, PATH);
if (!opened) {
  failL('open file', 'window.weftLoomOpenFile missing');
  await browser.close();
  process.exit(1);
}
// ODT load goes through jszip async ; give it more time than the
// RTF parse.
await new Promise((r) => setTimeout(r, 3000));

// 3) assert WYSIWYG mounted (not CodeMirror) + seed text rendered
//    + the embedded image was resolved to an <img> with a data: URL.
const mounted = await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  const cm = document.querySelector('.cm-editor');
  const img = ce?.querySelector('img');
  return {
    hasWysiwyg: !!ce,
    hasCodeMirror: !!cm,
    body: ce ? (ce.textContent || '').trim().slice(0, 80) : '',
    formatLabel: (document.querySelector('.uppercase')?.textContent || '').trim(),
    imgSrcPrefix: img ? (img.getAttribute('src') || '').slice(0, 30) : '',
  };
});
if (!mounted.hasWysiwyg) {
  failL('WYSIWYG mount', 'contenteditable surface absent');
} else if (mounted.hasCodeMirror) {
  failL('WYSIWYG mount', 'CodeMirror also mounted — should be WYSIWYG-only for .odt');
} else {
  ok('WYSIWYG mount', 'contenteditable present, no CodeMirror');
}
if (!mounted.body.includes('Hello ODT world')) {
  failL('WYSIWYG initial content', 'expected "Hello ODT world" got "' + mounted.body + '"');
} else {
  ok('WYSIWYG initial content', '"' + mounted.body + '"');
}
// Image-read path : the seed ODT carries Pictures/seed.png + a
// <draw:image> reference ; parseODT should resolve the href to a
// data: URL the editor surfaces as an <img>. Two namespace bugs
// had to be fixed for this to light up :
//   1. The seed's <office:document-content> root must declare
//      xmlns:svg (otherwise svg:width / svg:height are unbound
//      prefixes + DOMParser drops the whole <draw:frame> subtree).
//   2. The svg namespace URI is
//      urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0
//      — NOT …svg-compatible-processors:1.0 (the latter was an
//      earlier typo on my side).
if (mounted.imgSrcPrefix.startsWith('data:image/png')) {
  ok('image read path', 'data: URL surfaced from Pictures/seed.png');
} else {
  failL('image read path',
    'expected <img src="data:image/png..."> ; got src prefix : "'
    + mounted.imgSrcPrefix + '"');
}

// 4) drive an edit (text + a 2×2 table insert) + wait for the
//    debounced save (~600 ms) + extra time for jszip generation.
await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (!ce) return;
  ce.focus();
  const range = document.createRange();
  range.selectNodeContents(ce);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('insertText', false, ' — edited');
  // Append a small 2×2 table directly via insertHTML so the test
  // can assert table round-trip without depending on the toolbar
  // click. The component's `insertTable()` produces the same shape.
  document.execCommand('insertHTML', false,
    '<table><tbody><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></tbody></table>');
  ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2000));

// 5) fetch the saved ODT + unzip + check content.xml carries both
//    the seed anchor and the new edit.
const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
if (!after.ok) {
  failL('save round-trip', 'GET HTTP ' + after.status);
} else {
  const buf = await after.arrayBuffer();
  if (buf.byteLength < 200) {
    failL('save round-trip', 'ODT too small (' + buf.byteLength + ' bytes) — write probably failed');
  } else {
    try {
      const z = await JSZip.loadAsync(buf);
      const mime = await z.file('mimetype')?.async('string');
      if (mime !== 'application/vnd.oasis.opendocument.text') {
        failL('ODT mimetype', 'expected application/vnd.oasis.opendocument.text, got ' + mime);
      } else {
        ok('ODT mimetype', 'application/vnd.oasis.opendocument.text');
      }
      const xml = await z.file('content.xml')?.async('string');
      if (!xml) {
        failL('content.xml present', 'missing');
      } else if (!xml.includes('Hello ODT world')) {
        failL('seed text preserved', 'original "Hello ODT world" lost in saved bytes');
      } else if (!xml.includes('edited')) {
        failL('edit persisted', 'new " — edited" suffix missing in saved bytes');
      } else {
        ok('round-trip', '"Hello ODT world … edited"');
      }
      // Table assertion : the writer should emit <table:table> with
      // 2 rows × 2 cells carrying the A1/B1/A2/B2 anchors.
      if (xml.includes('<table:table') && xml.includes('A1') && xml.includes('B2')) {
        ok('table round-trip', '<table:table> with all four cell anchors');
      } else {
        failL('table round-trip',
          'expected <table:table> + A1 + B2 in saved XML, got : '
          + xml.slice(xml.indexOf('<office:body>') > 0 ? xml.indexOf('<office:body>') : 0, 400));
      }
      // Image-write-back of new-data:-URL <img> tags through the
      // contenteditable is V0.4 work — the puppeteer harness can't
      // reliably reproduce it (the contenteditable's input-event
      // sequence after insertHTML doesn't surface the new <img>
      // child to the save path consistently). The read path is
      // covered by the seed ODT carrying Pictures/seed.png + the
      // earlier `image read path` assertion ; the writer code is
      // in place + exercised by a unit-style probe in V0.4.
      //
      // Pictures/ entries the seed-ODT shipped should round-trip
      // back through the write path verbatim once we wire the
      // editor → writer image-collection bridge (V0.4).
    } catch (e) {
      failL('parse saved ODT', String(e?.message ?? e));
    }
  }
}

await browser.close();
// Cleanup
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
