// ui-compile-entry.mjs — guard against the "Run button uses
// hardcoded main.<ext> instead of the active file" regression.
//
// History : in 2026-06-12, the SPA's CompileLogPanel / CompileDrawer
// called startCompile(project, { language }) WITHOUT threading the
// open file's path through `entry`. The server-side dispatcher then
// fell back to main.<ext> as the default — which fails immediately
// on ad-hoc files like `untitled-1u9b.go` with
// `stat main.go: no such file or directory` /
// `read main.md : open ... no such file or directory`. The bug
// stayed invisible to lang-suite because its fixtures are always
// named main.<ext>.
//
// This test seeds a deliberately NON-default-named file, drives the
// SPA's Run UI through puppeteer, and asserts the compile log
// references the actual file path — not the fallback. Two languages
// are exercised (go + markdown) because the bug surfaced on both ;
// other languages share the same SPA call site so coverage on one
// is enough to catch regressions to the wiring.

import puppeteer from 'puppeteer';
import http from 'http';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
let passed = 0;
let failed = 0;

function ok(name, msg) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name + (msg ? '  ' + msg : '')); }
function failL(name, msg) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + name + '  ' + msg); }

async function http200(path, body) {
  const r = await fetch(ROOT + path, body ? { method: 'PUT', body } : undefined);
  return r;
}

// Capture the most recent compile job's log lines from the SSE
// stream — used to assert that the workspace dispatcher saw the
// real file path, not the fallback.
async function tailLatestCompileLog(jobId, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const req = http.get(ROOT + '/api/projects/' + PROJECT + '/compile/' + jobId, (res) => {
      let buf = '';
      const lines = [];
      const timer = setTimeout(() => { req.destroy(); resolve(lines); }, timeoutMs);
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const ev = /^event: (\w+)/m.exec(frame);
          const data = /^data: (.*)$/m.exec(frame);
          if (!ev || !data) continue;
          if (ev[1] === 'log') {
            try { lines.push(JSON.parse(data[1]).line || data[1]); } catch { lines.push(data[1]); }
          }
          if (ev[1] === 'result') { clearTimeout(timer); req.destroy(); resolve(lines); return; }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve(lines); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', reject);
  });
}

// CASES : language + a deliberately non-`main.<ext>` filename
// (project root so the puppeteer file-explorer click doesn't need to
// expand a sub-folder, which is flaky with the current selector).
const CASES = [
  { lang: 'golang', path: 'ui-entry-abc123.go',
    content: 'package main\n\nimport "fmt"\n\nfunc main(){ fmt.Println("ok") }\n' },
  { lang: 'markdown', path: 'ui-entry-abc123.md',
    content: '---\nmarp: true\ntheme: default\n---\n\n# heading\n\nbody.\n' },
];

console.log('\n\x1b[1mweft-loom UI compile-entry suite\x1b[0m');

// 1) seed fixtures via PUT
for (const c of CASES) {
  const r = await http200('/api/projects/' + PROJECT + '/files/' + encodeURIComponent(c.path), c.content);
  if (r.status !== 200 && r.status !== 204) {
    failL(c.lang + ' : seed', 'HTTP ' + r.status);
    process.exit(1);
  }
}

// 2) launch puppeteer, drive Run on each fixture
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const compileJobs = [];
// Patch fetch to capture compile job IDs and their request body —
// confirms the SPA passes `entry` and lets the harness tail the
// resulting SSE.
await page.exposeFunction('__captureCompileStart', (info) => compileJobs.push(info));
await page.evaluateOnNewDocument(() => {
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (init && init.method === 'POST' && /\/compile$/.test(url)) {
      let body = '';
      try { body = init.body ? String(init.body) : ''; } catch {}
      const r = await origFetch.apply(this, arguments);
      const cl = r.clone();
      try {
        const data = await cl.json();
        window.__captureCompileStart({ url, body, id: data?.id || null });
      } catch {}
      return r;
    }
    return origFetch.apply(this, arguments);
  };
});

await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));

for (const c of CASES) {
  // Reload so the file explorer picks up the fresh fixture.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));
  // Open programmatically (the file-explorer click path is flaky
  // when files are off-screen / virtualised). The SPA exposes
  // window.weftLoomOpenFile(path) specifically for this.
  const opened = await page.evaluate((p) => {
    const fn = window.weftLoomOpenFile;
    if (typeof fn === 'function') { fn(p); return true; }
    return false;
  }, c.path);
  if (!opened) {
    failL(c.lang + ' : open file', 'window.weftLoomOpenFile missing');
    continue;
  }
  await new Promise((r) => setTimeout(r, 1200));

  // Trigger compile via the SPA's exposed Run hook
  // (window.weftLoomTriggerCompile). This bypasses the brittle
  // "find the visible Run button and click it" detection but
  // exercises the SAME code path : start a compile with
  // {language, entry: currentFile}. If the SPA forgets to pass
  // entry, the harness catches it below.
  const beforeCount = compileJobs.length;
  const ran = await page.evaluate(async () => {
    const fn = window.weftLoomTriggerCompile;
    if (typeof fn !== 'function') return false;
    await fn();
    return true;
  });
  if (!ran) {
    failL(c.lang + ' : Run hook', 'window.weftLoomTriggerCompile missing');
    continue;
  }
  // Wait for the SPA to POST /compile and the harness to capture it.
  await new Promise((r) => setTimeout(r, 1200));
  const newJobs = compileJobs.slice(beforeCount);
  if (newJobs.length === 0) {
    failL(c.lang + ' : Run dispatch', 'no POST /compile captured');
    continue;
  }
  const job = newJobs[newJobs.length - 1];
  let parsedBody = {};
  try { parsedBody = JSON.parse(job.body); } catch {}
  if (!parsedBody.entry || parsedBody.entry === 'main.' + c.path.split('.').pop()) {
    failL(c.lang + ' : entry threading',
      'expected entry≈' + c.path + ' but POST body had entry=' + JSON.stringify(parsedBody.entry));
    continue;
  }
  if (!String(parsedBody.entry).endsWith(c.path.split('/').pop())) {
    failL(c.lang + ' : entry threading',
      'entry does not match active file : ' + parsedBody.entry);
    continue;
  }
  ok(c.lang + ' : SPA threads entry', 'entry=' + parsedBody.entry);

  // Tail the compile log + assert the dispatcher didn't say "no
  // such file or directory" against main.<ext>. We accept the
  // compile may fail later for unrelated reasons (image cold-cache),
  // but it must NOT trip the "stat main.X / read main.X" fallback.
  if (job.id) {
    const logs = await tailLatestCompileLog(job.id, 12_000);
    const bad = logs.find((l) => /no such file or directory/.test(l) && /main\.\w+/.test(l));
    if (bad) {
      failL(c.lang + ' : server sees real entry',
        'dispatcher fell back to main.<ext> : ' + bad.slice(0, 140));
    } else {
      ok(c.lang + ' : server sees real entry', '(' + logs.length + ' log lines, no main.<ext> fallback)');
    }
  }
}

await browser.close();

// Cleanup
for (const c of CASES) {
  await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(c.path),
    { method: 'DELETE' }).catch(() => {});
}

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
