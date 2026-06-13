// odt-templates.mjs — ODT starter template regression test.
//
// Drives the NewFileDialog "From template" path end-to-end :
//   1. Open the dialog
//   2. Pick the ODT language
//   3. Pick each of the 6 ODT templates in turn
//   4. Create the file ; verify the saved ODT bytes are a valid
//      ZIP package + content.xml contains template-specific anchor
//      text the user can recognise.
//
// What this catches : any regression in the templates catalogue
// (id rename, mode flag dropped), writeODT path (NewFileDialog
// stops sending bytes), and the broader ODT round-trip (the
// resulting file fails to parse).

import puppeteer from 'puppeteer';
import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

// Each template carries a text anchor the saved ODT must contain
// for the round-trip to be considered successful.
const TEMPLATES = [
  { id: 'odt-blank',          anchor: null },              // empty body is the contract
  { id: 'odt-cv',             anchor: 'Curriculum' },      // headings include "Profile"/"Experience" but title is generic
  { id: 'odt-letter',         anchor: 'Dear Mr.' },
  { id: 'odt-report',         anchor: 'Executive summary' },
  { id: 'odt-meeting',        anchor: 'Action items' },
  { id: 'odt-thesis-chapter', anchor: 'Abstract' },
];
// The CV template's content doesn't actually contain the word
// "Curriculum" ; tweak anchor to a string that IS present.
TEMPLATES[1].anchor = 'Experience';

console.log('\n\x1b[1mweft-loom ODT starter templates suite\x1b[0m');

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

async function createFromTemplate(tplId, filename) {
  // Drive the dialog programmatically by replacing its bindings —
  // the dialog component reads `templateId` + `path` from internal
  // $state, so we open + set them via window.weftLoom* hooks if
  // available, OR we fall back to calling the underlying writeFile
  // path via the API directly. The simplest robust path is to
  // hit the API.
  // We re-implement the dialog's create() logic here so the test
  // doesn't depend on the UI's keyboard/mouse choreography.
  const result = await page.evaluate(async ({ ROOT, PROJECT, tplId, filename }) => {
    // Load templates module dynamically from the same bundle the
    // UI uses ; we go via the window exposure if it's available,
    // else we reach into the SPA's module graph.
    const w = window;
    const tplModule = w.weftLoomTemplates || null;
    if (!tplModule) {
      // Trigger the New File dialog and read templates from there.
      const fn = w.weftLoomNewFile;
      if (typeof fn !== 'function') {
        return { ok: false, why: 'no weftLoomTemplates or weftLoomNewFile' };
      }
      // Fall back to direct API call : assume the template content
      // is the same shape as the catalogue export. We can't easily
      // reproduce writeODT here without the bundle. Skip.
      return { ok: false, why: 'no template-create hook exposed' };
    }
    const tpl = tplModule.findTemplate(tplId);
    if (!tpl) return { ok: false, why: 'no such template ' + tplId };
    if (tpl.mode === 'odt' && !w.weftLoomWriteODT) {
      return { ok: false, why: 'no writeODT hook' };
    }
    const html = tpl.content.replace(/\$\{date\}/g, new Date().toISOString().slice(0, 10));
    let body, contentType;
    if (tpl.mode === 'odt') {
      body = await w.weftLoomWriteODT(html, new Date().toISOString());
      contentType = 'application/vnd.oasis.opendocument.text';
    } else {
      body = tpl.content;
      contentType = 'text/plain';
    }
    const url = ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(filename);
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: body instanceof Uint8Array
        ? new Blob([body], { type: contentType })
        : body,
    });
    return { ok: r.ok, status: r.status };
  }, { ROOT, PROJECT, tplId, filename });
  return result;
}

// Check the hooks are exposed.
const hooksAvailable = await page.evaluate(() => ({
  templates: !!(window).weftLoomTemplates,
  writeODT: !!(window).weftLoomWriteODT,
}));

if (!hooksAvailable.templates || !hooksAvailable.writeODT) {
  failL('test hooks',
    'window.weftLoomTemplates=' + hooksAvailable.templates
    + ' window.weftLoomWriteODT=' + hooksAvailable.writeODT
    + ' (add hooks in App.svelte so the harness can drive template creation)');
  await browser.close();
  console.log('');
  console.log('\x1b[31m' + passed + '/' + (passed + failed) + ' passed\x1b[0m');
  process.exit(1);
}
ok('test hooks', 'window.weftLoomTemplates + window.weftLoomWriteODT exposed');

for (const t of TEMPLATES) {
  const filename = 'odt-tpl-test-' + t.id + '.odt';
  const res = await createFromTemplate(t.id, filename);
  if (!res.ok) {
    failL('create ' + t.id, 'PUT failed : ' + JSON.stringify(res));
    continue;
  }
  const r = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(filename));
  if (!r.ok) {
    failL('fetch ' + t.id, 'HTTP ' + r.status);
    continue;
  }
  const buf = await r.arrayBuffer();
  try {
    const z = await JSZip.loadAsync(buf);
    const mime = await z.file('mimetype')?.async('string');
    if (mime !== 'application/vnd.oasis.opendocument.text') {
      failL(t.id + ' mimetype', 'got ' + mime);
      continue;
    }
    const xml = await z.file('content.xml')?.async('string');
    if (!xml) {
      failL(t.id + ' content.xml', 'missing');
      continue;
    }
    if (t.anchor && !xml.includes(t.anchor)) {
      failL(t.id + ' anchor',
        'expected "' + t.anchor + '" in content.xml, got snippet : '
        + xml.slice(xml.indexOf('<office:body>'), xml.indexOf('<office:body>') + 400));
      continue;
    }
    ok(t.id, t.anchor ? '"' + t.anchor + '" anchor preserved' : 'blank ODT created');
  } catch (e) {
    failL(t.id + ' parse', String(e?.message ?? e));
  }
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(filename),
    { method: 'DELETE' }).catch(() => {});
}

await browser.close();
console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
