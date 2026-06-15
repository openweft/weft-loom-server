// doi-import.mjs — V0.11 DOI → BibTeX import.
//
// Server side : POST /api/projects/{name}/bib/from-doi resolves the
// DOI via doi.org content negotiation + appends to refs.bib. Test
// runs with WEFT_LOOM_DOI_STUB=1 so the resolver returns a
// deterministic stub entry instead of hitting the public internet.
//
// Assertions :
//   1. POST with a bare DOI returns 200 + the stub entry
//   2. The entry is appended to refs.bib (created if missing)
//   3. POST with an invalid DOI returns 400 + an error message
//   4. POST with a doi.org URL is normalised + accepted
//   5. SPA "+ DOI" affordance opens an inline form and the result
//      is rendered visibly after the fetch

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const STAMP = Date.now();

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom DOI import suite\x1b[0m');

// Defensive : remove any refs.bib from a prior interrupted run so
// duplicate citation keys don't trip svelte's {#each as e (e.key)}
// guard ("each_key_duplicate" runtime error).
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent('refs.bib'), { method: 'DELETE' }).catch(() => {});

// Confirm the server is running with WEFT_LOOM_DOI_STUB=1 in its
// environment — if not, this test would try to hit doi.org which
// is flaky in CI. The handler returns 502 if the upstream fails so
// we'd still get a clean fail, but the stub path is preferred.
// (The runner.sh restart in run.sh propagates env when set.)

// (1) Bare DOI
const r1 = await fetch(ROOT + '/api/projects/' + PROJECT + '/bib/from-doi', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ doi: '10.1145/3676146' }),
});
if (r1.ok) {
  const data = await r1.json();
  if (typeof data.entry === 'string' && data.entry.startsWith('@')) {
    ok('bare DOI returns BibTeX entry', '@' + data.entry.split('{')[0].slice(1) + ' …');
  } else {
    failL('bare DOI returns BibTeX entry', JSON.stringify(data).slice(0, 120));
  }
  if (data.target && data.target.endsWith('.bib')) {
    ok('target .bib reported', data.target);
  } else {
    failL('target .bib reported', JSON.stringify(data));
  }
} else {
  failL('bare DOI HTTP ok', 'HTTP ' + r1.status);
}

// (2) Subsequent fetch should hit the (now-existing) refs.bib and
// confirm the stub entry was appended.
const listResp = await fetch(ROOT + '/api/projects/' + PROJECT + '/files');
const files = (await listResp.json()).items.map((f) => f.path);
if (files.includes('refs.bib')) {
  ok('refs.bib exists', 'on disk');
  const bibBody = await (await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent('refs.bib'))).text();
  if (bibBody.includes('10.1145/3676146')) {
    ok('refs.bib contains the imported DOI', bibBody.length + ' bytes');
  } else {
    failL('refs.bib contains the imported DOI', bibBody.slice(0, 120));
  }
} else {
  failL('refs.bib exists', 'not in ListFiles : ' + files.filter(f => f.endsWith('.bib')).join(','));
}

// (3) Invalid DOI : 400 + error message
const r3 = await fetch(ROOT + '/api/projects/' + PROJECT + '/bib/from-doi', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ doi: 'not-a-doi' }),
});
if (r3.status === 400) {
  const e = await r3.json();
  if ((e.error ?? '').includes('doi')) {
    ok('invalid DOI returns 400 + error', e.error);
  } else {
    failL('invalid DOI returns 400 + error', JSON.stringify(e));
  }
} else {
  failL('invalid DOI returns 400 + error', 'HTTP ' + r3.status);
}

// (4) doi.org URL form
const r4 = await fetch(ROOT + '/api/projects/' + PROJECT + '/bib/from-doi', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ doi: 'https://doi.org/10.1109/5.771073' }),
});
if (r4.ok) {
  const d = await r4.json();
  if (d.entry?.includes('10.1109/5.771073')) {
    ok('doi.org URL accepted + normalised', 'second entry');
  } else {
    failL('doi.org URL accepted + normalised', JSON.stringify(d).slice(0, 120));
  }
} else {
  failL('doi.org URL accepted + normalised', 'HTTP ' + r4.status);
}

// (5) SPA affordance : "+ DOI" button + form + result rendering.
// Need a .tex file so the BibliographyPanel becomes visible
// (it gates on `language === 'latex'`).
const TEX_FILE = 'doi-test-' + STAMP + '.tex';
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(TEX_FILE), {
  method: 'PUT', body: '\\documentclass{article}\n\\begin{document}\nDOI test.\n\\end{document}\n',
});
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await br.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate((p) => window.weftLoomOpenFile(p), TEX_FILE);
await new Promise((r) => setTimeout(r, 3500));
// Open the bibliography panel via its FAB. Use waitForSelector so
// a slow editor mount doesn't race the click ; the FAB only renders
// once the language settles to 'latex'.
await page.waitForSelector('[data-testid="bib-toggle"]', { timeout: 5000 });
// Use a programmatic .click() (fires the click event directly) so a
// stacked-FAB cluster (CommentsPanel + WordCountPanel + LatexSymbolPalette
// also live on the right edge of the editor) doesn't intercept the
// coordinate-based hit test.
await page.evaluate(() => (document.querySelector('[data-testid="bib-toggle"]')).click());
await page.waitForSelector('[data-testid="bib-doi-open"]', { timeout: 5000 });
await page.evaluate(() => (document.querySelector('[data-testid="bib-doi-open"]')).click());
try {
  await page.waitForSelector('[data-testid="bib-doi-panel"]', { timeout: 3000 });
  ok('+ DOI button opens import form');
} catch {
  failL('+ DOI button opens import form', 'no [data-testid=bib-doi-panel] after 3s wait');
  // Skip the rest — without the panel the input can't be filled.
  await br.close();
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(TEX_FILE), { method: 'DELETE' }).catch(() => {});
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent('refs.bib'), { method: 'DELETE' }).catch(() => {});
  console.log('');
  console.log('\x1b[31m' + passed + '/' + (passed + failed) + ' passed\x1b[0m');
  process.exit(1);
}
// Type a DOI + click Fetch
await page.evaluate(() => {
  const input = document.querySelector('[data-testid="bib-doi-input"]');
  if (!input) return;
  input.value = '10.1038/nature12373';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => (document.querySelector('[data-testid="bib-doi-fetch"]')).click());
try {
  await page.waitForSelector('[data-testid="bib-doi-success"]', { timeout: 4000 });
  const okBanner = await page.evaluate(() =>
    document.querySelector('[data-testid="bib-doi-success"]')?.textContent?.trim());
  if (okBanner && okBanner.includes('refs.bib')) {
    ok('SPA renders success banner', okBanner);
  } else {
    failL('SPA renders success banner', JSON.stringify(okBanner));
  }
} catch {
  failL('SPA renders success banner', 'no [data-testid=bib-doi-success] after 4s');
}
await br.close();

// Cleanup
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(TEX_FILE), { method: 'DELETE' }).catch(() => {});
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent('refs.bib'), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
