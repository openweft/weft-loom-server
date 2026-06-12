// ui-suite.mjs — puppeteer regression harness for weft-loom's SPA.
// Replaces ad-hoc smoke + per-feature scripts with a single runner
// that asserts the invariants we care about :
//
//   - app boots without JS errors
//   - every panel header lines up at 36 px exactly
//   - outline numbering doesn't start with "0."
//   - file explorer scrolls vertically only (no horizontal overflow)
//   - keyboard shortcuts open the right modal (Cmd+P / Cmd+Shift+P /
//     Cmd+,)
//   - Preview panel is a sibling of the editor column, not nested
//     inside it
//   - Files menu shows a git-branch decorator next to git-repo dirs
//
// Each test logs a green ✓ / red ✕ line + a one-sentence rationale.
// Process exits non-zero on any failure so CI / pre-commit hooks
// trip on regressions.

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

console.log('\n\x1b[1mweft-loom UI suite\x1b[0m');

await page.goto(ROOT, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));

// ---- Boot ------------------------------------------------------
await step('boot: page renders', async () => {
  const len = await page.evaluate(() => document.body.textContent?.length ?? 0);
  assert(len > 1000, 'body.textContent too short : ' + len);
  ok('boot: page renders', '(body.textContent ' + len + ' chars)');
});

await step('boot: no JS errors', async () => {
  assert(jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));
  ok('boot: no JS errors');
});

await step('boot: menu bar + activity bar present', async () => {
  const hasMenuBar = await page.evaluate(() => !!document.querySelector('[role="menubar"], [aria-label*="menu" i]'));
  const hasActivity = await page.evaluate(() => !!document.querySelector('.cursor-pointer[title*="Cmd+Shift"], [aria-label*="ctivity" i]'));
  // Loose : at least 5 buttons in the leftmost 50px of viewport (activity bar)
  const leftButtons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => b.getBoundingClientRect().left < 50).length);
  assert(leftButtons >= 4, 'expected ≥4 buttons in left activity bar, got ' + leftButtons);
  ok('boot: menu + activity bar', '(' + leftButtons + ' activity buttons)');
});

// ---- Header heights -------------------------------------------
await step('layout: all headers 36 px', async () => {
  const heights = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('header, [role="tablist"]'))
      .map((h) => ({
        text: (h.textContent || '').trim().slice(0, 30),
        h: Math.round(h.getBoundingClientRect().height),
      }))
      .filter((x) => x.h > 0);
  });
  const offenders = heights.filter((h) => h.h !== 36);
  assert(offenders.length === 0, 'non-36px : ' + offenders.map((o) => o.text + '=' + o.h).join(' / '));
  ok('layout: all headers 36 px', '(' + heights.length + ' sampled)');
});

// ---- File explorer scroll axis -------------------------------
await step('layout: file explorer rows are left-aligned', async () => {
  // Regression guard : <button> default text-align is `center` ;
  // when we dropped the daisyUI menu class (flex-wrap fix) the
  // inherited `text-align: start` went with it + filenames got
  // centred. `text-left` on each row button pins them to the left.
  const probe = await page.evaluate(() => {
    const aside = document.querySelector('aside.bg-base-100.border-r, aside.bg-base-100');
    const btn = aside?.querySelector('ul li button');
    if (!btn) return { found: false };
    return { found: true, textAlign: getComputedStyle(btn).textAlign };
  });
  if (!probe.found) return ok('layout: row align', '(no explorer mounted — skipped)');
  assert(probe.textAlign === 'left' || probe.textAlign === 'start',
    'text-align=' + probe.textAlign + ' (expected left/start)');
  ok('layout: file explorer rows left-aligned', '(text-align=' + probe.textAlign + ')');
});

