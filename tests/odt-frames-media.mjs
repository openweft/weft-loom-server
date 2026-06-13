// odt-frames-media.mjs — T12 regression : ODT text frames + media
// (audio / video) round-trip through reader + writer.
//
//   1. Seed an ODT with <draw:frame><draw:text-box> + <draw:plugin>
//      pointing at a Pictures/seed.mp3 entry.
//   2. Open in WYSIWYG : assert <aside.odt-textbox> + <audio> are
//      rendered with the expected content.
//   3. Insert a fresh <video data:…> via DOM injection ; trigger a
//      save ; assert the saved ODF has <draw:text-box>, <draw:plugin>
//      AND a Pictures/media*.mp4 entry in the manifest.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'odt-frames-' + Date.now() + '.odt';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODT frames + media suite\x1b[0m');

async function makeSeed() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  // 11 bytes of MP3-ish dummy payload (the test never plays it ;
  // it only checks the round-trip preserves the bytes).
  const dummyAudio = new Uint8Array([0xFF, 0xFB, 0x90, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  zip.folder('META-INF').file('manifest.xml',
`<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="Pictures/seed.mp3" manifest:media-type="audio/mpeg"/>
</manifest:manifest>`);
  zip.file('meta.xml',
`<?xml version="1.0"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2">
  <office:meta><meta:generator xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">seed</meta:generator></office:meta>
</office:document-meta>`);
  zip.file('content.xml',
`<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  office:version="1.2">
  <office:body><office:text>
    <text:p>Before frame.</text:p>
    <text:p>
      <draw:frame draw:name="callout" svg:width="10cm" svg:height="3cm">
        <draw:text-box><text:p>Boxed text here.</text:p></draw:text-box>
      </draw:frame>
    </text:p>
    <text:p>
      <draw:frame draw:name="jingle" svg:width="3cm" svg:height="1cm">
        <draw:plugin xlink:href="Pictures/seed.mp3" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="audio/mpeg"/>
      </draw:frame>
    </text:p>
    <text:p>After.</text:p>
  </office:text></office:body>
</office:document-content>`);
  zip.file('Pictures/seed.mp3', dummyAudio);
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

// Reader assertions.
const read = await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  const tb = ce?.querySelector('aside.odt-textbox');
  const audio = ce?.querySelector('audio');
  return {
    textbox: tb?.textContent?.trim() ?? '',
    audioSrc: (audio?.getAttribute('src') ?? '').slice(0, 30),
    audioName: audio?.getAttribute('data-name') ?? '',
  };
});
if (read.textbox.includes('Boxed text here')) {
  ok('text-frame read', 'aside.odt-textbox surfaces nested text');
} else {
  failL('text-frame read', JSON.stringify(read));
}
if (read.audioSrc.startsWith('data:audio/mpeg')) {
  ok('audio read', 'data:audio/mpeg surfaced from Pictures/seed.mp3');
} else {
  failL('audio read', 'expected data:audio/mpeg prefix, got "' + read.audioSrc + '"');
}

// Writer assertions : inject a fresh data: video + a new text-frame
// via direct DOM, trigger save, fetch + parse.
await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"]');
  if (!ce) return;
  // 1px transparent MP4 (tiny) — base64 is just enough bytes to be
  // a valid data: URL parseable shape ; the writer never plays it.
  const tinyMp4Base64 = 'AAAAGGZ0eXBpc29tAAAAAGlzb21pc28y'; // mp4 magic-ish
  const video = document.createElement('video');
  video.setAttribute('controls', '');
  video.setAttribute('src', 'data:video/mp4;base64,' + tinyMp4Base64);
  video.setAttribute('data-name', 'editor-video');
  const tb = document.createElement('aside');
  tb.className = 'odt-textbox';
  tb.style.width = '8cm';
  tb.style.height = '2cm';
  const p = document.createElement('p');
  p.textContent = 'Editor-inserted frame.';
  tb.appendChild(p);
  ce.appendChild(tb);
  ce.appendChild(video);
  ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2500));

const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const z = await JSZip.loadAsync(await after.arrayBuffer());
const xml = await z.file('content.xml')?.async('string') ?? '';
const manifest = await z.file('META-INF/manifest.xml')?.async('string') ?? '';
const filePaths = Object.keys(z.files);

if (xml.includes('<draw:text-box>') && xml.includes('Boxed text here')
 && xml.includes('Editor-inserted frame.')) {
  ok('text-frame write', 'both seed + editor frames re-emitted');
} else {
  failL('text-frame write',
    'snippet : ' + xml.slice(xml.indexOf('<draw:text-box>'),
      xml.indexOf('<draw:text-box>') + 500));
}

if (xml.includes('draw:plugin') && xml.includes('draw:mime-type="audio/mpeg"')) {
  ok('audio write', 'draw:plugin + audio mime preserved');
} else {
  failL('audio write', 'no draw:plugin / audio mime in saved XML');
}

if (xml.includes('draw:mime-type="video/mp4"')
 && filePaths.some(p => /Pictures\/media.*\.mp4$/.test(p))
 && manifest.includes('video/mp4')) {
  ok('video write', 'editor video re-packaged under Pictures/media*.mp4');
} else {
  failL('video write',
    'expected video draw:plugin + Pictures/media*.mp4 + manifest entry. files=' + JSON.stringify(filePaths));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
