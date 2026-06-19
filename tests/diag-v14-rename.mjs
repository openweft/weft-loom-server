// diag-v14-rename.mjs — project rename via PUT-then-rename.

const ROOT = 'http://127.0.0.1:8080';

// Seed a throwaway project we can rename without disturbing demo.
const SRC = 'puppeteer-rename-src-' + Date.now();
const DST = 'puppeteer-rename-dst-' + Date.now();

await fetch(ROOT + '/api/projects/' + SRC + '/files/main.tex', {
  method: 'PUT',
  body: 'hello',
});

const before = await fetch(ROOT + '/api/projects').then(r => r.json());
console.log('before rename — src present:',
  before.items.some(p => p.name === SRC), 'dst present:',
  before.items.some(p => p.name === DST));

const renamed = await fetch(ROOT + '/api/projects/' + SRC + '/rename', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ newName: DST }),
}).then(r => r.json());
console.log('rename returned name:', renamed.name);

const after = await fetch(ROOT + '/api/projects').then(r => r.json());
console.log('after rename — src present:',
  after.items.some(p => p.name === SRC), 'dst present:',
  after.items.some(p => p.name === DST));

// Cleanup : delete the file (project disappears when last file goes).
await fetch(ROOT + '/api/projects/' + DST + '/files/main.tex', { method: 'DELETE' });
