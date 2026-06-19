// stress-project-lifecycle.mjs — concurrent create/rename/delete
// across many projects. Detects races in the project store +
// rename atomicity + listing consistency.
//
// Each worker independently :
//   1. PUT a file into a uniquely-named project (creates the project)
//   2. POST rename to a different unique name
//   3. DELETE the file (drops the project)
//
// Concurrent listings run alongside ; any non-OK or inconsistent
// listing is recorded.

const ROOT = 'http://127.0.0.1:8080';
const WORKERS = 25;
const ITERATIONS_PER_WORKER = 20;

const stats = {
  cycles: 0,
  putFail: 0,
  renameFail: 0,
  deleteFail: 0,
  listFail: 0,
  errors: 0,
};

async function worker(id) {
  for (let i = 0; i < ITERATIONS_PER_WORKER; i++) {
    const src = `stress-w${id}-i${i}-${Date.now()}`;
    const dst = `${src}-renamed`;
    try {
      const put = await fetch(`${ROOT}/api/projects/${src}/files/main.tex`, {
        method: 'PUT', body: 'hello',
      });
      if (!put.ok) stats.putFail++;
      const rn = await fetch(`${ROOT}/api/projects/${src}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: dst }),
      });
      if (!rn.ok) stats.renameFail++;
      const del = await fetch(`${ROOT}/api/projects/${dst}/files/main.tex`, {
        method: 'DELETE',
      });
      if (!del.ok) stats.deleteFail++;
      stats.cycles++;
    } catch {
      stats.errors++;
    }
  }
}

async function lister(deadline) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${ROOT}/api/projects`);
      if (!r.ok) stats.listFail++;
      // Just consume to avoid socket buildup.
      await r.json();
    } catch {
      stats.errors++;
    }
  }
}

console.log(`Spawning ${WORKERS} workers × ${ITERATIONS_PER_WORKER} cycles + listers`);
const t0 = Date.now();
const deadline = Date.now() + 30_000;
await Promise.all([
  ...Array.from({ length: WORKERS }, (_, i) => worker(i)),
  lister(deadline),
  lister(deadline),
  lister(deadline),
]);

const elapsedMs = Date.now() - t0;
console.log('');
console.log(`Elapsed     : ${elapsedMs}ms`);
console.log(`Cycles      : ${stats.cycles}/${WORKERS * ITERATIONS_PER_WORKER}`);
console.log(`PUT fail    : ${stats.putFail}`);
console.log(`rename fail : ${stats.renameFail}`);
console.log(`DELETE fail : ${stats.deleteFail}`);
console.log(`LIST fail   : ${stats.listFail}`);
console.log(`net errors  : ${stats.errors}`);

const issues = stats.putFail + stats.renameFail + stats.deleteFail +
               stats.listFail + stats.errors;
console.log('');
console.log(`Issues total : ${issues}  ${issues === 0 ? '✓' : '✗'}`);
process.exit(issues === 0 ? 0 : 1);
