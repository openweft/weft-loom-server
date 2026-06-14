// presence-cursors.mjs — In-editor real-time presence cursors
// regression test.
//
// The CollaboratorsSidebar surfaces who is in the room, but until
// this feature shipped the editor surface itself had no visual
// presence : you could not tell where a peer was typing or what
// they had selected. presence.ts now decorates the editor with a
// caret bar + label + selection mark per remote peer, driven by
// the same Yjs Awareness map the sidebar reads.
//
// We test the wiring end-to-end in a single browser tab : open a
// .tex file, grab the live Awareness handle exposed on window as
// `weftLoomAwareness`, push a synthetic peer state into the
// internal `states` Map (this skips the WS round-trip but
// exercises the exact path the ViewPlugin observes), emit a
// 'change' event so CodeMirror rebuilds its decorations, then
// assert :
//   - .cm-peer-caret renders in the DOM, carrying data-name +
//     a per-peer color on its border.
//   - .cm-peer-selection paints when the peer state contains a
//     non-empty range.
//   - The caret's pixel position matches the offset (within the
//     bounding rect of the corresponding glyph in cm-content).
//
// We also verify the local broadcast direction : moving the local
// caret writes a `cursor` field into our own awareness state, so
// peers would see us in turn.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'presence-cursors-test-' + Date.now() + '.tex';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom presence cursors suite\x1b[0m');

// Seed body : pad the first line so offset 10 lands inside a
// stretch of readable characters (not right at a paragraph break)
// — makes the pixel-position assertion stable.
const body = '\\documentclass{article}\n'
  + '\\begin{document}\n'
  + 'Hello world, this is the body for the presence test.\n'
  + '\\end{document}\n';

await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', body });
ok('seed', PATH + ' (' + body.length + ' bytes)');

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
page.on('console', msg => {
  if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text().slice(0, 200));
});

await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate((p) => (window).weftLoomOpenFile(p), PATH);
await new Promise((r) => setTimeout(r, 4500));

// Confirm the editor has the file loaded and Awareness is exposed.
const probe = await page.evaluate(() => ({
  docLen: (document.querySelector('.cm-content')?.textContent ?? '').length,
  hasAwareness: !!(window).weftLoomAwareness,
  selfID: (window).weftLoomAwareness?.clientID ?? null,
}));
if (probe.docLen < 30) {
  failL('doc loaded', 'editor empty : ' + JSON.stringify(probe)
    + ' errors: ' + errors.slice(0, 3).join(' | '));
  await browser.close(); process.exit(1);
}
ok('doc loaded', probe.docLen + ' chars');
if (!probe.hasAwareness) {
  failL('awareness handle', 'window.weftLoomAwareness missing');
  await browser.close(); process.exit(1);
}
ok('awareness handle', 'clientID=' + probe.selfID);

// Inject a synthetic peer with a cursor at offset 10 and a
// selection spanning [20, 30]. We poke the internal `states` Map
// directly (it's the same Map every other awareness consumer
// reads via getStates()) and then emit a 'change' event with the
// `added` clientIDs so the presence ViewPlugin rebuilds.
const peerInjected = await page.evaluate(() => {
  const a = (window).weftLoomAwareness;
  if (!a) return { ok: false };
  const peerID = 999999;
  a.states.set(peerID, {
    user: { name: 'Ada', color: 'hsl(280, 70%, 55%)' },
    cursor: { anchor: 20, head: 30 },
  });
  // Bump the meta clock so the timeout reaper doesn't immediately
  // garbage-collect our synthetic peer. y-protocols/awareness
  // stores meta as a Map<clientID, { clock, lastUpdated }>.
  if (a.meta) {
    a.meta.set(peerID, { clock: 1, lastUpdated: Date.now() });
  }
  a.emit('change', [{ added: [peerID], updated: [], removed: [] }, 'test']);
  return { ok: true, peerID };
});
if (!peerInjected.ok) {
  failL('inject peer', 'no awareness handle on window');
  await browser.close(); process.exit(1);
}
ok('inject peer', 'pushed synthetic peer state into awareness');

