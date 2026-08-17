// minimal-edit.mjs — the WYSIWYG's whole-document difference, as one edit.
//
// Two things have to hold, and the second is the one that bites:
//
//   1. Applying the edit to `before` gives `after`. Exactly, for every pair.
//   2. No offset it produces falls between the halves of a surrogate pair.
//      collab refuses such an offset rather than rounding it — correctly — so
//      an edit that asks for one is an edit the editor cannot send.
//
// Both are checked against a random sweep rather than a handful of cases,
// because the interesting inputs here are the ones nobody thinks to write down:
// an emoji at the seam, a change that is only a deletion, two strings that
// share everything but one code unit in the middle of a character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../web/src/lib/minimal-edit.ts'), 'utf8');
const built = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node20' });
const mod = { exports: {} };
new Function('module', 'exports', built.code)(mod, mod.exports);
const { minimalEdit } = mod.exports;

const apply = (s, e) => (e ? s.slice(0, e.pos) + e.insert + s.slice(e.pos + e.removed) : s);

const splitsAPair = (s, at) => {
  if (at <= 0 || at >= s.length) return false;
  const hi = s.charCodeAt(at - 1),
    lo = s.charCodeAt(at);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
};

// Every offset the edit names, on both strings it names them against.
const boundaries = (before, after, e) => {
  if (!e) return [];
  return [
    [before, e.pos],
    [before, e.pos + e.removed],
    [after, e.pos],
    [after, e.pos + e.insert.length],
  ];
};

const check = (before, after, what) => {
  const e = minimalEdit(before, after);
  assert.equal(apply(before, e), after, `${what}: applying the edit did not give "after"`);
  for (const [s, at] of boundaries(before, after, e)) {
    assert.ok(!splitsAPair(s, at), `${what}: offset ${at} splits a surrogate pair`);
  }
  return e;
};

test('an unchanged document produces no edit', () => {
  assert.equal(minimalEdit('', ''), undefined);
  assert.equal(minimalEdit('hello', 'hello'), undefined);
});

test('a keystroke in the middle is one character wide', () => {
  const e = check('the quick fox', 'the quick red fox', 'insert');
  assert.equal(e.removed, 0);
  assert.equal(e.insert, 'red ');
  // The point of the whole exercise: bounded by the change, not by the file.
  assert.ok(e.insert.length < 'the quick red fox'.length);
});

test('a deletion carries nothing', () => {
  const e = check('the quick red fox', 'the quick fox', 'delete');
  assert.equal(e.insert, '');
  assert.equal(e.removed, 4);
});

test('a replacement touches only what differs', () => {
  const e = check('\\section{Old}', '\\section{New}', 'replace');
  assert.equal(e.removed, 3);
  assert.equal(e.insert, 'New');
});

test('emptying and filling still work', () => {
  check('something', '', 'empty it');
  check('', 'something', 'fill it');
});

test('an edit beside an emoji does not cut it in half', () => {
  // The seam is exactly where the naive prefix walk wants to stop: the two
  // strings share the emoji's high half and differ in what follows.
  check('a😀b', 'a😀c', 'after the emoji');
  check('a😀b', 'ab', 'the emoji removed');
  check('ab', 'a😀b', 'an emoji inserted');
  check('😀😀', '😀', 'one of two emoji');
  // Two different astral characters sharing a high surrogate would be the
  // cruellest case; U+1F600 and U+1F601 do exactly that.
  const e = check('x😀y', 'x😁y', 'two emoji sharing a high surrogate');
  assert.equal(e.insert, '😁');
  assert.equal(e.removed, 2);
});

test('a random sweep never produces an offset collab would refuse', () => {
  // A tiny alphabet, so collisions and shared prefixes happen constantly, and
  // astral characters that share a high surrogate so the seam is hit often.
  const alphabet = ['a', 'b', '\n', '\\', '😀', '😁', '𝔸'];
  // Deterministic: a test that fails one run in fifty is not a test.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const str = (n) => {
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[(rand() * alphabet.length) | 0];
    return out;
  };
  for (let i = 0; i < 20000; i++) {
    const before = str((rand() * 12) | 0);
    const after = str((rand() * 12) | 0);
    check(before, after, `sweep ${i}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }
});

test('a sweep of small mutations, which is what typing looks like', () => {
  const alphabet = ['a', 'b', 'c', ' ', '😀', '𝔸'];
  let seed = 999;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let doc = 'a document with 😀 in it';
  for (let i = 0; i < 20000; i++) {
    const at = (rand() * (doc.length + 1)) | 0;
    const ch = alphabet[(rand() * alphabet.length) | 0];
    // Splice at a raw code-unit offset on purpose: this is how a mangled
    // document would arise, and the edit still must not name a bad offset.
    const next = rand() < 0.5 ? doc.slice(0, at) + ch + doc.slice(at) : doc.slice(0, at) + doc.slice(at + 1);
    check(doc, next, `mutation ${i}`);
    doc = next;
    if (doc.length > 60) doc = doc.slice(0, 20);
  }
});
