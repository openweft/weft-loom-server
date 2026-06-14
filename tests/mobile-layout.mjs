// mobile-layout.mjs — puppeteer regression harness for the SPA's
// responsive sweep at < 768 px (iPhone 12/13/14 viewport 390×844).
//
// Asserts :
//   - the Navbar exposes a hamburger button on narrow viewports
//   - the slide-over sidebar is collapsed (off-screen) by default
//   - clicking the hamburger slides it in
//   - clicking the backdrop slides it out again
//   - StatusBar drops cursor coords + word count below md
//   - the editor column doesn't overflow the viewport horizontally
//
// Exit code = 0 on PASS, 1 on FAIL. Wired into tests/run.sh.

import puppeteer from 'puppeteer';

const ROOT = 'http://127.0.0.1:8080/';
let passed = 0;
let failed = 0;

function ok(name, msg) {
  passed++;
  console.log('  \x1b[32m✓\x1b[0m ' + name + (msg ? '  ' + msg : ''));
}
function fail(name, msg) {
  failed++;
  console.log('  \x1b[31m✕\x1b[0m ' + name + '  ' + msg);
}
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    fail(name, String(e?.message ?? e));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
    jsErrors.push('console.error: ' + m.text().slice(0, 200));
  }
});

console.log('\n\x1b[1mweft-loom mobile-layout suite (390×844, iPhone)\x1b[0m');

// iPhone 12/13/14 logical viewport. 390×844 catches both
// the < 640 (sm) AND < 768 (md) breakpoints in one shot.
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto(ROOT, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));

await step('boot: no JS errors', async () => {
  assert(jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));
  ok('boot: no JS errors');
});

await step('navbar: hamburger button visible', async () => {
  const info = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Toggle sidebar"]');
    if (!btn) return { found: false };
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    return { found: true, display: cs.display, w: r.width, h: r.height };
  });
  assert(info.found, 'no [aria-label="Toggle sidebar"] in DOM');
  assert(info.display !== 'none', 'hamburger has display:none on mobile (should be visible)');
  ok('navbar: hamburger button visible', '(' + info.w + '×' + info.h + ')');
});

await step('navbar: hamburger meets 44 px touch target', async () => {
  const info = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Toggle sidebar"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  assert(info, 'no hamburger button');
  assert(info.h >= 44 && info.w >= 44, 'hamburger ' + info.w + '×' + info.h + ' < 44×44');
  ok('navbar: hamburger ≥ 44 px', '(' + info.w + '×' + info.h + ')');
});

await step('sidebar: collapsed by default', async () => {
  const info = await page.evaluate(() => {
    const slide = document.querySelector('.weft-mobile-sidebar');
    if (!slide) return { found: false };
    const cs = getComputedStyle(slide);
    return {
      found: true,
      transform: cs.transform,
      open: slide.classList.contains('open'),
      position: cs.position,
    };
  });
  assert(info.found, '.weft-mobile-sidebar wrapper not found');
  assert(!info.open, 'sidebar already has .open on first paint');
  // matrix(1, 0, 0, 1, -X, 0) → translateX(-100%). We just check
  // that the transform isn't the identity.
  assert(info.transform !== 'none', 'sidebar transform=none — slide-over not engaged');
  ok('sidebar: collapsed by default', '(' + info.transform + ')');
});

await step('sidebar: hamburger click opens it', async () => {
  await page.click('button[aria-label="Toggle sidebar"]');
  await new Promise((r) => setTimeout(r, 350)); // wait for the 200 ms slide
  const info = await page.evaluate(() => {
    const slide = document.querySelector('.weft-mobile-sidebar');
    if (!slide) return { found: false };
    const cs = getComputedStyle(slide);
    return { found: true, open: slide.classList.contains('open'), transform: cs.transform };
  });
  assert(info.open, 'hamburger click did not add .open class');
  ok('sidebar: hamburger opens it', '(transform=' + info.transform + ')');
});

await step('sidebar: backdrop click closes it', async () => {
  const hasBackdrop = await page.evaluate(() =>
    !!document.querySelector('.weft-mobile-backdrop'),
  );
  assert(hasBackdrop, 'no .weft-mobile-backdrop rendered while sidebar open');
  // The backdrop covers the full viewport at z-index 40, but the
  // slide-over sits ON TOP at z-index 50, so a center-of-element
  // click on the backdrop misses (puppeteer hit-tests at center,
  // which the sidebar occludes). Real users tap the VISIBLE area
  // (right of the sidebar) and it works ; the test fires the click
  // event programmatically so it doesn't depend on coordinate
  // arithmetic against the sidebar width.
  await page.evaluate(() => (document.querySelector('.weft-mobile-backdrop')).click());
  await new Promise((r) => setTimeout(r, 350));
  const info = await page.evaluate(() => {
    const slide = document.querySelector('.weft-mobile-sidebar');
    if (!slide) return null;
    return {
      open: slide.classList.contains('open'),
      backdropGone: !document.querySelector('.weft-mobile-backdrop'),
    };
  });
  assert(info, 'sidebar wrapper vanished after backdrop click');
  assert(!info.open, '.open class still present after backdrop click');
  assert(info.backdropGone, 'backdrop still in DOM after click');
  ok('sidebar: backdrop click closes it');
});

await step('statusbar: cursor coords hidden below md', async () => {
  // The StatusBar slot for "Ln X, Col Y" carries hidden md:inline.
  // We verify either (a) no such span exists yet (no editor active)
  // OR (b) every match has computed display:none. The "title=Cursor
  // position" attribute pins down the specific span.
  const visible = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('[title="Cursor position"]'));
    return spans.filter((s) => getComputedStyle(s).display !== 'none').length;
  });
  assert(visible === 0, 'cursor coord span visible on mobile : ' + visible);
  ok('statusbar: cursor coords hidden');
});

await step('statusbar: word count hidden below md', async () => {
  const visible = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('[title="Word count"]'));
    return spans.filter((s) => getComputedStyle(s).display !== 'none').length;
  });
  assert(visible === 0, 'word count span visible on mobile : ' + visible);
  ok('statusbar: word count hidden');
});

await step('layout: no horizontal overflow', async () => {
  const info = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    bodyW: document.body.scrollWidth,
    vpW: window.innerWidth,
  }));
  // Allow a tiny slack (1 px) for scrollbar / sub-pixel rounding.
  assert(
    info.docW <= info.vpW + 1 && info.bodyW <= info.vpW + 1,
    'horizontal overflow : doc=' + info.docW + ' body=' + info.bodyW + ' vp=' + info.vpW,
  );
  ok('layout: no horizontal overflow', '(' + info.docW + ' ≤ ' + info.vpW + ')');
});

await step('layout: editor surface uses full available width', async () => {
  const info = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return null;
    const r = main.getBoundingClientRect();
    return { w: r.width, vp: window.innerWidth };
  });
  assert(info, 'no <main> in DOM');
  // The mobile slide-over is position:fixed so <main> spans the
  // full viewport width. Accept ≥ 380 to allow for a tiny env()
  // safe-area inset on the wrapper.
  assert(info.w >= info.vp - 20, 'editor main only ' + info.w + ' px wide (vp=' + info.vp + ')');
  ok('layout: editor fills viewport', '(main=' + info.w + ' / vp=' + info.vp + ')');
});

await browser.close();

console.log(
  '\n  ' +
    (failed === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') +
    '  ' + passed + ' passed, ' + failed + ' failed',
);
process.exit(failed === 0 ? 0 : 1);
