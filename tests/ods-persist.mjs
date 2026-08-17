// ods-persist.mjs — a workbook's live state outlives every tab, and is seeded
// once rather than once per session.
//
// The Yjs spreadsheet could not do this, and the code said so: a whole
// seeder-election protocol existed — a server claim, a lowest-clientID
// fallback, a 500 ms wait for awareness to settle — because a Y.Doc is empty
// whenever the relay holds nothing, so somebody had to be picked to refill it
// from disk on every first join.
//
// So the check is not "did the port keep working" (ods-templates-collab already
// asks that). It is: close everything, come back, and the edit made in the last
// session is still in the document — which is what says the election is gone
// because it is not needed rather than because it was dropped.
//
// Needs a server on :8080 with a project called demo.
import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const F = 'persist-' + Date.now() + '.ods';

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

// The blank template written through the page's own ODS writer, which is how
// ods-templates-collab makes one: a real workbook rather than a fixture.
{
  const maker = await br.newPage();
  await maker.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));
  const made = await maker.evaluate(async ({ root, name }) => {
    const w = window;
    const tpl = w.weftLoomTemplates?.findTemplate('ods-blank');
    if (!tpl?.odsSheets) return { ok: false, why: 'no ods-blank template' };
    // Two sheets, because the sheet tabs only render past one — and because
    // the shape is the structure a double seed used to damage.
    const one = tpl.odsSheets();
    const sheets = [
      { ...one[0], name: 'First' },
      { ...JSON.parse(JSON.stringify(one[0])), name: 'Second' },
    ];
    const bytes = await w.weftLoomWriteODS(sheets, new Date().toISOString());
    const r = await fetch(root + '/api/projects/demo/files/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/vnd.oasis.opendocument.spreadsheet' },
      body: new Blob([bytes]),
    });
    return { ok: r.ok, status: r.status };
  }, { root: ROOT, name: F });
  if (!made.ok) {
    console.log('FAIL could not make a workbook:', JSON.stringify(made));
    process.exit(1);
  }
  await maker.close();
}

const open = async () => {
  const p = await br.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2000));
  await p.evaluate((path) => window.weftLoomOpenFile(path), F);
  await p.waitForSelector('[data-cell="0,0"]', { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 4000));
  return p;
};

// The grid's own editing path, which is how ods-templates-collab drives it.
const typeInto = async (p, cell, text) => {
  await p.evaluate(
    ({ at, value }) => {
      const el = document.querySelector(`[data-cell="${at}"]`);
      if (!el) throw new Error('no cell at ' + at);
      el.click();
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    },
    { at: cell, value: text },
  );
  await new Promise((r) => setTimeout(r, 2000));
};

const readCell = (p, cell) =>
  p.evaluate((at) => document.querySelector(`[data-cell="${at}"]`)?.textContent?.trim() ?? null, cell);

const sheetTabs = (p) =>
  p.evaluate(() => document.querySelectorAll('[data-testid="ods-sheet-tab"]').length);

const fail = (what) => {
  console.log('FAIL ' + what);
  process.exitCode = 1;
};

// Both tabs at once, on a document nobody has ever opened. Each finds it
// empty and each seeds it — which is precisely what the election existed to
// stop, and what the shape keying now has to survive on its own.
const [a, b0] = await Promise.all([open(), open()]);
console.log('two tabs seeded together, sheet tabs:', await sheetTabs(a), 'and', await sheetTabs(b0));
if ((await sheetTabs(a)) !== 2) fail('a simultaneous seed changed the sheet count');
await b0.close();
await new Promise((r) => setTimeout(r, 1500));

await typeInto(a, '0,0', 'PERSISTED');
console.log('the tab that typed reads:', JSON.stringify(await readCell(a, '0,0')));

const b = await open();
const seenByB = await readCell(b, '0,0');
console.log('a second tab reads      :', JSON.stringify(seenByB));
if (seenByB !== 'PERSISTED') fail('a second tab did not see the edit');

// Everything goes. Nothing is left holding the document.
await a.close();
await b.close();
await new Promise((r) => setTimeout(r, 8000));

const c = await open();
const afterAll = await readCell(c, '0,0');
console.log('after every tab closed  :', JSON.stringify(afterAll));
if (afterAll !== 'PERSISTED') fail('the workbook did not keep its live state');

// And it still has the two sheets it was made with, after everything above.
const tabs = await sheetTabs(c);
console.log('sheet tabs              :', tabs);
if (tabs !== 2) fail('the workbook does not have the sheets it was made with');

await br.close();
if (!process.exitCode) console.log('OK the workbook keeps its live state with nobody holding it');
