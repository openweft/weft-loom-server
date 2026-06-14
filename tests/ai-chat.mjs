// ai-chat.mjs — regression guard for the AI chat surface.
//
// Two endpoints :
//   POST /api/projects/{p}/chat     legacy JSON stub
//   POST /api/projects/{p}/ai/chat  streaming SSE → real provider
//                                   OR 503 with stub fallback
//
// We don't depend on a real LLM being installed in CI. The MUST-PASS
// case is the 503 fallback : the server reports "provider not
// configured" with a friendly stub reply the SPA can render. The
// nice-to-have case is when a provider IS reachable — we accept a
// 200 SSE stream as success too.
//
// Sequence :
//   1. seed a file into the demo project (so the panel has context)
//   2. POST the legacy /chat — assert JSON shape + non-empty reply
//   3. POST /ai/chat — accept EITHER :
//        (a) 503 with { error, hint, reply } (no provider)
//        (b) 200 text/event-stream with at least one data: chunk
//            then an `event: done` terminator
//   4. ⚠ no real provider needed ; case (a) is the contract.

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const FILE = 'ai-chat-' + Date.now() + '.md';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom AI chat suite\x1b[0m');

function url(path) { return ROOT + '/api/projects/' + PROJECT + path; }

// 1) Seed a file so the chat has a non-trivial context payload.
const SEED = '# Test doc\n\nLine one.\nLine two.\n';
const seedResp = await fetch(url('/files/' + encodeURIComponent(FILE)), {
  method: 'PUT',
  body: SEED,
});
if (seedResp.ok || seedResp.status === 204) ok('seed file', FILE);
else { failL('seed file', 'HTTP ' + seedResp.status); process.exit(1); }

// 2) Legacy /chat — JSON in, JSON out.
const legacyResp = await fetch(url('/chat'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'summarise this please' }],
    file: FILE,
    file_content: SEED,
  }),
});
if (legacyResp.ok) {
  const j = await legacyResp.json();
  if (j && typeof j.reply === 'string' && j.reply.length > 0) {
    ok('legacy /chat returns non-empty reply', 'model=' + (j.model || '?'));
  } else {
    failL('legacy /chat returns non-empty reply', JSON.stringify(j));
  }
} else {
  failL('legacy /chat', 'HTTP ' + legacyResp.status);
}

// 3) Streaming /ai/chat — either 503 stub OR 200 SSE.
const streamResp = await fetch(url('/ai/chat'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'hello' }],
    file: FILE,
    file_content: SEED,
  }),
});

if (streamResp.status === 503) {
  // The CI / fresh-host path. Assert the JSON has the shape the SPA
  // depends on : { error, hint, reply }.
  const ct = streamResp.headers.get('content-type') || '';
  if (ct.includes('application/json')) ok('503 content-type json', ct);
  else failL('503 content-type json', ct);

  let body;
  try { body = await streamResp.json(); }
  catch (e) { failL('503 body parses as JSON', String(e)); body = null; }
  if (body) {
    if (typeof body.error === 'string' && body.error.length > 0) ok('503.error present', body.error);
    else failL('503.error present', JSON.stringify(body));
    if (typeof body.hint === 'string' && body.hint.length > 0) ok('503.hint present', body.hint);
    else failL('503.hint present', JSON.stringify(body));
    if (typeof body.reply === 'string' && body.reply.length > 0) ok('503.reply (stub) present');
    else failL('503.reply (stub) present', JSON.stringify(body));
  }
} else if (streamResp.ok) {
  // The "provider reachable" path. Assert it's SSE + at least one
  // data: chunk arrives + the stream ends with event: done within
  // a reasonable timeout.
  const ct = streamResp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) ok('200 content-type SSE', ct);
  else failL('200 content-type SSE', ct);
  const reader = streamResp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sawData = false;
  let sawDone = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise(r => setTimeout(() => r({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let ev = 'message';
      let dl = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) dl += line.slice(5).trim();
      }
      if (ev === 'message' && dl) sawData = true;
      if (ev === 'done') { sawDone = true; break; }
      if (ev === 'error') { failL('stream emitted error event', dl); break; }
    }
    if (sawDone) break;
  }
  if (sawData) ok('SSE delivered at least one data chunk');
  else failL('SSE delivered at least one data chunk', 'no data: lines arrived');
  if (sawDone) ok('SSE terminated with event: done');
  else failL('SSE terminated with event: done', 'reached EOF / timeout instead');
} else {
  failL('/ai/chat', 'unexpected HTTP ' + streamResp.status + ': ' + (await streamResp.text()));
}

// Cleanup
await fetch(url('/files/' + encodeURIComponent(FILE)), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