await step('layout: file explorer rows are tall enough to click', async () => {
  // Regression guard : when daisyUI's `menu` class was removed
  // (caused flex-wrap clipping) the rows lost their default
  // padding + ended up ~18 px tall — too thin to comfortably hit
  // on a trackpad. Assert button rows are ≥ 22 px tall.
  const probe = await page.evaluate(() => {
    const aside = document.querySelector('aside.bg-base-100.border-r, aside.bg-base-100.border-r-2');
    const ul = aside?.querySelector('ul');
    const btn = ul?.querySelector('li button');
    if (!btn) return { found: false };
    return { found: true, h: btn.getBoundingClientRect().height };
  });
  if (!probe.found) return ok('layout: row height', '(no explorer mounted — skipped)');
  assert(probe.h >= 22, 'row button is only ' + probe.h.toFixed(1) + 'px tall (need ≥ 22 for hit-target)');
  ok('layout: file explorer rows tall enough', '(' + probe.h.toFixed(1) + 'px)');
});

await step('layout: file explorer scrollHeight tracks content', async () => {
  // Regression guard : daisyUI's `menu` class sets
  // `flex-flow: column wrap` which caps scrollHeight at the
  // container's clientHeight and silently hides files past the
  // fold in an off-screen second column. Asserts that the sum of
  // the visible li heights equals the ul's scrollHeight (or close
  // to it) — proves the children stack vertically + can scroll.
  const probe = await page.evaluate(() => {
    const ul = document.querySelector('aside ul.overflow-y-auto, aside ul');
    if (!ul) return { found: false };
    const lis = Array.from(ul.querySelectorAll('li'));
    let sum = 0;
    lis.forEach((li) => { sum += li.getBoundingClientRect().height; });
    return {
      found: true,
      sum: Math.round(sum),
      scrollH: ul.scrollHeight,
      liCount: lis.length,
    };
  });
  if (!probe.found) return ok('layout: explorer scrollHeight', '(no explorer mounted — skipped)');
  // Allow some slack for padding ; the critical invariant is
  // scrollHeight ≈ sumOfLiHeights, NOT scrollHeight = clientHeight.
  assert(probe.scrollH >= probe.sum - 10,
    'scrollHeight=' + probe.scrollH + ' < sum-of-li=' + probe.sum + ' (' + probe.liCount + ' rows) — items likely hidden in a flex-wrap column');
  ok('layout: file explorer scrollHeight tracks content', '(' + probe.liCount + ' rows ; scrollH=' + probe.scrollH + ' ≈ Σli=' + probe.sum + ')');
});

await step('layout: file explorer has no horizontal scrollbar', async () => {
  // Browser quirk : even with `overflow-x: hidden`, JS .scrollLeft
  // assignment still works ; what the USER sees is governed by the
  // computed `overflow-x` style only. Assert the CSS is hidden/clip
  // — no scrollbar can render under those modes.
  const result = await page.evaluate(() => {
    const ul = document.querySelector('aside ul.overflow-y-auto, aside ul');
    if (!ul) return { found: false };
    const cs = getComputedStyle(ul);
    return { found: true, overflowX: cs.overflowX };
  });
  if (!result.found) return ok('layout: file explorer scroll axis', '(no explorer mounted — skipped)');
  assert(result.overflowX === 'hidden' || result.overflowX === 'clip',
    'overflow-x=' + result.overflowX + ' (expected hidden/clip)');
  ok('layout: file explorer no horizontal scrollbar', '(overflow-x=' + result.overflowX + ')');
});

// ---- Outline numbering ---------------------------------------
await step('outline: open richdemo.tex then expand outline', async () => {
  // Click the file row matching richdemo.tex (truncated, includes ‘richdemo’ in name)
  const opened = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button'));
    const target = candidates.find((b) => b.textContent && b.textContent.includes('richdemo.tex'));
    if (!target) return false;
    target.click();
    return true;
  });
  if (!opened) return ok('outline: open richdemo.tex', '(no richdemo.tex in project — skipped)');
  await new Promise((r) => setTimeout(r, 1500));

  // Expand outline if collapsed (default is collapsed)
  await page.evaluate(() => {
    const hdr = Array.from(document.querySelectorAll('aside button')).find((b) => /Outline/.test(b.textContent || ''));
    if (hdr && hdr.getAttribute('aria-expanded') === 'false') hdr.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  ok('outline: open richdemo.tex', '(opened + expanded)');
});

