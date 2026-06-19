// diag-v14-public-share.mjs — public-share lifecycle smoke :
// create token, fetch /public/{token}/files no-auth, revoke.

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';

// Revoke any pre-existing token so the test starts clean.
await fetch(ROOT + '/api/projects/' + PROJECT + '/public-share', { method: 'DELETE' }).catch(() => {});

const create = await fetch(ROOT + '/api/projects/' + PROJECT + '/public-share', {
  method: 'POST',
}).then(r => r.json());
console.log('public-share.create token len:', create.token?.length, 'url:', create.url);

const lookup = await fetch(ROOT + '/api/projects/' + PROJECT + '/public-share').then(r => r.json());
console.log('public-share.get same token:', lookup.token === create.token);

const pub = await fetch(ROOT + '/public/' + create.token + '/files').then(r => ({ status: r.status }));
console.log('public no-auth /files status:', pub.status);

// Confirm .git/ is hidden (security fix from earlier).
const items = await fetch(ROOT + '/public/' + create.token + '/files').then(r => r.json());
const anyGit = (items.items || []).some(i => i.path.startsWith('.git'));
console.log('git/ hidden on public path:', !anyGit);

const del = await fetch(ROOT + '/api/projects/' + PROJECT + '/public-share', { method: 'DELETE' });
console.log('public-share.delete status:', del.status);

const after = await fetch(ROOT + '/api/projects/' + PROJECT + '/public-share');
console.log('public-share.get after delete status (want 404):', after.status);
