// theme-preview.mjs — asserts each institutional Marp theme renders
// a distinguishable preview card (per-brand border colour at minimum).
//
// History : 2026-06-12, user reported "le changement des themes n'ont
// pas trop l'air d'etre fonctionels ou alors ils sont vides" — visual
// signal that the catalogue + style strings landed in marp.ts but
// the renderMarkdown wrapper either didn't apply them, or the file
// content was empty. This test seeds a non-empty slide deck per
// theme and asserts the wrapper carries the expected border colour
// (which mirrors the brand signature in MARP_THEMES).

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';

const THEMES = [
  // id        expected border-color substring
  { id: 'polytechnique', expect: '1, 66, 106' },        // #01426A as rgb
  { id: 'ip-paris',      expect: '0, 139, 210' },       // #008BD2
  { id: 'cnrs',          expect: '6, 96, 255' },        // #0660FF
  { id: 'dinum',         expect: '0, 0, 145' },         // #000091
  { id: 'paris-saclay',  expect: '98, 0, 60' },         // #62003C
  { id: 'ihes',          expect: '28, 82, 138' },       // #1C528A
];

let passed = 0, failed = 0;
function ok(t, m) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom institutional theme preview suite\x1b[0m');

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();

for (const t of THEMES) {
  const path = `theme-preview-${t.id}.md`;
  const body = `---\nmarp: true\ntheme: ${t.id}\n---\n\n# Brand check : ${t.id}\n\nNon-empty body so renderMarkdown emits a card.\n`;
  const r = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(path),
    { method: 'PUT', body });
  if (r.status !== 200 && r.status !== 204) {
    failL(t.id + ' : seed', 'HTTP ' + r.status);
    continue;
  }
}
// One reload after seeding so the file explorer picks up all fixtures.
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

for (const t of THEMES) {
  const path = `theme-preview-${t.id}.md`;
  const opened = await page.evaluate((p) => {
    const fn = window.weftLoomOpenFile;
    if (typeof fn === 'function') { fn(p); return true; }
    return false;
  }, path);
  if (!opened) {
    failL(t.id + ' : open', 'window.weftLoomOpenFile missing');
    continue;
  }
  await new Promise((r) => setTimeout(r, 1500));

  // Read the first slide card's computed style — the wrapper carries
  // a `style="...;border-color:#…"` inline attribute we set in
  // renderMarkdown ; the computed style of that border-color must
  // match the brand signature.
  const got = await page.evaluate(() => {
    // The slide card lives under the right preview pane ; locate it
    // by the inline-style aspect-ratio token we set per slide.
    const cards = Array.from(document.querySelectorAll('div[style*="aspect-ratio"]'));
    if (!cards.length) return { count: 0 };
    const c = cards[0];
    const cs = getComputedStyle(c);
    return {
      count: cards.length,
      borderColor: cs.borderTopColor || cs.borderColor || '',
      backgroundColor: cs.backgroundColor || '',
      inlineStyle: c.getAttribute('style') || '',
      textPreview: (c.textContent || '').slice(0, 80),
    };
  });
  if (!got.count) {
    failL(t.id + ' : preview card', 'no slide card rendered (empty preview)');
    continue;
  }
  if (!got.textPreview.includes('Brand check')) {
    failL(t.id + ' : preview card content', 'card text missing : "' + got.textPreview + '"');
    continue;
  }
  // border-color comparison : computed style returns rgb(...) ;
  // match against the expected rgb triple substring.
  const bc = got.borderColor.replace(/\s+/g, '').replace(/rgb\(|\)/g, '');
  const wanted = t.expect.replace(/\s+/g, '');
  if (!bc.includes(wanted)) {
    failL(t.id + ' : brand border-color',
      'expected rgb≈' + t.expect + ' but got ' + got.borderColor);
    continue;
  }
  ok(t.id + ' : preview renders + brand border applied',
    '(' + got.count + ' slide(s), border=' + got.borderColor + ')');
}

// Cleanup
for (const t of THEMES) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent('theme-preview-' + t.id + '.md'),
    { method: 'DELETE' }).catch(() => {});
}
await browser.close();

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
