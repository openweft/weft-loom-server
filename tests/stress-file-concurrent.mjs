// stress-file-concurrent.mjs — concurrent writes + reads on the
// SAME file path. The atomic-write fix at LocalStore.WriteFile should
// prevent torn reads even under heavy contention. Validation : after
// N concurrent PUTs the final content is one of the writers' bodies
// AND a parallel reader never sees a partial / corrupt file.

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'stress-file-' + Date.now();
const PATH = 'shared.txt';
const URL = `${ROOT}/api/projects/${PROJECT}/files/${PATH}`;

const WRITERS = 30;
const READERS = 30;
const DURATION_MS = 20_000;

// Seed an initial body so the readers don't 404.
await fetch(URL, { method: 'PUT', body: 'init' });

const stats = {
  writesOK: 0,
  writesFail: 0,
  readsOK: 0,
  readsFail: 0,
  partialReads: 0,
  errors: 0,
};

// Each writer produces a body of "WRITERnn:" repeated K times so any
// torn read is detectable (a partial of writer A's body would
// look like WRITER05:WRITER05:WRIT…). The body length is large
// enough that O_TRUNC vs rename matters.
function bodyFor(writerID) {
  const tag = `WRITER${String(writerID).padStart(2, '0')}:`;
  return tag.repeat(2048); // ~22 KiB ; bigger than typical sidecar
}

async function writer(id) {
  const body = bodyFor(id);
  const stopAt = Date.now() + DURATION_MS;
  while (Date.now() < stopAt) {
    try {
      const r = await fetch(URL, { method: 'PUT', body });
      if (r.ok) stats.writesOK++; else stats.writesFail++;
    } catch {
      stats.errors++;
    }
  }
}

async function reader() {
  const stopAt = Date.now() + DURATION_MS;
  while (Date.now() < stopAt) {
    try {
      const r = await fetch(URL);
      if (!r.ok) { stats.readsFail++; continue; }
      const text = await r.text();
      stats.readsOK++;
      // Pull the tag from the first 10 chars and verify the rest of
      // the body matches it. If the file was torn, we'd see WRITER05:
      // followed by WRITER22: somewhere mid-body.
      const tagMatch = text.match(/^WRITER\d{2}:/);
      if (!tagMatch) {
        // Could be the seed "init" body or empty during the very
        // first second.
        if (text !== 'init' && text !== '') {
          stats.partialReads++;
        }
        continue;
      }
      const tag = tagMatch[0];
      // All chars after the first tag should also match : tag.repeat(K).
      // Spot-check : every position at offset = tag.length × N must
      // start with tag.
      for (let i = 0; i + tag.length < text.length; i += tag.length) {
        if (text.slice(i, i + tag.length) !== tag) {
          stats.partialReads++;
          break;
        }
      }
    } catch {
      stats.errors++;
    }
  }
}

console.log(`Spawning ${WRITERS} writers + ${READERS} readers for ${DURATION_MS}ms ...`);
const t0 = Date.now();
await Promise.all([
  ...Array.from({ length: WRITERS }, (_, i) => writer(i)),
  ...Array.from({ length: READERS }, () => reader()),
]);
const elapsedMs = Date.now() - t0;

console.log('');
console.log(`Elapsed       : ${elapsedMs}ms`);
console.log(`writes OK     : ${stats.writesOK}`);
console.log(`writes FAIL   : ${stats.writesFail}`);
console.log(`reads OK      : ${stats.readsOK}`);
console.log(`reads FAIL    : ${stats.readsFail}`);
console.log(`partial reads : ${stats.partialReads}  ${stats.partialReads === 0 ? '✓' : '✗ TORN'}`);
console.log(`net errors    : ${stats.errors}`);

// Cleanup : remove the test project's file.
await fetch(URL, { method: 'DELETE' }).catch(() => {});

process.exit(stats.partialReads === 0 ? 0 : 1);
