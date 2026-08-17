// converge.mjs — two tabs on one file, and what one types the other sees.
//
// This is what the editor is for, so it is the check the go-crdt migration has
// to keep passing: it is the difference between "the editor still renders" and
// "the editor still collaborates", and only the second one matters.
//
// It types through window.weftLoomInsertAtCursor rather than clicking into
// CodeMirror, because a puppeteer click waits on a scroll that never settles
// here — the hook is what the other tests use for the same reason.
//
// Needs a server on :8080 with a project called demo, which is what
// `weft-loom serve --config` gives with no auth configured.
import puppeteer from 'puppeteer';
const ROOT = 'http://127.0.0.1:8080';
const PATH = 'converge-' + Date.now() + '.tex';
await fetch(ROOT + '/api/projects/demo/files/' + encodeURIComponent(PATH), {
  method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'seed\n',
});
const browser = await puppeteer.launch({ headless: 'new' });
const open = async () => {
  const p = await browser.newPage();
  await p.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));
  await p.evaluate((f) => window.weftLoomOpenFile(f), PATH);
  await p.waitForSelector('.cm-content', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2500));
  return p;
};
const a = await open();
const b = await open();
const read = (p) => p.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '');
console.log('a before:', JSON.stringify(await read(a)));
console.log('b before:', JSON.stringify(await read(b)));
// The editor exposes an insert hook for exactly this: clicking into
// CodeMirror from puppeteer waits on a scroll that never settles.
await a.evaluate(() => window.weftLoomInsertAtCursor('BONJOUR'));
await new Promise((r) => setTimeout(r, 3000));
const av = await read(a), bv = await read(b);
console.log('a after :', JSON.stringify(av));
console.log('b after :', JSON.stringify(bv));
const typed = av.includes('BONJOUR');
const converged = bv.includes('BONJOUR');
console.log(typed ? '  \x1b[32m✓\x1b[0m typed' : '  \x1b[31m✕\x1b[0m the edit never reached the editor');
console.log(converged ? '  \x1b[32m✓\x1b[0m converged' : '  \x1b[31m✕\x1b[0m the other tab never saw it');
await fetch(ROOT + '/api/projects/demo/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});
await browser.close();
process.exit(typed && converged ? 0 : 1);
