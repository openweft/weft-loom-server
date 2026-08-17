// changelog-persist.mjs — the track-changes log outlives the page.
//
// It replaces wysiwyg-authorship.mjs, which pinned five contracts against a
// Y.Doc it made itself. Four of those were about a module's own bookkeeping and
// are pinned by the type-checker now; the fifth was convergence between two
// clients, which is here as two tabs.
//
// What the old test could not check is the thing that was asked for: the log is
// per project and it is persistent. Its Y.Doc lived as long as somebody had the
// file open, so "reload the page" was not a question it could put. This asks it:
// edit, see the record, reload with nothing left in the tab, and the record is
// still there — because the list part is on the server's disk.
//
// Needs a server on :8080 with a project called demo.
import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const F = 'changelog-' + Date.now() + '.tex';
const SEED = '\\documentclass{article}\n\\begin{document}\nInitial body text.\n\\end{document}\n';

await fetch(ROOT + '/api/projects/demo/files/' + encodeURIComponent(F), {
  method: 'PUT',
  headers: { 'Content-Type': 'text/plain' },
  body: SEED,
});

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

// open lands a tab on the file in WYSIWYG mode, which is the only surface the
// change log exists for.
const open = async () => {
  const p = await br.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2000));
  await p.evaluate(() => localStorage.setItem('weft-loom-tex-wysiwyg', 'wysiwyg'));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));
  await p.evaluate((path) => window.weftLoomOpenFile(path), F);
  await p.waitForSelector('[data-testid="latex-wysiwyg-surface"]', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 4000));
  return p;
};

// edit appends to the body and fires the input event, which is what runs
// pushToYtext and therefore what records a change.
const edit = (p, mark) =>
  p.evaluate((m) => {
    const surf = document.querySelector('[data-testid="latex-wysiwyg-surface"]');
    const para = surf?.querySelector('p');
    if (!para) throw new Error('no paragraph to edit');
    para.textContent = (para.textContent ?? '') + ' ' + m;
    surf.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, mark);

// records reads the panel. The panel is opened from the editor's own control,
// so this also proves the two are still wired to each other.
// Every click here goes through the DOM rather than puppeteer's click, which
// waits on a scroll that never settles on this page — the same reason
// converge.mjs types through a hook instead of into CodeMirror.
const clickIt = (p, selector) =>
  p.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('nothing matching ' + sel);
    el.click();
  }, selector);

const records = async (p) => {
  const shown = await p.$('[data-testid="track-changes-panel"]');
  if (!shown) {
    // The editor's own control. It renders the panel only when the log
    // attached, so a session that never joined shows up here as no panel
    // rather than as an empty one.
    await clickIt(p, 'button[aria-label="Track changes"]');
    await new Promise((r) => setTimeout(r, 800));
  }
  return p.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="track-changes-row"]')).map((row) => ({
      author: row.querySelector('.font-semibold')?.textContent?.trim() ?? '',
      // The whole diff, because a record holds the file's source before and
      // after — so the edit that made it is at the end, not in the first line.
      diff: row.querySelector('[data-testid="track-changes-diff"]')?.textContent ?? '',
    })),
  );
};

const fail = (what) => {
  console.log('FAIL ' + what);
  process.exitCode = 1;
};

const a = await open();
const b = await open();

console.log('log before any edit:', JSON.stringify(await records(a)));

await edit(a, 'MARK-A');
await new Promise((r) => setTimeout(r, 3000));

const seenByA = await records(a);
const seenByB = await records(b);
const brief = (rs) => rs.map((r) => ({ author: r.author, marked: r.diff.includes('MARK-A') }));
console.log('a typed, a sees   :', JSON.stringify(brief(seenByA)));
console.log('a typed, b sees   :', JSON.stringify(brief(seenByB)));
if (seenByA.length !== 1) fail('the tab that typed does not list one change');
if (seenByB.length !== 1) fail('the other tab was not told about the change');

// Both tabs go. Nothing is left holding the document, which is what makes the
// next line a question about the server rather than about a cache.
await a.close();
await b.close();
await new Promise((r) => setTimeout(r, 8000));

const c = await open();
const afterReload = await records(c);
console.log('after both tabs closed and a new one opened:', JSON.stringify(brief(afterReload)));
if (afterReload.length !== 1) fail('the change log did not survive the page');
if (afterReload.length === 1 && !afterReload[0].diff.includes('MARK-A')) {
  fail('the surviving record is not the one that was made');
}

// And accepting it takes it away, on the server too.
const accept = await c.$('[data-testid="track-changes-accept"]');
if (!accept) fail('no accept control');
else {
  await clickIt(c, '[data-testid="track-changes-accept"]');
  await new Promise((r) => setTimeout(r, 2500));
  const left = await records(c);
  console.log('after accept:', JSON.stringify(brief(left)));
  if (left.length !== 0) fail('accepting did not drop the record');
}

await br.close();
if (!process.exitCode) console.log('OK the change log is per project and persistent');
