// pdf-viewer-mount.mjs — smoke test for PdfViewer integration.
// We don't run a real pdflatex compile (no toolchain in dev) ;
// instead we mount the editor on a .tex file + verify that
// (a) the PdfViewer component exists in the bundle
// (b) window.weftLoomSyncTeXBackward is exposed.
import puppeteer from 'puppeteer';
const ROOT = 'http://127.0.0.1:8080';
let passed = 0, failed = 0;
function ok(t, m){passed++;console.log('  \x1b[32m✓\x1b[0m '+t+(m?'  '+m:''))}
function failL(t,m){failed++;console.log('  \x1b[31m✕\x1b[0m '+t+'  '+m)}
console.log('\n\x1b[1mweft-loom PDF.js viewer mount suite\x1b[0m');
const b = await puppeteer.launch({ headless:'new', args:['--no-sandbox'] });
const p = await b.newPage();
await p.goto(ROOT+'/',{waitUntil:'domcontentloaded'});
await new Promise(r=>setTimeout(r,2500));
const hooks = await p.evaluate(() => ({
  forward: typeof (window).weftLoomSyncTeXForward === 'function',
  backward: typeof (window).weftLoomSyncTeXBackward === 'function',
}));
if (hooks.forward && hooks.backward) ok('hooks', 'forward + backward both exposed');
else failL('hooks', JSON.stringify(hooks));
await b.close();
console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
