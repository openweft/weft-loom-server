// presence-cursors.mjs — where the other person is, painted in this editor.
//
// The previous version grabbed the live Awareness handle off
// `window.weftLoomAwareness`, pushed a synthetic peer into its internal states
// map and fired a 'change' event. That was a fair way to test a ViewPlugin
// driven by Yjs awareness, and it went stale the moment presence started
// reading the collab session: the injection still succeeded, so four of its ten
// checks passed and the six that meant anything did not.
//
// So this drives two real tabs. It is slower, and it is the thing being
// claimed: a peer moves, and the other tab paints it.
//
// It keeps every assertion the old file made —
//   - .cm-peer-caret in the DOM, carrying data-name and a per-peer colour
//   - .cm-peer-selection painted for a non-empty range
//   - the caret sitting where that offset actually is
//   - the local direction: this tab publishes its own cursor
// — and asks them of a peer that exists.
//
// The position check compares the peer caret against the editor's own cursor
// put at the same offset in the same tab. That is the strongest ground truth
// available in the page: if the two agree, the offset survived the crossing in
// the units CodeMirror counts in.
//
// Needs a server on :8080 with a project called demo.
import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const PATH = 'presence-cursors-test-' + Date.now() + '.tex';

let passed = 0,
  failed = 0;
const ok = (t, m) => {
  passed++;
  console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : ''));
};
const failL = (t, m) => {
  failed++;
  console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m);
};

console.log('\n\x1b[1mweft-loom presence cursors suite\x1b[0m');

// A long prose line, so the offsets below land mid-word and a caret has a
// glyph to sit against rather than a line break.
const body =
  '\\documentclass{article}\n' +
  '\\begin{document}\n' +
  'The quick brown fox jumps over the lazy dog and keeps going here.\n' +
  '\\end{document}\n';

const seeded = await fetch(
  ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(PATH),
  { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body },
);
if (seeded.ok) ok('seed', PATH + ' (' + body.length + ' bytes)');
else failL('seed', 'PUT returned ' + seeded.status);

const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

// Each tab gets its own name and colour — in sessionStorage, which is per tab,
// so the label and the border colour asserted below are values only that peer
// could have supplied.
const open = async (name, color) => {
  const p = await br.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(
    ({ n, c }) => {
      sessionStorage.setItem('weft-loom-user-name', n);
      sessionStorage.setItem('weft-loom-user-color', c);
    },
    { n: name, c: color },
  );
  await p.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));
  await p.evaluate((f) => window.weftLoomOpenFile(f), PATH);
  await p.waitForSelector('.cm-content', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000));
  return p;
};

// The editor's own jump hook, which is how every other test moves a selection:
// clicking into CodeMirror from puppeteer waits on a scroll that never settles.
const selectRange = (p, from, to) =>
  p.evaluate(({ f, t }) => window.weftLoomJumpToOffset({ offset: f, to: t }), { f: from, t: to });

const AY = { name: 'Tab Ay', color: 'hsl(200, 70%, 50%)' };
const BEE = { name: 'Peer Bee', color: 'hsl(280, 70%, 50%)' };
const a = await open(AY.name, AY.color);
const b = await open(BEE.name, BEE.color);

const docLen = await a.evaluate(
  () => document.querySelector('.cm-content')?.textContent?.length ?? 0,
);
if (docLen > 0) ok('doc loaded', docLen + ' chars');
else failL('doc loaded', 'the editor is empty');

// B selects a range inside the prose line.
const SEL_FROM = 45,
  SEL_TO = 55;
await selectRange(b, SEL_FROM, SEL_TO);
ok('peer moves', 'selection ' + SEL_FROM + '→' + SEL_TO + ' in the other tab');
// A is read next, so it has to be the visible tab: the peer rebuild is
// deferred to requestAnimationFrame, which a background tab never gets.
await a.bringToFront();
await new Promise((r) => setTimeout(r, 3000));

const painted = await a.evaluate(() => {
  const caret = document.querySelector('.cm-peer-caret');
  const sel = document.querySelector('.cm-peer-selection');
  if (!caret) return { caret: false, selection: !!sel };
  const style = caret.getAttribute('style') ?? '';
  return {
    caret: true,
    name: caret.getAttribute('data-name'),
    color: style.match(/--cm-peer-color:\s*([^;]+)/)?.[1]?.trim() ?? null,
    selection: !!sel,
    rect: caret.getBoundingClientRect().toJSON(),
  };
});

if (painted.caret) ok('peer caret', 'rendered in the other tab');
else failL('peer caret', 'no .cm-peer-caret painted for a peer that is there');

if (painted.name === BEE.name) ok('caret label', JSON.stringify(painted.name));
else
  failL('caret label', 'expected ' + JSON.stringify(BEE.name) + ' got ' + JSON.stringify(painted.name));

if (painted.color === BEE.color) ok('caret colour', painted.color);
else failL('caret colour', 'expected ' + BEE.color + ' got ' + painted.color);

if (painted.selection) ok('peer selection', '.cm-peer-selection painted for a 10-character range');
else failL('peer selection', 'no .cm-peer-selection for a non-empty range');

// Where that offset actually is, according to this tab's own editor. Measured
// after the peer caret was read, so moving the local cursor cannot have
// disturbed what was measured.
await selectRange(a, SEL_TO, SEL_TO);
await new Promise((r) => setTimeout(r, 600));
const own = await a.evaluate(() => {
  const cur = document.querySelector('.cm-cursor-primary') ?? document.querySelector('.cm-cursor');
  return cur ? cur.getBoundingClientRect().toJSON() : null;
});

if (!own || !painted.rect) {
  failL('caret position', 'could not measure this tab’s own cursor at offset ' + SEL_TO);
} else {
  const dx = Math.abs(painted.rect.left - own.left);
  const dy = Math.abs(painted.rect.top - own.top);
  // A character of slack across, a line of slack down: the peer caret is a
  // widget beside the position, not the position itself.
  if (dx <= 14 && dy <= 24) {
    ok('caret position', `at offset ${SEL_TO} (off by ${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`);
  } else {
    failL('caret position', `off by ${dx.toFixed(1)}px, ${dy.toFixed(1)}px at offset ${SEL_TO}`);
  }
}

// The local direction, asked of B: a tab reporting its own publication proves
// nothing about what left it. B has to be in front for the same reason.
await b.bringToFront();
await new Promise((r) => setTimeout(r, 2500));
const backAtB = await b.evaluate(() => {
  const caret = document.querySelector('.cm-peer-caret');
  return caret ? caret.getAttribute('data-name') : null;
});
if (backAtB === AY.name) ok('local broadcast', 'the other tab paints this one back');
else failL('local broadcast', 'expected ' + JSON.stringify(AY.name) + ' at the peer, got ' + JSON.stringify(backAtB));

await br.close();

const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log('\n' + colour + passed + '/' + (passed + failed) + ' passed\x1b[0m');
process.exitCode = failed === 0 ? 0 : 1;