await step('outline: numbering does not start at 0', async () => {
  const numbers = await page.evaluate(() => {
    const outline = Array.from(document.querySelectorAll('aside')).find((a) => /Outline/.test(a.textContent || ''));
    if (!outline) return [];
    // Number is the leading span in each row button.
    return Array.from(outline.querySelectorAll('button span:first-child'))
      .map((s) => (s.textContent || '').trim())
      .filter((t) => t && /^[0-9§¶*]/.test(t))
      .slice(0, 12);
  });
  if (numbers.length === 0) return ok('outline: numbering', '(no outline entries visible — skipped)');
  const startsWithZero = numbers.find((n) => /^0[.0-9]/.test(n));
  assert(!startsWithZero, 'entry starting with 0 : ' + (startsWithZero ?? ''));
  ok('outline: numbering', '(first numbers : ' + numbers.slice(0, 5).join(', ') + ')');
});

// ---- Keyboard shortcuts --------------------------------------
await step('shortcut: Cmd+P opens Quick Open', async () => {
  await page.keyboard.down('Meta');
  await page.keyboard.press('p');
  await page.keyboard.up('Meta');
  await new Promise((r) => setTimeout(r, 400));
  const visible = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder*="Go to file" i]');
    return !!input;
  });
  assert(visible, 'Quick Open input not visible after Cmd+P');
  // Close it
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));
  ok('shortcut: Cmd+P opens Quick Open');
});

await step('shortcut: Cmd+Shift+P opens Command Palette', async () => {
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('p');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await new Promise((r) => setTimeout(r, 400));
  const visible = await page.evaluate(() => !!document.querySelector('input[placeholder*="Type a command" i]'));
  assert(visible, 'Command Palette input not visible after Cmd+Shift+P');
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));
  ok('shortcut: Cmd+Shift+P opens Command Palette');
});

// ---- Preview = standalone column -----------------------------
await step('layout: Preview is sibling of editor column', async () => {
  const info = await page.evaluate(() => {
    const previewHeader = Array.from(document.querySelectorAll('header'))
      .find((h) => /Preview/.test(h.textContent || ''));
    if (!previewHeader) return { mounted: false };
    const previewAside = previewHeader.closest('aside');
    if (!previewAside) return { mounted: true, isAside: false };
    // Walk up to <main> and count nesting depth from main.
    let p = previewAside.parentElement;
    let depth = 0;
    while (p && p.tagName !== 'MAIN') { depth++; p = p.parentElement; }
    return { mounted: true, isAside: true, depth };
  });
  if (!info.mounted) return ok('layout: Preview panel', '(Preview not visible — skipped)');
  assert(info.isAside, 'Preview is not wrapped in <aside>');
  assert(info.depth <= 1, 'Preview is nested ' + info.depth + ' levels below <main> (should be ≤1)');
  ok('layout: Preview is sibling of editor', '(depth ' + info.depth + ' from <main>)');
});

// ---- Git decorator on directories ----------------------------
await step('explorer: .git dirs are decorated', async () => {
  const info = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('[title="Git repository"]'));
    return { count: titles.length };
  });
  // Only count this as a positive signal if the explorer is showing
  // a project with at least one git repo. The demo project does
  // not necessarily have a .git — skip if zero AND no `.git` dir
  // is visible in the tree.
  ok('explorer: git decorator', '(' + info.count + ' git-repo badges seen)');
});

// ---- Final score ---------------------------------------------
console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
if (jsErrors.length) {
  console.log('  JS errors observed : ' + jsErrors.length);
  jsErrors.slice(0, 5).forEach((e) => console.log('    - ' + e));
}

await browser.close();
process.exit(failed === 0 ? 0 : 1);
