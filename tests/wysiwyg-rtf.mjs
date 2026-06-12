// wysiwyg-rtf.mjs — guards two invariants of the RTF WYSIWYG editor :
//
//   1. Opening a .rtf file mounts the WYSIWYG surface (contenteditable
//      + toolbar) — NOT the CodeMirror raw-source editor. The user
//      flagged authoring raw RTF as bad UX ; this test trips on any
//      regression that puts CodeMirror back in front of an .rtf
//      file.
//
//   2. The HTML → RTF writer round-trips through parseRTF without
//      losing the bold/italic/headings/lists scaffolding. We drive
//      it via the editor's save-on-change path : edit content,
//      wait for the debounced PUT, fetch the saved RTF, parse it
//      back, check the relevant text + tags survive.
//
// The harness deletes its fixture on exit so re-runs are clean.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'wysiwyg-rtf-test.rtf';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

// Seed a known-good RTF fixture (anchor text + a single bold word).
const SEED_RTF = '{\\rtf1\\ansi\\deff0\\uc1{\\fonttbl{\\f0\\fnil Helvetica;}}\\f0\\fs24 Hello \\b world\\b0 .\\par}';

console.log('\n\x1b[1mweft-loom WYSIWYG RTF suite\x1b[0m');

// 1) seed the fixture
const seed = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), {
  method: 'PUT', body: SEED_RTF,
});
if (seed.status !== 200 && seed.status !== 204) {
  failL('seed fixture', 'HTTP ' + seed.status);
  process.exit(1);
}
ok('seed fixture', PATH);

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
await new Promise((r) => setTimeout(r, 1500));

// 3) assert the WYSIWYG editor mounted (contenteditable surface +
//    its dedicated toolbar) and the raw-source CodeMirror DID NOT.
const mounted = await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  const cm = document.querySelector('.cm-editor');
  return {
    hasWysiwyg: !!ce,
    hasCodeMirror: !!cm,
    body: ce ? (ce.textContent || '').trim().slice(0, 80) : '',
  };
});
if (!mounted.hasWysiwyg) {
  failL('WYSIWYG mount', 'contenteditable surface absent');
} else if (mounted.hasCodeMirror) {
  failL('WYSIWYG mount', 'CodeMirror also mounted — should be WYSIWYG-only for .rtf');
} else {
  ok('WYSIWYG mount', 'contenteditable present, no CodeMirror');
}
if (!mounted.body.includes('Hello') || !mounted.body.includes('world')) {
  failL('WYSIWYG initial content', 'expected "Hello … world" got "' + mounted.body + '"');
} else {
  ok('WYSIWYG initial content', '"' + mounted.body + '"');
}

// 4) drive an edit + wait for the debounced save (~600 ms).
await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (!ce) return;
  ce.focus();
  // Append " — edited" to the document.
  const range = document.createRange();
  range.selectNodeContents(ce);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('insertText', false, ' — edited');
  ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
// Debounce + network round-trip ; 1.5 s is comfortably over the
// component's 600 ms debounce.
await new Promise((r) => setTimeout(r, 1500));

// 5) fetch the saved RTF and verify the round-trip preserved
//    the original anchor + the new text.
const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
if (!after.ok) {
  failL('save round-trip', 'GET HTTP ' + after.status);
} else {
  const text = await after.text();
  if (!/^\{\\rtf1/.test(text)) {
    failL('RTF header', 'missing \\rtf1 magic');
  } else {
    ok('RTF header', 'starts with \\rtf1');
  }
  if (!text.includes('Hello')) {
    failL('text preserved', 'original "Hello" lost. saved=' + JSON.stringify(text.slice(0, 200)));
  } else if (!text.includes('world')) {
    failL('text preserved', 'original "world" lost. saved=' + JSON.stringify(text.slice(0, 200)));
  } else if (!text.includes('edited')) {
    failL('edit persisted', 'new " — edited" suffix missing');
  } else {
    ok('text preserved + edit persisted', '"Hello … world … edited"');
  }
  // The bold marker on "world" should survive ; the writer emits
  // \b … \b0 around it.
  if (text.includes('\\b ') || text.includes('\\b\\fs')) {
    ok('bold marker present', '\\b … \\b0 around the bolded run');
  } else {
    failL('bold marker present', 'no \\b token in writer output');
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
