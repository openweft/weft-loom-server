// mentionAutocomplete.ts — @-mention autocomplete helpers for the
// CommentsPanel. Headless logic (no DOM, no Svelte) so it can be
// unit-tested with `node --test` and reused from any comment-style
// textarea (replies, future inline annotations, etc.).
//
// Data source : the Yjs Awareness object the Editor already exposes
// via `window.weftLoomAwareness`. Each peer's local state carries
//
//   user: { name?: string; color?: string; ... }
//
// (Editor.svelte writes that field on connect — see presence.ts +
// the awareness.setLocalStateField('user', …) call in Editor.svelte).
// We surface every remote peer carrying a name as a mention candidate ;
// the local peer is filtered out so authors don't @-mention themselves.
//
// The four exported helpers are deliberately small + pure :
//   - getMentionCandidates → snapshot peers
//   - getMentionPrefix     → did the user type `@…` ?
//   - filterMentions       → case-insensitive prefix narrowing
//   - applyMention         → splice a picked candidate into the textarea
//
// CommentsPanel.svelte composes them ; tests exercise each in isolation.

import type { Session } from './collab';

export interface MentionCandidate {
  /** The replica identity, which does not fit a number. */
  clientID: string;
  name: string;
  color: string;
}

// getMentionCandidates : everybody else the session says is here and has a
// name. Sorted, so the autocomplete order does not depend on what order the
// session happens to report them in.
export function getMentionCandidates(session: Session): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  const self = session.site;
  for (const peer of session.peers()) {
    if (peer.site === self) continue;
    const name = peer.meta?.name;
    if (!name) continue;
    out.push({
      clientID: peer.site,
      name,
      color: peer.meta?.color ?? '#888',
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// MENTION_TOKEN matches the trailing `@word` chunk on the current
// line/segment — letters, digits, dots, hyphens, underscores. The
// alternation handles the empty-prefix case ("@|" at caret) too. We
// scan the substring up-to-caret so the same value with caret in the
// middle of a word doesn't false-trigger.
//
// The lookbehind is emulated by checking the character BEFORE the `@`
// : it must be either start-of-string or a whitespace boundary, so
// `email@example.com` doesn't match the `@example` part as a mention.
const MENTION_RE = /(^|\s)@([\p{L}\p{N}._-]*)$/u;

// getMentionPrefix : look backwards from `caret` for an `@`-anchored
// token. Returns the substring typed AFTER the `@` (could be empty if
// the user just typed `@` and is about to type more), or null when
// the caret isn't following an open mention.
export function getMentionPrefix(value: string, caret: number): string | null {
  if (caret < 0 || caret > value.length) return null;
  const upTo = value.slice(0, caret);
  const m = MENTION_RE.exec(upTo);
  if (!m) return null;
  return m[2];
}

// filterMentions : case-insensitive prefix filter on candidate.name.
// We match on prefix (not "contains") because the autocomplete UX
// matches what the user is literally typing after the `@`. Stable
// order — candidates is already sorted.
export function filterMentions(
  candidates: MentionCandidate[],
  prefix: string,
): MentionCandidate[] {
  if (!prefix) return candidates.slice();
  const p = prefix.toLowerCase();
  return candidates.filter((c) => c.name.toLowerCase().startsWith(p));
}

// applyMention : the user picked `name` from the dropdown. We splice
// `@name ` (trailing space — Slack/Discord convention, gives the user
// a natural insertion point + signals end-of-token to the next
// getMentionPrefix call) over the `@prefix` chunk just before the
// caret. Returns the new value + the new caret offset (just after the
// inserted space).
//
// If there's no open mention at caret (caller bug), we no-op safely
// rather than corrupting the textarea.
export function applyMention(
  value: string,
  caret: number,
  name: string,
): { value: string; caret: number } {
  const upTo = value.slice(0, caret);
  const m = MENTION_RE.exec(upTo);
  if (!m) return { value, caret };
  // `m.index` is where the (^|\s) capture starts — we want to keep
  // that leading boundary char (if any) and replace from the `@`.
  const lead = m[1] ?? '';
  const atStart = m.index + lead.length;
  const before = value.slice(0, atStart);
  const after = value.slice(caret);
  const insert = '@' + name + ' ';
  const next = before + insert + after;
  return { value: next, caret: (before + insert).length };
}

// MENTION_TOKEN_RE — scans a finished comment body for every
// `@Name` token so CommentsPanel can persist the matching clientIDs.
// Mirrors MENTION_RE's character class. Exported so the panel can
// reuse the exact same definition when extracting mentions on Post.
export const MENTION_TOKEN_RE = /(?:^|\s)@([\p{L}\p{N}._-]+)/gu;

// extractMentionedClientIDs : given a finished body + the current
// candidate list, return the unique clientIDs whose name appears as
// an `@Name` token in the body. We match names case-insensitively to
// stay symmetric with the autocomplete filter ; duplicates are
// de-duplicated. Returns clientIDs as strings (Y.Map serialisation
// is happier with string keys than the bigint-ish JS number that
// Awareness uses for clientID — also matches the CommentRecord
// `mentions: string[]` spec).
export function extractMentionedClientIDs(
  body: string,
  candidates: MentionCandidate[],
): string[] {
  if (!body) return [];
  const byName = new Map<string, string>();
  for (const c of candidates) byName.set(c.name.toLowerCase(), c.clientID);
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  MENTION_TOKEN_RE.lastIndex = 0;
  while ((m = MENTION_TOKEN_RE.exec(body))) {
    const id = byName.get(m[1].toLowerCase());
    if (id !== undefined) found.add(String(id));
  }
  return Array.from(found);
}
