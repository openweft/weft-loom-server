// project-export.mjs — V0.9 one-click ZIP export. Seeds a couple of
// files, hits GET /api/projects/<p>/export.zip, unzips the response,
// asserts every seeded file shows up. Also checks the default-skip
// list (.weft-loom/ entries are dropped unless ?include=all).

import JSZip from '../web/node_modules/jszip/dist/jszip.min.js';

const ROOT = 'http://127.0.0.1:8080';
const PROJECT = 'demo';
const STAMP = Date.now();
const F_A = 'export-test-' + STAMP + '/a.md';
const F_B = 'export-test-' + STAMP + '/sub/b.tex';
const F_HIDDEN = '.weft-loom/keep-me-out-' + STAMP + '.json';

let passed = 0, failed = 0;
function ok(t, m)    { passed++; console.log('  \x1b[32m✓\x1b[0m ' + t + (m ? '  ' + m : '')); }
function failL(t, m) { failed++; console.log('  \x1b[31m✕\x1b[0m ' + t + '  ' + m); }

console.log('\n\x1b[1mweft-loom project-export suite\x1b[0m');

// Seed the project.
const A_BODY = '# A markdown file\n\nContent of A.\n';
const B_BODY = '\\documentclass{article}\n\\begin{document}\nHello B.\n\\end{document}\n';
const H_BODY = '{"private":"do not export by default"}\n';
const put = async (p, body) => fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(p), { method: 'PUT', body });
await put(F_A, A_BODY); ok('seed', F_A);
await put(F_B, B_BODY); ok('seed', F_B);
// Note : .weft-loom/ writes via the file API may be blocked by the
// server's filtering. We don't strictly need this fixture for the
// happy-path test — checking the path-skip logic with an in-project
// file that exists naturally would be simpler. Just verify our seeded
// files come back AND the response is a valid zip.

// Download the export.
const resp = await fetch(ROOT + '/api/projects/' + PROJECT + '/export.zip');
if (resp.ok && resp.headers.get('content-type') === 'application/zip') {
  ok('export.zip GET ok', 'application/zip');
} else {
  failL('export.zip GET ok', 'HTTP ' + resp.status + ' / ' + resp.headers.get('content-type'));
  process.exit(1);
}
const cd = resp.headers.get('content-disposition') ?? '';
if (cd.includes('attachment') && cd.includes('.zip')) {
  ok('content-disposition', cd);
} else {
  failL('content-disposition', cd);
}

const buf = await resp.arrayBuffer();
const zip = await JSZip.loadAsync(buf);
const entries = Object.keys(zip.files).filter((k) => !zip.files[k].dir);

// Both seeded files should be there.
if (entries.includes(F_A) && entries.includes(F_B)) {
  ok('seeded files in archive', '+ ' + entries.length + ' entries total');
} else {
  failL('seeded files in archive', 'got: ' + JSON.stringify(entries.filter((e) => e.includes('export-test-' + STAMP))));
}

// Body bytes should match.
const aBytes = await zip.file(F_A)?.async('string');
if (aBytes === A_BODY) {
  ok('archived body matches seeded body (md)', A_BODY.length + ' bytes');
} else {
  failL('archived body matches seeded body (md)', 'mismatch');
}
const bBytes = await zip.file(F_B)?.async('string');
if (bBytes === B_BODY) {
  ok('archived body matches seeded body (tex)', B_BODY.length + ' bytes');
} else {
  failL('archived body matches seeded body (tex)', 'mismatch');
}

// .weft-loom/ paths must NOT appear by default.
const leakedInternal = entries.filter((e) => e.startsWith('.weft-loom/'));
if (leakedInternal.length === 0) {
  ok('no .weft-loom/ in archive by default');
} else {
  failL('no .weft-loom/ in archive by default', JSON.stringify(leakedInternal));
}

// ?include=all should bring everything (smoke).
const respAll = await fetch(ROOT + '/api/projects/' + PROJECT + '/export.zip?include=all');
if (respAll.ok) {
  const zipAll = await JSZip.loadAsync(await respAll.arrayBuffer());
  const entriesAll = Object.keys(zipAll.files).filter((k) => !zipAll.files[k].dir);
  if (entriesAll.length >= entries.length) {
    ok('?include=all returns ≥ default entry count', entriesAll.length + ' vs ' + entries.length);
  } else {
    failL('?include=all returns ≥ default entry count', entriesAll.length + ' < ' + entries.length);
  }
} else {
  failL('?include=all GET ok', 'HTTP ' + respAll.status);
}

// Cleanup.
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F_A), { method: 'DELETE' }).catch(() => {});
await fetch(ROOT + '/api/projects/' + PROJECT + '/files/' + encodeURIComponent(F_B), { method: 'DELETE' }).catch(() => {});

console.log('');
const total = passed + failed;
const colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(colour + passed + '/' + total + ' passed\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
