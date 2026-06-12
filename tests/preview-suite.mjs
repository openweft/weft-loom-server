// preview-suite.mjs — in-browser validation of the PreviewPane
// for every previewable file type (markdown / html / rtf / latex /
// notebook). Uses puppeteer to open the SPA, navigate to a fixture
// file, and assert the rendered HTML body is non-empty + contains
// the expected anchor text.
//
// Run after ui-suite + lang-suite — the previous suites validate
// IO + dispatch ; this one validates RENDERING.
//
// Each case :
//   - PUT the fixture file via the files API
//   - Open the file in the SPA via puppeteer (click the row)
//   - Wait for the PreviewPane to render (.markdown-body)
//   - Assert the body contains the expected anchor text
//
// Cleanup runs at the end.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
let passed = 0;
let failed = 0;

function ok(name, msg)   { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name + (msg ? '  ' + msg : '')); }
function fail(name, msg) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + name + '  ' + msg); }

async function writeFixture(path, content) {
  const r = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(path),
    { method: 'PUT', body: content });
  if (r.status !== 200 && r.status !== 204) throw new Error('PUT ' + r.status);
}
async function deleteFixture(path) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(path),
    { method: 'DELETE' }).catch(() => {});
}

const CASES = [
  { lang: 'markdown', path: '_preview-tests/p.md',
    content: '# heading-anchor\n\nweft-loom preview test paragraph.\n',
    anchor: 'weft-loom preview test paragraph' },
  { lang: 'html', path: '_preview-tests/p.html',
    content: '<!doctype html><h1>html-anchor</h1><p>weft-loom preview html.</p>',
    anchor: 'html-anchor' },
  { lang: 'rtf', path: '_preview-tests/p.rtf',
    content: '{\\rtf1\\ansi\\b RTF anchor body\\b0 \\par}',
    anchor: 'RTF anchor body' },
];

console.log('\n\x1b[1mweft-loom preview suite\x1b[0m');

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  PAGE-ERR : ' + e.message));

await page.goto(ROOT, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));

for (const c of CASES) {
  try {
    await writeFixture(c.path, c.content);
  } catch (e) {
    fail(c.lang + ' : preview', 'fixture write ' + e.message);
    continue;
  }
  // Refresh the file explorer + open the file.
  await page.evaluate(() => location.reload());
  await new Promise((r) => setTimeout(r, 2500));
  // Open it (the file lives under _preview-tests/) ; the file
  // explorer renders dirs collapsed by default, so we expand first.
  const clicked = await page.evaluate((path) => {
    // Walk all buttons ; click the row whose textContent ends with
    // the file's basename.
    const base = path.split('/').pop();
    const buttons = Array.from(document.querySelectorAll('button'));
    // First expand any parent dir whose name appears in the path.
    const parent = path.split('/')[0];
    const parentBtn = buttons.find((b) => b.textContent && b.textContent.includes(parent));
    if (parentBtn) parentBtn.click();
    return new Promise((resolve) => {
      setTimeout(() => {
        const buttons2 = Array.from(document.querySelectorAll('button'));
        const target = buttons2.find((b) => b.textContent && b.textContent.includes(base));
        if (target) { target.click(); resolve(true); }
        else resolve(false);
      }, 500);
    });
  }, c.path);
  if (!clicked) {
    fail(c.lang + ' : preview', 'could not click file row ' + c.path);
    continue;
  }
  // Wait for the preview to populate. The .markdown-body host or a
  // PDF embed depending on language.
  await new Promise((r) => setTimeout(r, 2500));
  const ok2 = await page.evaluate((anchor) => {
    // PreviewPane is the canonical surface for markdown / html. RTF
    // files now open in the WYSIWYG editor (Word-like surface), so
    // the anchor lands in a contenteditable instead of the preview.
    // Check both — whichever surface holds the rendered text wins.
    const preview = document.querySelector('aside.bg-base-100 .markdown-body');
    if (preview && (preview.textContent || '').includes(anchor)) return true;
    const wysiwyg = document.querySelector('[contenteditable="true"][role="textbox"]');
    if (wysiwyg && (wysiwyg.textContent || '').includes(anchor)) return true;
    return false;
  }, c.anchor);
  if (ok2) {
    ok(c.lang + ' : preview', '("' + c.anchor + '" found in rendered body)');
  } else {
    fail(c.lang + ' : preview', 'anchor "' + c.anchor + '" not found in rendered body');
  }
}

// Cleanup.
for (const c of CASES) await deleteFixture(c.path);

await browser.close();

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
