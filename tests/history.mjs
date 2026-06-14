// history.mjs — track-changes history (V0.5) end-to-end :
//   1. Write a file twice spaced > 30 s apart → 2 history entries
//   2. GET /api/projects/<p>/history returns both, newest-first
//   3. GET /api/projects/<p>/history/snapshot returns the older
//      version's content verbatim
//   4. POST /api/projects/<p>/history/restore puts that content back
//      to the live file
//   5. Binary content is NOT snapshotted (NUL byte detection)

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const FILE = 'history-test-' + Date.now() + '.md';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom history suite\x1b[0m');

function url(path) { return ROOT + '/api/projects/' + PROJECT + path; }
async function write(path, body) {
  const r = await fetch(url('/files/' + encodeURIComponent(path)), { method: 'PUT', body });
  return r.ok;
}
async function read(path) {
  const r = await fetch(url('/files/' + encodeURIComponent(path)));
  if (!r.ok) return null;
  return await r.text();
}
async function list() {
  const r = await fetch(url('/history?file=' + encodeURIComponent(FILE)));
  if (!r.ok) return null;
  const data = await r.json();
  return data.entries;
}

// V1 write
const V1 = '# Version one\n\nFirst draft.\n';
const V2 = '# Version two\n\nSecond draft — bigger edit.\nLine added.\n';

if (await write(FILE, V1)) ok('seed v1'); else failL('seed v1');
// First snapshot fires immediately. Wait > 30 s for the debounce
// window to elapse so the second write also produces an entry.
console.log('  ⏳ waiting 31 s for snapshot debounce…');
await new Promise(r => setTimeout(r, 31_000));
if (await write(FILE, V2)) ok('seed v2'); else failL('seed v2');

await new Promise(r => setTimeout(r, 500));
const entries = await list();
if (entries && entries.length === 2) {
  ok('history list', '2 entries (newest first)');
} else {
  failL('history list', 'expected 2 entries, got ' + JSON.stringify(entries));
  process.exit(1);
}
// Newest first
if (new Date(entries[0].ts).getTime() > new Date(entries[1].ts).getTime()) {
  ok('newest-first ordering');
} else {
  failL('newest-first ordering', JSON.stringify(entries.map(e => e.ts)));
}

// Fetch the OLDER snapshot ; should give us V1
const olderTs = entries[1].ts;
const snapResp = await fetch(url('/history/snapshot?file=' + encodeURIComponent(FILE) + '&at=' + encodeURIComponent(olderTs)));
if (snapResp.ok) {
  const snap = await snapResp.json();
  if (snap.content === V1) ok('snapshot content matches v1');
  else failL('snapshot content matches v1', 'got ' + JSON.stringify(snap.content));
} else {
  failL('snapshot fetch', 'HTTP ' + snapResp.status);
}

// Restore : POST puts V1 back to live file
const restoreResp = await fetch(url('/history/restore'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ file: FILE, at: olderTs }),
});
if (restoreResp.ok || restoreResp.status === 204) {
  ok('restore POST', 'HTTP ' + restoreResp.status);
} else {
  failL('restore POST', 'HTTP ' + restoreResp.status);
}
const liveAfter = await read(FILE);
if (liveAfter === V1) {
  ok('live file matches v1 after restore');
} else {
  failL('live file matches v1 after restore', 'got ' + JSON.stringify(liveAfter));
}

// Binary content : a buffer containing a NUL byte should NOT
// produce a new history entry.
const BIN_FILE = 'history-bin-' + Date.now() + '.bin';
const bin = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0x1A, 0x0A]); // PNG-ish with NUL
await fetch(url('/files/' + encodeURIComponent(BIN_FILE)), { method: 'PUT', body: bin });
await new Promise(r => setTimeout(r, 500));
const binList = await fetch(url('/history?file=' + encodeURIComponent(BIN_FILE)))
  .then(r => r.json()).then(d => d.entries);
if (Array.isArray(binList) && binList.length === 0) {
  ok('binary file not snapshotted');
} else {
  failL('binary file not snapshotted', JSON.stringify(binList));
}

// Cleanup
await fetch(url('/files/' + encodeURIComponent(FILE)), { method: 'DELETE' }).catch(() => {});
await fetch(url('/files/' + encodeURIComponent(BIN_FILE)), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
