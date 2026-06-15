// keymap-modes.mjs — smoke test for the editor keymap helper.
//
// editorKeymap.ts itself is TypeScript + uses dynamic imports against
// the web/ node_modules tree. Rather than pulling in a TS loader for
// node --test, we replicate the helper's three branches verbatim
// against the installed packages — this catches the cases that would
// actually break the helper at runtime :
//
//   1. 'default'  → resolves to []        (no-op compartment)
//   2. 'vim'      → resolves to a truthy, non-array-of-zero Extension
//   3. 'emacs'    → idem
//
// If npm install drifted or the upstream renamed `vim()` / `emacs()`
// the import here fails with the same error the browser would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// ESM dynamic import() resolves bare specifiers relative to the
// importing file's URL — `tests/` has no node_modules, so reach into
// `web/node_modules/<pkg>/<main>` by file URL instead. Keeps the test
// self-contained without symlinks or root-level npm install.
const WEB = fileURLToPath(new URL('../web', import.meta.url));
function pkgUrl(name, entry = 'dist/index.js') {
  return pathToFileURL(path.join(WEB, 'node_modules', name, entry)).href;
}

// Mirror loadKeymap() from web/src/lib/editorKeymap.ts. Kept in lock-
// step intentionally : if you change the helper's branching, mirror
// it here so the smoke test still exercises the right packages.
async function loadKeymap(mode) {
  switch (mode) {
    case 'default':
      return [];
    case 'vim': {
      const mod = await import(pkgUrl('@replit/codemirror-vim'));
      return mod.vim();
    }
    case 'emacs': {
      const mod = await import(pkgUrl('@replit/codemirror-emacs'));
      return mod.emacs();
    }
    default:
      throw new Error('unknown keymap mode: ' + mode);
  }
}

test("loadKeymap('default') returns []", async () => {
  const ext = await loadKeymap('default');
  assert.ok(Array.isArray(ext), 'expected an array');
  assert.equal(ext.length, 0, 'expected an empty extension list');
});

test("loadKeymap('vim') returns a non-empty extension", async () => {
  const ext = await loadKeymap('vim');
  assert.ok(ext, 'expected a truthy extension');
  // CodeMirror extensions are either a single Facet-bearing object
  // or an array of them. An empty array would be the smoking gun
  // that the upstream package shipped a no-op — fail loudly on it.
  if (Array.isArray(ext)) {
    assert.ok(ext.length > 0, 'vim extension is an empty array');
  }
});

test("loadKeymap('emacs') returns a non-empty extension", async () => {
  const ext = await loadKeymap('emacs');
  assert.ok(ext, 'expected a truthy extension');
  if (Array.isArray(ext)) {
    assert.ok(ext.length > 0, 'emacs extension is an empty array');
  }
});
