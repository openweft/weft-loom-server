// diag-v14-snippets.mjs — user snippets CRUD lifecycle.

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';

const initial = await fetch(ROOT + '/api/projects/' + PROJECT + '/snippets').then(r => r.json());
console.log('snippets.list initial keys:', Object.keys(initial));

const created = await fetch(ROOT + '/api/projects/' + PROJECT + '/snippets', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: 'Smoke test', body: '\\\\smoketest{x}', hotkey: 'st' }),
}).then(r => r.json());
console.log('snippets.upsert id:', !!created.id, 'label:', created.label);

const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/snippets').then(r => r.json());
console.log('snippets.list contains new:',
  Array.isArray(after.snippets) && after.snippets.some(s => s.id === created.id));

const del = await fetch(ROOT + '/api/projects/' + PROJECT + '/snippets/' + created.id, { method: 'DELETE' });
console.log('snippets.delete status:', del.status);

const final = await fetch(ROOT + '/api/projects/' + PROJECT + '/snippets').then(r => r.json());
console.log('snippets.list after delete excludes:',
  Array.isArray(final.snippets) && final.snippets.every(s => s.id !== created.id));
