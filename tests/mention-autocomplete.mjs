// mention-autocomplete.mjs — unit tests for the @-mention autocomplete
// helpers used by CommentsPanel. Pure-JS : we import the .ts module
// directly (Node 24 strips TS types natively), no esbuild bundle, no
// browser. Awareness is mocked with a small stand-in carrying just the
// surface getMentionCandidates touches : `clientID` + `getStates()`.
//
// Run :
//   cd weft-loom-server && \
//   export PATH=/opt/homebrew/opt/node@24/bin:$PATH && \
//   node --test tests/mention-autocomplete.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(
  __dirname,
  '..',
  'web',
  'src',
  'lib',
  'mentionAutocomplete.ts',
);

const {
  getMentionCandidates,
  getMentionPrefix,
  filterMentions,
  applyMention,
  extractMentionedClientIDs,
} = await import(modPath);

// ─── tiny Awareness stand-in ─────────────────────────────────────
//
// y-protocols/awareness exposes `clientID` + `getStates(): Map<number, state>`
// — that's the only surface getMentionCandidates uses, so we mock it
// with a plain Map. The `on/off` shape isn't exercised here (only
// CommentsPanel.svelte subscribes), so we leave it out.
function fakeAwareness(localID, states) {
  const map = new Map(states);
  return {
    clientID: localID,
    getStates: () => map,
  };
}

test('getMentionCandidates returns peers excluding local', () => {
  const aw = fakeAwareness(1, [
    [1, { user: { name: 'Me',    color: '#000' } }],
    [2, { user: { name: 'Alice', color: '#f00' } }],
    [3, { user: { name: 'Bob',   color: '#0f0' } }],
  ]);
  const cands = getMentionCandidates(aw, aw.clientID);
  assert.equal(cands.length, 2);
  const names = cands.map((c) => c.name).sort();
  assert.deepEqual(names, ['Alice', 'Bob']);
  // local is NOT included
  assert.ok(!cands.find((c) => c.clientID === 1));
});

test('getMentionCandidates skips peers without user.name', () => {
  const aw = fakeAwareness(1, [
    [2, { user: { name: 'Alice', color: '#f00' } }],
    [3, { /* no user */ } ],
    [4, { user: { color: '#0f0' /* no name */ } }],
  ]);
  const cands = getMentionCandidates(aw, aw.clientID);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].name, 'Alice');
});

test('getMentionCandidates returns names sorted', () => {
  const aw = fakeAwareness(1, [
    [2, { user: { name: 'Charlie' } }],
    [3, { user: { name: 'Alice' } }],
    [4, { user: { name: 'Bob' } }],
  ]);
  const cands = getMentionCandidates(aw, aw.clientID);
  assert.deepEqual(cands.map((c) => c.name), ['Alice', 'Bob', 'Charlie']);
});

test('getMentionPrefix("hello @al", 9) → "al"', () => {
  assert.equal(getMentionPrefix('hello @al', 9), 'al');
});

test('getMentionPrefix("hello world", 11) → null', () => {
  assert.equal(getMentionPrefix('hello world', 11), null);
});

test('getMentionPrefix returns empty string right after a bare @', () => {
  assert.equal(getMentionPrefix('hello @', 7), '');
});

test('getMentionPrefix returns null inside an email-like token', () => {
  // The `@` is preceded by a non-whitespace char, so it shouldn't trigger.
  assert.equal(getMentionPrefix('email@example.com', 17), null);
});

test('getMentionPrefix returns null when caret is mid-word past @token', () => {
  // caret is past the next space — the @-token is closed.
  assert.equal(getMentionPrefix('@alice and bob', 14), null);
});

test('getMentionPrefix triggers at start-of-string', () => {
  assert.equal(getMentionPrefix('@al', 3), 'al');
});

test('filterMentions(["alice", "bob"], "al") → just alice', () => {
  const candidates = [
    { clientID: 1, name: 'alice', color: '#f00' },
    { clientID: 2, name: 'bob',   color: '#0f0' },
  ];
  const got = filterMentions(candidates, 'al');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'alice');
});

test('filterMentions is case-insensitive', () => {
  const candidates = [
    { clientID: 1, name: 'Alice', color: '#f00' },
    { clientID: 2, name: 'Bob',   color: '#0f0' },
  ];
  const got = filterMentions(candidates, 'AL');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'Alice');
});

test('filterMentions empty prefix returns all', () => {
  const candidates = [
    { clientID: 1, name: 'Alice', color: '#f00' },
    { clientID: 2, name: 'Bob',   color: '#0f0' },
  ];
  assert.equal(filterMentions(candidates, '').length, 2);
});

test('applyMention("hello @al", 9, "alice") → "hello @alice ", caret at end of insert', () => {
  const r = applyMention('hello @al', 9, 'alice');
  assert.equal(r.value, 'hello @alice ');
  // "hello @alice " is 13 chars ; caret lands just past the trailing
  // space (position 13). The original task brief said `caret=14` which
  // is off-by-one — we follow the math (end-of-insert = string length
  // when no suffix remains).
  assert.equal(r.caret, 13);
  assert.equal(r.value.length, 13);
});

test('applyMention inserts trailing space + positions caret after it', () => {
  const r = applyMention('@al', 3, 'alice');
  assert.equal(r.value, '@alice ');
  assert.equal(r.caret, 7);
});

test('applyMention preserves text after caret', () => {
  const r = applyMention('hi @al world', 6, 'alice');
  // "hi " + "@alice " + "world" — the @al before caret 6 ("hi @al")
  // gets replaced with "@alice " then the trailing " world" stays.
  assert.equal(r.value, 'hi @alice  world');
  assert.equal(r.caret, 10);
});

test('applyMention no-ops when no open mention at caret', () => {
  const r = applyMention('hello world', 11, 'alice');
  assert.equal(r.value, 'hello world');
  assert.equal(r.caret, 11);
});

test('extractMentionedClientIDs picks up known names + dedupes', () => {
  const cands = [
    { clientID: 42, name: 'Alice', color: '#f00' },
    { clientID: 99, name: 'Bob',   color: '#0f0' },
  ];
  const ids = extractMentionedClientIDs('hey @Alice + @Bob, @Alice again', cands);
  assert.deepEqual(ids.sort(), ['42', '99']);
});

test('extractMentionedClientIDs ignores unknown names', () => {
  const cands = [
    { clientID: 42, name: 'Alice', color: '#f00' },
  ];
  const ids = extractMentionedClientIDs('hi @ghost', cands);
  assert.deepEqual(ids, []);
});

test('extractMentionedClientIDs ignores email-like @ tokens', () => {
  const cands = [
    { clientID: 42, name: 'example.com', color: '#f00' },
  ];
  // `me@example.com` — the @ has a non-whitespace char before it
  // so the MENTION_TOKEN_RE won't capture `example.com` as a mention.
  const ids = extractMentionedClientIDs('reach me at me@example.com', cands);
  assert.deepEqual(ids, []);
});