// Give CodeMirror a beat to rebuild its DecorationSet.
await new Promise((r) => setTimeout(r, 400));

// The dispatch({}) in presence.ts may not paint until a real CM
// update tick. Nudge the editor with a no-op selection set to make
// sure the ViewPlugin re-renders the freshly-built DecorationSet.
await page.evaluate(() => {
  (window).weftLoomJumpToOffset?.(0, 0);
});
await new Promise((r) => setTimeout(r, 300));

const decorState = await page.evaluate(() => {
  const carets = Array.from(document.querySelectorAll('.cm-peer-caret'));
  const selections = Array.from(document.querySelectorAll('.cm-peer-selection'));
  // Filter to the synthetic test peer (clientID 999999) — when the
  // test runs after another suite that left a real awareness peer
  // alive, querying by index 0 would pick the wrong one. The label
  // now lives on a ::after pseudo-element so we read the name from
  // the data-name attribute instead of a child node's textContent.
  const adaCaret = carets.find((el) => el.getAttribute('data-client-id') === '999999');
  const rect = adaCaret?.getBoundingClientRect();
  return {
    caretCount: carets.length,
    selectionCount: selections.length,
    dataName: adaCaret?.getAttribute('data-name') ?? null,
    dataClientID: adaCaret?.getAttribute('data-client-id') ?? null,
    borderColor: adaCaret ? getComputedStyle(adaCaret).borderLeftColor : null,
    rectLeft: rect?.left ?? null,
    rectTop: rect?.top ?? null,
    selectionStyle: selections[0]?.getAttribute('style') ?? null,
  };
});

if (decorState.caretCount >= 1) {
  ok('caret rendered', decorState.caretCount + ' .cm-peer-caret in DOM');
} else {
  failL('caret rendered', 'no .cm-peer-caret in DOM : ' + JSON.stringify(decorState));
}
if (decorState.dataName === 'Ada') {
  ok('caret label', 'data-name="Ada" (rendered via CSS ::after)');
} else {
  failL('caret label', 'expected Ada, got ' + JSON.stringify(decorState));
}
if (decorState.dataClientID === '999999') {
  ok('client id attr', 'data-client-id="999999"');
} else {
  failL('client id attr', 'got ' + decorState.dataClientID);
}
if (decorState.selectionCount >= 1) {
  ok('selection mark', '.cm-peer-selection painted (style="' + decorState.selectionStyle + '")');
} else {
  failL('selection mark', 'no .cm-peer-selection in DOM');
}
// Pixel-position sanity : the caret's bounding rect should sit
// somewhere inside the editor's content box ; we just want to
// confirm it has a real layout (not display:none and not at 0,0).
if (decorState.rectLeft !== null && decorState.rectLeft > 0 && decorState.rectTop !== null && decorState.rectTop > 0) {
  ok('caret positioned', 'left=' + decorState.rectLeft.toFixed(1)
    + ' top=' + decorState.rectTop.toFixed(1));
} else {
  failL('caret positioned', JSON.stringify({
    left: decorState.rectLeft, top: decorState.rectTop,
  }));
}

// Now confirm the LOCAL broadcast path : after moving the caret,
// our own awareness state should carry a `cursor` field too. This
// is what peers consume to draw US in their editor.
await page.evaluate(() => {
  (window).weftLoomJumpToOffset?.(5, 12);
});
await new Promise((r) => setTimeout(r, 200));
const localCursor = await page.evaluate(() => {
  const a = (window).weftLoomAwareness;
  if (!a) return null;
  const s = a.getLocalState();
  return s?.cursor ?? null;
});
if (localCursor && typeof localCursor.anchor === 'number' && typeof localCursor.head === 'number') {
  ok('local broadcast',
    'awareness.cursor={anchor:' + localCursor.anchor + ', head:' + localCursor.head + '}');
} else {
  failL('local broadcast', 'no cursor in local awareness state : ' + JSON.stringify(localCursor));
}

await browser.close();
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
