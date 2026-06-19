// stress-loom.mjs — concurrent load on loom-server endpoints.
// Spawns N workers each hammering a mix of operations for a fixed
// duration. Watches : status codes histogram, latency percentiles,
// rate-limit 429 trips, any unexpected 5xx.

const ROOT = 'http://127.0.0.1:8080';
const WORKERS = 50;
const DURATION_MS = 30_000;

const opsCatalog = [
  // listing : cheap GETs that hit the typed huma path
  { name: 'listProjects', go: () => fetch(ROOT + '/api/projects') },
  { name: 'listFiles', go: () => fetch(ROOT + '/api/projects/demo/files') },
  { name: 'listSharing', go: () => fetch(ROOT + '/api/projects/demo/sharing') },
  { name: 'listSnippets', go: () => fetch(ROOT + '/api/projects/demo/snippets') },
  { name: 'getPublicShare', go: () => fetch(ROOT + '/api/projects/demo/public-share') },
  { name: 'healthz', go: () => fetch(ROOT + '/api/healthz') },
  { name: 'lspList', go: () => fetch(ROOT + '/api/lsp') },
  // sharing upsert + delete : mutation churn
  {
    name: 'shareChurn',
    go: async () => {
      const user = `stress-${Math.random().toString(36).slice(2, 8)}`;
      await fetch(ROOT + '/api/projects/demo/sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, role: 'viewer' }),
      });
      return fetch(ROOT + '/api/projects/demo/sharing/' + user, { method: 'DELETE' });
    },
  },
  // snippets churn : upsert + delete to hit the writer side
  {
    name: 'snippetsChurn',
    go: async () => {
      const created = await fetch(ROOT + '/api/projects/demo/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'S', body: '\\stress' }),
      }).then(r => r.json());
      if (created?.id) {
        return fetch(ROOT + '/api/projects/demo/snippets/' + created.id, { method: 'DELETE' });
      }
      return { status: 0 };
    },
  },
  // arxiv : the rate-limited external proxy
  { name: 'arxivSearch', go: () => fetch(ROOT + '/api/arxiv/search?q=test&max=1') },
];

const stats = {
  total: 0,
  byStatus: new Map(),
  byOp: new Map(),
  latencies: [],
  errors: 0,
};

async function worker(id) {
  const stopAt = Date.now() + DURATION_MS;
  while (Date.now() < stopAt) {
    const op = opsCatalog[Math.floor(Math.random() * opsCatalog.length)];
    const t0 = Date.now();
    try {
      const r = await op.go();
      const dt = Date.now() - t0;
      stats.total++;
      stats.latencies.push(dt);
      const s = String(r.status || 0);
      stats.byStatus.set(s, (stats.byStatus.get(s) || 0) + 1);
      const key = `${op.name}:${s}`;
      stats.byOp.set(key, (stats.byOp.get(key) || 0) + 1);
    } catch (e) {
      stats.errors++;
      stats.total++;
    }
  }
}

console.log(`Spawning ${WORKERS} workers for ${DURATION_MS}ms ...`);
const t0 = Date.now();
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
const elapsedMs = Date.now() - t0;

stats.latencies.sort((a, b) => a - b);
const p = (q) => stats.latencies[Math.floor(stats.latencies.length * q)];

console.log('');
console.log(`Total requests : ${stats.total} in ${elapsedMs}ms (${(stats.total / (elapsedMs / 1000)).toFixed(0)} req/s)`);
console.log(`Errors (network) : ${stats.errors}`);
console.log('');
console.log('By status :');
for (const [s, n] of [...stats.byStatus.entries()].sort()) {
  console.log(`  ${s} : ${n}`);
}
console.log('');
console.log('Latency (ms) :');
console.log(`  p50 ${p(0.50)} ; p95 ${p(0.95)} ; p99 ${p(0.99)} ; max ${stats.latencies[stats.latencies.length - 1]}`);
console.log('');
console.log('By op:status (rate-limit indicators) :');
for (const [k, n] of [...stats.byOp.entries()].sort()) {
  if (k.includes(':429') || k.includes(':5')) {
    console.log(`  ${k} : ${n}`);
  }
}

// Pass/fail summary : any 5xx is a real failure.
const fiveXX = [...stats.byStatus.entries()]
  .filter(([s]) => s.startsWith('5'))
  .reduce((a, [, n]) => a + n, 0);
console.log('');
console.log(`5xx total : ${fiveXX} ${fiveXX === 0 ? '✓' : '✗'}`);
console.log(`network errors : ${stats.errors} ${stats.errors === 0 ? '✓' : '✗'}`);
process.exit(fiveXX === 0 && stats.errors === 0 ? 0 : 1);
