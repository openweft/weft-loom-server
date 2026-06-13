// ods-templates-collab.mjs — T9 V0.3 + ODS starter templates.
//
//   1. Each ODS template entry in the catalogue (blank / budget /
//      timesheet / roster) creates a valid round-trippable file
//      via the NewFileDialog path (we drive it via the same
//      weftLoomTemplates + writeODS hooks the odt-templates suite
//      uses).
//   2. Two browser sessions sync cell edits via the Y.Map provider.

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom ODS templates + collab suite\x1b[0m');

// --- Part 1 : templates --------------------------------------
const browser1 = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page1 = await browser1.newPage();
await page1.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

const tplCatalog = await page1.evaluate(() => {
  const m = (window).weftLoomTemplates;
  if (!m) return null;
  return m.TEMPLATES
    .filter((t) => t.language === 'ods')
    .map((t) => ({ id: t.id, name: t.name, mode: t.mode, hasSheets: typeof t.odsSheets === 'function' }));
});
const expected = ['ods-blank', 'ods-budget', 'ods-timesheet', 'ods-roster'];
const got = (tplCatalog ?? []).map(t => t.id);
if (expected.every(id => got.includes(id))) {
  ok('ods templates registered', got.join(', '));
} else {
  failL('ods templates registered', 'expected ' + expected.join(', ') + ' got ' + got.join(', '));
}

// Create each template via the same writeODS hook + verify the
// file parses back as a valid ODS with the expected sheet name.
const expectedSheet = {
  'ods-blank': 'Sheet1',
  'ods-budget': 'Budget',
  'ods-timesheet': 'Hours',
  'ods-roster': 'Roster',
};
for (const id of expected) {
  const filename = 'ods-tpl-test-' + id + '.ods';
  const result = await page1.evaluate(async ({ ROOT, PROJECT, tplId, filename }) => {
    const w = window;
    const tpl = w.weftLoomTemplates.findTemplate(tplId);
    if (!tpl) return { ok: false, why: 'no template' };
    if (!tpl.odsSheets) return { ok: false, why: 'template not ODS' };
    const writeODS = w.weftLoomWriteODS;
    if (typeof writeODS !== 'function') {
      return { ok: false, why: 'weftLoomWriteODS hook missing' };
    }
    const sheets = tpl.odsSheets();
    const bytes = await writeODS(sheets, new Date().toISOString());
    const url = ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(filename);
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/vnd.oasis.opendocument.spreadsheet' },
      body: new Blob([bytes], { type: 'application/vnd.oasis.opendocument.spreadsheet' }),
    });
    return { ok: r.ok, status: r.status };
  }, { ROOT, PROJECT, tplId: id, filename });
  if (!result.ok) {
    // In the prod bundle the ods module isn't reachable via dynamic
    // import path. Fall back to opening NewFileDialog flow — but
    // that's brittle. Skip with a note instead.
    failL(id, 'create via writeODS failed : ' + JSON.stringify(result));
    continue;
  }
  const r = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(filename));
  const z = await JSZip.loadAsync(await r.arrayBuffer());
  const xml = await z.file('content.xml')?.async('string') ?? '';
  const want = expectedSheet[id];
  if (xml.includes('table:name="' + want + '"')) {
    ok(id, 'sheet "' + want + '" preserved');
  } else {
    failL(id, 'expected sheet "' + want + '" in saved XML');
  }
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(filename), { method: 'DELETE' }).catch(() => {});
}

// --- Part 2 : two-peer collab via Y.Map ----------------------
// Seed a tiny .ods, open it in two browser sessions, type a value
// in session A, confirm it appears in session B without a manual
// refresh.
const collabPath = 'ods-collab-' + Date.now() + '.ods';
const zSeed = new JSZip();
zSeed.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
zSeed.folder('META-INF').file('manifest.xml',
`<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`);
zSeed.file('meta.xml',
`<?xml version="1.0"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>`);
zSeed.file('content.xml',
`<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:spreadsheet>
    <table:table table:name="Sheet1">
      <table:table-row>
        <table:table-cell office:value-type="string"><text:p>seed</text:p></table:table-cell>
        <table:table-cell office:value-type="string"><text:p>data</text:p></table:table-cell>
      </table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>`);
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(collabPath),
  { method: 'PUT', body: await zSeed.generateAsync({ type: 'uint8array' }) });

const browser2 = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pageA = await browser1.newPage();
const pageB = await browser2.newPage();
await pageA.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await pageB.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await pageA.evaluate((p) => (window).weftLoomOpenFile(p), collabPath);
await pageB.evaluate((p) => (window).weftLoomOpenFile(p), collabPath);
await new Promise((r) => setTimeout(r, 4000));

// Peer A edits cell A1 ; peer B should observe the change within
// the WS round-trip latency (a few hundred ms).
await pageA.evaluate(() => {
  const cell = document.querySelector('[data-cell="0,0"]');
  if (!cell) return;
  cell.click();
  cell.focus();
  cell.textContent = 'live-edit';
  cell.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2500));

const seenAtB = await pageB.evaluate(() => {
  const cell = document.querySelector('[data-cell="0,0"]');
  return cell?.textContent?.trim();
});
if (seenAtB === 'live-edit') {
  ok('y-map collab', 'peer B observed peer A\'s edit');
} else {
  failL('y-map collab',
    'expected "live-edit" at peer B, got "' + seenAtB + '"');
}

await browser1.close();
await browser2.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(collabPath),
  { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
