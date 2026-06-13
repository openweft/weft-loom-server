// shell_spa_diag.mjs — drive the SPA exactly like Safari does
// (puppeteer Chromium = same WS + DOM + JS code path), watch the
// /api/events SSE stream concurrently, and dump every observable
// signal so we can locate "shell hang" without asking the operator
// to inspect their browser. End-to-end self-diagnosis using the
// loom-doctor observability the V0.4 work landed.

import puppeteer from 'puppeteer';

const URL = process.env.LOOM_URL ?? 'http://127.0.0.1:8080';
const PROJECT = 'demo';

const events = [];
const sseLogs = [];

async function tailSSE() {
  const resp = await fetch(`${URL}/api/events`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value);
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const ev = JSON.parse(line.slice(6));
          events.push(ev);
          if (['shell', 'workspace', 'seed', 'ws', 'spa', 'editor', 'warmup'].includes(ev.component)) {
            sseLogs.push(`[${ev.source}] ${ev.component}.${ev.verb} ${JSON.stringify(ev.fields || {})}`);
          }
        } catch {}
      }
    }
  }
}

async function drive() {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  const consoleLogs = [];
  const wsEvents = [];
  const errors = [];

  page.on('console', (msg) => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    errors.push(`PAGEERROR ${err.message}\n${err.stack?.split('\n').slice(0, 5).join('\n')}`);
  });
  // CDP : capture every WebSocket frame for the shell endpoint.
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', (e) => {
    wsEvents.push(`WS CREATED url=${e.url}`);
  });
  cdp.on('Network.webSocketFrameSent', (e) => {
    if (e.response.payloadData) {
      wsEvents.push(`WS→ id=${e.requestId} bytes=${e.response.payloadData.length}`);
    }
  });
  cdp.on('Network.webSocketFrameReceived', (e) => {
    if (e.response.payloadData) {
      const preview = atob(e.response.payloadData.slice(0, 60).replace(/[^A-Za-z0-9+/=]/g, ''))
        .replace(/[^\x20-\x7e]/g, '.');
      wsEvents.push(`WS← id=${e.requestId} bytes=${e.response.payloadData.length} ${preview.slice(0, 60)}`);
    }
  });
  cdp.on('Network.webSocketFrameError', (e) => {
    wsEvents.push(`WS! id=${e.requestId} err=${e.errorMessage}`);
  });
  cdp.on('Network.webSocketClosed', (e) => {
    wsEvents.push(`WS CLOSED id=${e.requestId}`);
  });

  await page.goto(`${URL}/?project=${PROJECT}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2500));

  // Click 🖥 Shell button
  const clicked = await page.evaluate(() => {
    // Find the navbar shell toggle by title
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((b) => b.title?.includes('shell terminal'));
    if (target) {
      target.click();
      return { found: true, title: target.title };
    }
    return { found: false, allTitles: buttons.map((b) => b.title).filter(Boolean).slice(0, 20) };
  });
  console.log('SHELL CLICK', clicked);

  await new Promise((r) => setTimeout(r, 4000));

  // Dump shell panel state
  const shellState = await page.evaluate(() => {
    const shellPanel = document.querySelector('[role="tab"][class*="border-b-primary"]');
    return {
      activeBottomTab: shellPanel?.textContent?.trim(),
      cmEditors: document.querySelectorAll('.cm-editor').length,
      xtermElements: document.querySelectorAll('.xterm').length,
      xtermViewports: document.querySelectorAll('.xterm-viewport').length,
      shellHostExists: !!document.querySelector('[bind\\:this]'),
      visibleBadges: Array.from(document.querySelectorAll('.badge')).map((b) => b.textContent?.trim()).slice(0, 10),
    };
  });
  console.log('SHELL DOM STATE', JSON.stringify(shellState, null, 2));

  // Verify shell is alive : send a keystroke, see echo
  await page.evaluate(() => {
    const term = document.querySelector('.xterm-helper-textarea');
    if (term) { term.focus(); }
  });
  await page.keyboard.type('echo BEFORE_COMPILE\r', { delay: 30 });
  await new Promise((r) => setTimeout(r, 2000));

  const beforeText = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm-rows > div'))
    .map((d) => d.textContent.trim()).filter(Boolean).slice(-8).join('\n'));
  console.log('XTERM BEFORE COMPILE :\n' + beforeText);

  // Now reproduce : click the navbar Compile button (real user path).
  console.log('\n=== LAUNCHING COMPILE via NAVBAR BUTTON ===\n');
  const compileClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const compileBtn = buttons.find((b) => {
      const t = (b.textContent ?? '').trim();
      return t === 'Compile' || t.startsWith('Compile');
    });
    if (compileBtn) {
      compileBtn.click();
      return { found: true, title: compileBtn.textContent?.trim() };
    }
    return { found: false };
  });
  console.log('COMPILE CLICK :', compileClicked);
  await new Promise((r) => setTimeout(r, 4000));

  // Mid-flight : is the shell tab still active ? Has the WS closed ?
  const midState = await page.evaluate(() => {
    return {
      activeBottomTab: document.querySelector('[role="tab"][class*="border-b-primary"]')?.textContent?.trim(),
      xtermElements: document.querySelectorAll('.xterm').length,
      hiddenShells: Array.from(document.querySelectorAll('.xterm'))
        .map((x) => {
          let p = x;
          while (p && p !== document.body) {
            if (p.classList?.contains('hidden')) return 'HIDDEN';
            p = p.parentElement;
          }
          return 'visible';
        }),
    };
  });
  console.log('MID STATE :', JSON.stringify(midState, null, 2));
  await new Promise((r) => setTimeout(r, 11000));

  // Send another keystroke AFTER compile to see if shell still works
  await page.evaluate(() => {
    const term = document.querySelector('.xterm-helper-textarea');
    if (term) { term.focus(); }
  });
  await page.keyboard.type('echo AFTER_COMPILE\r', { delay: 30 });
  await new Promise((r) => setTimeout(r, 3000));

  const afterText = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm-rows > div'))
    .map((d) => d.textContent.trim()).filter(Boolean).slice(-8).join('\n'));
  console.log('XTERM AFTER COMPILE :\n' + afterText);

  // Shell connected badge state
  const shellConnState = await page.evaluate(() => {
    const badges = Array.from(document.querySelectorAll('.badge'));
    return badges.map((b) => b.textContent?.trim()).filter((s) => s && (s.includes('connected') || s.includes('disconnected')));
  });
  console.log('SHELL BADGES NOW :', shellConnState);

  await browser.close();
  return { consoleLogs, wsEvents, errors };
}

const ssePromise = tailSSE();
const driveResult = await drive();
await new Promise((r) => setTimeout(r, 500)); // let SSE drain

console.log('\n========================================');
console.log('SSE EVENTS (shell/workspace/spa)');
console.log('========================================');
sseLogs.forEach((l) => console.log(l));

console.log('\n========================================');
console.log('WS FRAMES');
console.log('========================================');
driveResult.wsEvents.forEach((l) => console.log(l));

console.log('\n========================================');
console.log('CONSOLE LOGS (filtered)');
console.log('========================================');
driveResult.consoleLogs
  .filter((l) => /shell|nats|exec|ws|workspace|seed|term/i.test(l))
  .forEach((l) => console.log(l));

console.log('\n========================================');
console.log('PAGE ERRORS');
console.log('========================================');
driveResult.errors.forEach((l) => console.log(l));

process.exit(0);
