// map-write-cost.mjs — what it costs to seed a spreadsheet.
//
// The ODS editor keeps its cells in a Y.Map keyed "<sheet>:<row>:<col>" and
// seeds the whole sheet in one ydoc.transact — ten thousand cells in one go.
// collab's map part sets one key per call and each call returns a promise, so
// before deciding it needs a batched write, this measures the one it has.
//
// It runs in the page, through globalThis.collab and nothing else, because the
// cost being measured is the cost of crossing into wasm — which is exactly what
// a node-side benchmark of the Go implementation would not see.
import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const p = await br.newPage();
p.on('pageerror', (e) => console.log('page error:', e.message));
await p.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
// The page installs the binding on load; the editor is not needed for this.
await p.waitForFunction(() => !!globalThis.collab, { timeout: 30000 });

const run = async (cells) =>
  p.evaluate(async (n) => {
    const ws = location.origin.replace(/^http/, 'ws') + '/api/projects/demo/collab';
    // The server authorises by project, and a document names its project before
    // the colon — so this measures against the same authorisation the editor meets.
    const tag = 'demo:cost-' + n + '-' + Math.random().toString(36).slice(2);
    const session = await globalThis.collab.join({
      url: ws,
      document: tag,
      site: await globalThis.collab.deriveSite(tag),
    });
    const part = await session.map('cells');
    const enc = new TextEncoder();
    // A cell as the editor stores one: a value and enough formatting to be
    // representative of the bytes, not a bare number.
    const value = (i) => enc.encode(JSON.stringify({ v: i, f: '', s: { b: false, a: 'right' } }));

    // Serial: what a straightforward port would write.
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await part.set('0:' + ((i / 100) | 0) + ':' + (i % 100), value(i));
    const serial = performance.now() - t0;

    // Issued together: every set started before any is awaited. If the binding
    // is per-call overhead this is much faster; if it is per-operation work it
    // is the same, and that is what says whether a batched write would help.
    const t1 = performance.now();
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        part.set('1:' + ((i / 100) | 0) + ':' + (i % 100), value(i)),
      ),
    );
    const together = performance.now() - t1;

    const keys = part.keys().length;
    await session.close();
    return { serial: Math.round(serial), together: Math.round(together), keys };
  }, cells);

for (const n of [1000, 10000]) {
  const r = await run(n);
  console.log(
    `${n} cells: serial ${r.serial} ms (${(r.serial / n).toFixed(3)} ms/cell), ` +
      `issued together ${r.together} ms (${(r.together / n).toFixed(3)} ms/cell), ` +
      `keys after ${r.keys}`,
  );
}

await br.close();
