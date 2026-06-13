// rtf-fields.mjs — T10 V0.3 : RTF field round-trip.
//
//   1. Seed a .rtf with {\field{\*\fldinst PAGE}{\fldrslt 1}} +
//      {\field{\*\fldinst DOCPROPERTY "ClientName"}{\fldrslt Acme}}.
//   2. Open in the WYSIWYG ; assert the fields surface as
//      <span class="rtf-field" data-kind="page"|"docproperty" ...>.
//   3. Inject a fresh editor-side field span ; trigger save ;
//      assert the saved bytes carry a \field group for it.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'rtf-fields-' + Date.now() + '.rtf';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom RTF fields suite\x1b[0m');

const body =
  '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil Helvetica;}}\\f0\\fs24 ' +
  'Page {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}} of ' +
  '{\\field{\\*\\fldinst NUMPAGES}{\\fldrslt 1}}, client : ' +
  '{\\field{\\*\\fldinst DOCPROPERTY "ClientName"}{\\fldrslt Acme}}.\\par' +
  '}';
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body });
ok('seed', PATH);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 4000));

const fields = await page.evaluate(() => {
  const ce = document.querySelector('[contenteditable="true"][role="textbox"]');
  const spans = Array.from(ce?.querySelectorAll('span.rtf-field') ?? []);
  return spans.map(s => ({
    kind: s.getAttribute('data-kind'),
    name: s.getAttribute('data-name'),
    text: s.textContent ?? '',
  }));
});
const kinds = fields.map(f => f.kind);
if (kinds.includes('page') && kinds.includes('numpages') && kinds.includes('docproperty')) {
  ok('field read', '3 fields surfaced (PAGE / NUMPAGES / DOCPROPERTY)');
} else {
  failL('field read', JSON.stringify(fields));
}
const docPropField = fields.find(f => f.kind === 'docproperty');
if (docPropField && docPropField.name === 'ClientName' && docPropField.text === 'Acme') {
  ok('docproperty name+value', 'data-name=ClientName, text="Acme"');
} else {
  failL('docproperty name+value', JSON.stringify(docPropField));
}

// Editor-side : add a TITLE field via direct DOM insertion + save.
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
  document.execCommand('insertText', false, ' Title : ');
  const span = document.createElement('span');
  span.className = 'rtf-field';
  span.setAttribute('data-kind', 'title');
  span.textContent = 'Editor doc';
  range.insertNode(span);
  ce.dispatchEvent(new InputEvent('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 2000));

const saved = await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH));
const text = await saved.text();
if (text.includes('\\field') && text.includes('PAGE') && text.includes('DOCPROPERTY')) {
  ok('field write-back', 'PAGE + DOCPROPERTY survived round-trip');
} else {
  failL('field write-back', 'snippet : ' + text.slice(0, 300));
}
if (text.includes('TITLE') && text.includes('Editor doc')) {
  ok('editor-added field', 'TITLE + Editor doc landed in saved RTF');
} else {
  failL('editor-added field', 'expected TITLE field + Editor doc in saved bytes');
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
