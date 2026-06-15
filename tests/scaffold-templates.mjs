// scaffold-templates.mjs — V0.11 multi-file project templates.
// Asserts :
//   1. GET /api/project-templates lists the catalogue
//   2. POST /api/projects/{name}/scaffold writes every file +
//      reports the entry-point
//   3. The clash-detection refuses to overwrite existing files
//      unless force=true
//   4. SPA "Scaffold from template…" menu entry opens the dialog
//      and Apply seeds the files

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const STAMP = Date.now();

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom scaffold templates suite\x1b[0m');

// (1) Catalogue
const listResp = await fetch(ROOT + '/api/project-templates');
if (listResp.ok) {
  const data = await listResp.json();
  if (Array.isArray(data.items) && data.items.length >= 5) {
    ok('catalogue lists ≥ 5 templates', data.items.length + ' templates');
  } else {
    failL('catalogue lists ≥ 5 templates', JSON.stringify(data).slice(0, 200));
  }
  const ids = (data.items ?? []).map((t) => t.id);
  if (ids.includes('latex-phd-thesis') && ids.includes('marp-deck')) {
    ok('curated entries present', 'phd-thesis + marp-deck');
  } else {
    failL('curated entries present', JSON.stringify(ids));
  }
} else {
  failL('catalogue HTTP', 'HTTP ' + listResp.status);
}

// (2) Scaffold a beamer template into a fresh subdir-scoped path.
// Use unique paths via the test stamp so this test is idempotent
// across runs. We can't scaffold INTO a subdir directly (templates
// have absolute relative paths) — so we cleanup ALL template
// targets before the test in case prior runs left them around.
const beamerFiles = ['main.tex', 'figures/.gitkeep'];
for (const f of beamerFiles) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(f), { method: 'DELETE' }).catch(() => {});
}
const applyResp = await fetch(ROOT + '/api/projects/' + PROJECT + '/scaffold', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ template_id: 'latex-beamer' }),
});
if (applyResp.ok) {
  const d = await applyResp.json();
  if (Array.isArray(d.written) && d.written.includes('main.tex')) {
    ok('scaffold writes files', d.written.length + ' files : ' + d.written.join(', '));
  } else {
    failL('scaffold writes files', JSON.stringify(d));
  }
  if (d.entry === 'main.tex') {
    ok('entry-point reported', d.entry);
  } else {
    failL('entry-point reported', JSON.stringify(d.entry));
  }
} else {
  failL('scaffold HTTP', 'HTTP ' + applyResp.status);
}

// Verify main.tex on disk has the expected beamer preamble.
const mainBody = await (await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent('main.tex'))).text();
if (mainBody.includes('\\documentclass[aspectratio=169]{beamer}')) {
  ok('main.tex carries beamer preamble', mainBody.length + ' bytes');
} else {
  failL('main.tex carries beamer preamble', mainBody.slice(0, 80));
}

// (3) Re-scaffold WITHOUT force should 409.
const clashResp = await fetch(ROOT + '/api/projects/' + PROJECT + '/scaffold', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ template_id: 'latex-beamer' }),
});
if (clashResp.status === 409) {
  const d = await clashResp.json();
  if (Array.isArray(d.clashes) && d.clashes.includes('main.tex')) {
    ok('clash refused without force', d.clashes.length + ' clashes');
  } else {
    failL('clash refused without force', JSON.stringify(d));
  }
} else {
  failL('clash refused without force', 'HTTP ' + clashResp.status);
}

// With force=true the re-scaffold succeeds.
const forceResp = await fetch(ROOT + '/api/projects/' + PROJECT + '/scaffold', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ template_id: 'latex-beamer', force: true }),
});
if (forceResp.ok) {
  ok('force=true bypasses clash check');
} else {
  failL('force=true bypasses clash check', 'HTTP ' + forceResp.status);
}

// (4) SPA flow. Cleanup first.
for (const f of ['main.tex', 'figures/.gitkeep']) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(f), { method: 'DELETE' }).catch(() => {});
}
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
// Open the File menu + click the "Scaffold from template…" entry.
// MenuBar's File menu shows on click of the "File" text. Simpler :
// trigger the dialog directly via the same path the menu uses —
// set scaffoldOpen on the window-exposed App state, or click the
// menu item.
// MenuBar's File dropdown uses daisyUI focus-to-open semantics
// which is fiddly to drive from puppeteer. The SPA exposes
// window.weftLoomScaffoldOpen() as the test-friendly path.
await page.evaluate(() => window.weftLoomScaffoldOpen());
await new Promise((r) => setTimeout(r, 300));
const opened = await page.evaluate(() => !!document.querySelector('[data-testid="scaffold-dialog"]'));
if (opened) {
  ok('SPA opens the scaffold dialog');
} else {
  failL('SPA opens the scaffold dialog', 'no [data-testid=scaffold-dialog]');
}
// Pick the marp-deck template + Apply.
if (opened) {
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-testid="scaffold-item"]'));
    const marp = items.find((el) => el.getAttribute('data-id') === 'marp-deck');
    marp?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => (document.querySelector('[data-testid="scaffold-apply"]')).click());
  await new Promise((r) => setTimeout(r, 1500));
  const slidesPresent = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent('slides.md'))
    .then((r) => r.ok);
  if (slidesPresent) {
    ok('Apply seeds marp template files', 'slides.md on disk');
  } else {
    failL('Apply seeds marp template files', 'slides.md not found');
  }
}

await br.close();
// Final cleanup
for (const f of ['main.tex', 'figures/.gitkeep', 'slides.md']) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(f), { method: 'DELETE' }).catch(() => {});
}

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
