// diag-v14-sharing.mjs — sharing CRUD round-trip via the typed
// huma endpoint. Pure fetch (no UI navigation) so the test isolates
// the typed contract from any SPA wiring.

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';

const list1 = await fetch(ROOT + '/api/projects/' + PROJECT + '/sharing').then(r => r.json());
console.log('sharing.list initial keys:', Object.keys(list1));

const up = await fetch(ROOT + '/api/projects/' + PROJECT + '/sharing', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'puppeteer-bot', role: 'commenter' }),
});
console.log('sharing.upsert status:', up.status);

const list2 = await fetch(ROOT + '/api/projects/' + PROJECT + '/sharing').then(r => r.json());
console.log('sharing.list after upsert:',
  Array.isArray(list2.shares) && list2.shares.some(s => s.user === 'puppeteer-bot'));

const del = await fetch(ROOT + '/api/projects/' + PROJECT + '/sharing/puppeteer-bot', { method: 'DELETE' });
console.log('sharing.delete status:', del.status);

const list3 = await fetch(ROOT + '/api/projects/' + PROJECT + '/sharing').then(r => r.json());
console.log('sharing.list after delete:',
  Array.isArray(list3.shares) && list3.shares.every(s => s.user !== 'puppeteer-bot'));
