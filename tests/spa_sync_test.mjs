// spa_sync_test.mjs — drives 2 headless Chromium instances on the
// real loom SPA + checks that typing in one window propagates to
// the other. End-to-end : real CodeMirror + real binding + real WS.
//
// Run :  node tests/spa_sync_test.mjs

import puppeteer from 'puppeteer';

const URL = process.env.LOOM_URL ?? 'http://127.0.0.1:8080';
// Fresh project per run so the y-websocket relay's in-memory room
// state doesn't accumulate "HELLO" and "WORLD" inserts from prior
// runs (they'd show up as "WORLDHELLOWORLDHELLO…" instead of
// "WORLDHELLO…").
const PROJECT = 'spatest-' + Date.now();
const FILE = 'main.tex';

function pass(s) { console.log(`✅ ${s}`); }
function fail(s) { console.error(`❌ ${s}`); process.exitCode = 1; }

async function openClient(browser, name) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'log') {
      const text = msg.text();
      if (text.startsWith('[ydoc.update]') || text.startsWith('[__weftDebug]') || text.startsWith('[seed]') || text.startsWith('[ybinding') || text.startsWith('[Editor]')) {
        console.log(`[${name}] ${text}`);
      }
    }
  });
  await page.goto(URL + '?project=' + encodeURIComponent(PROJECT), { waitUntil: 'networkidle2' });
  // Open the demo project main.tex by clicking through the SPA UI.
  await page.waitForSelector('aside', { timeout: 10000 });
  // Click the file in the sidebar.
  const opened = await page.evaluate(({ file }) => {
    // The FileExplorer is the LEFT sidebar — first <aside> with a
    // "Files" header. Multiple <aside>s now exist (Collaborators,
    // Chat) so be specific. Match any button whose monospace span
    // text includes the file name.
    const allButtons = Array.from(document.querySelectorAll('button'));
    const target = allButtons.find((b) => {
      const span = b.querySelector('span.font-mono');
      return span?.textContent?.includes(file);
    });
    if (!target) return false;
    target.click();
    return true;
  }, { file: FILE });
  if (!opened) throw new Error(`could not click ${FILE} in sidebar`);
  // Wait for the CodeMirror view + Y.Text to be initialised.
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  // Poll for seed completion. The Editor's seedFromDisk runs 500 ms
  // after the y-websocket sync event ; the seed-claim POST adds
  // another network round-trip on top. 5 s is generous but matches
  // the seedFromDisk's own 2 s offline-fallback deadline + buffer.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const len = await page.evaluate(
      () => (document.querySelector('.cm-content')?.textContent ?? '').length,
    );
    if (len > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return page;
}

async function readEditorText(page) {
  return page.evaluate(() => {
    const cm = document.querySelector('.cm-content');
    return cm?.textContent ?? '';
  });
}

async function typeAt(page, text) {
  // Focus the editor + send keystrokes one at a time so each is a
  // distinct CodeMirror transaction (matching how a real user types).
  await page.evaluate(() => {
    const cm = document.querySelector('.cm-content');
    cm?.focus();
  });
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 50 });
  }
}

async function main() {
  console.log(`▶ SPA sync test — ${URL} project=${PROJECT}`);
  // Seed the project file via the REST API so the SPA has something
  // to load. Unique-per-run project ensures we aren't reading the
  // accumulated state of an earlier run.
  await fetch(`${URL}/api/projects/${PROJECT}/files/${FILE}`, {
    method: 'PUT',
    body: '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
  });
  // The SPA opens whatever ProjectSwitcher's default is ; we drive
  // it directly to the test project by passing ?project=... in the
  // URL hash so App.svelte's URL parser picks it up. If the SPA
  // doesn't support that today, fall back to clicking the
  // ProjectSwitcher.
  const browserA = await puppeteer.launch({ headless: 'new' });
  const browserB = await puppeteer.launch({ headless: 'new' });
  try {
    const pageA = await openClient(browserA, 'A');
    const pageB = await openClient(browserB, 'B');

    // DEBUG : count .cm-content and .cm-editor elements
    const debug = await pageA.evaluate(() => ({
      cmContents: document.querySelectorAll('.cm-content').length,
      cmEditors: document.querySelectorAll('.cm-editor').length,
      cmContentText: document.querySelector('.cm-content')?.textContent?.slice(0, 80) ?? null,
      cmEditorText: document.querySelector('.cm-editor')?.textContent?.slice(0, 80) ?? null,
    }));
    console.log('[A] DOM debug', JSON.stringify(debug));
    const aInitial = await readEditorText(pageA);
    const bInitial = await readEditorText(pageB);
    console.log(`[A] initial : "${aInitial.slice(0, 60)}..."`);
    console.log(`[B] initial : "${bInitial.slice(0, 60)}..."`);
    if (aInitial.length > 0 && bInitial.length > 0) pass('both clients loaded content');
    else fail(`initial load divergence : A=${aInitial.length}b B=${bInitial.length}b`);

    // A types "HELLO" — 5 keystrokes spaced 50ms.
    await typeAt(pageA, 'HELLO');
    await new Promise((r) => setTimeout(r, 1000));

    const aAfter = await readEditorText(pageA);
    const bAfter = await readEditorText(pageB);

    if (aAfter.includes('HELLO')) pass(`A self-shows "HELLO" : "${aAfter.slice(0, 40)}…"`);
    else fail(`A doesn't show HELLO : "${aAfter.slice(0, 40)}…"`);

    if (bAfter.includes('HELLO')) pass(`B received "HELLO" : "${bAfter.slice(0, 40)}…"`);
    else fail(`B did NOT receive HELLO : "${bAfter.slice(0, 40)}…" (A="${aAfter.slice(0, 40)}…")`);

    // Test sync convergence with multiple keystrokes from both sides.
    await typeAt(pageB, 'WORLD');
    await new Promise((r) => setTimeout(r, 1000));

    const aFinal = await readEditorText(pageA);
    const bFinal = await readEditorText(pageB);

    if (aFinal.includes('HELLO') && aFinal.includes('WORLD'))
      pass(`A sees both HELLO and WORLD : "${aFinal.slice(0, 60)}…"`);
    else
      fail(`A missing one : "${aFinal.slice(0, 60)}…"`);

    if (bFinal.includes('HELLO') && bFinal.includes('WORLD'))
      pass(`B sees both HELLO and WORLD : "${bFinal.slice(0, 60)}…"`);
    else
      fail(`B missing one : "${bFinal.slice(0, 60)}…"`);

    if (aFinal === bFinal) pass(`Convergence : both at "${aFinal.slice(0, 60)}…"`);
    else fail(`Divergence : A="${aFinal.slice(0, 60)}…" vs B="${bFinal.slice(0, 60)}…"`);
  } finally {
    await browserA.close();
    await browserB.close();
  }
  if (process.exitCode === 1) console.error('\n❌ some assertions failed');
  else console.log('\n✅ all assertions passed');
}

main().catch((e) => {
  console.error('crashed:', e);
  process.exit(2);
});
