// comments.ts — collaborative comments / threaded annotations on
// any text file edited in loom. Backed by a Y.Array on the same
// Y.Doc the editor uses, so peers see comments instantly + edits
// to the source rebase comment anchors via Yjs RelativePosition.
//
// Storage layout
//
//   ydoc.getArray<CommentRecord>('comments:<file-path>')
//
// per-file array (decoupled from the file's Y.Text so we can
// observe + render without taking a snapshot of the whole text).
//
// A CommentRecord travels through Yjs as a plain object. The
// `from` / `to` fields are RelativePosition bytes (`Uint8Array`
// encoded as a regular array of numbers — Yjs serialises arrays
// transparently, and Uint8Array survives but can be flaky across
// JSON round-trips, so we keep number[]).

import * as Y from 'yjs';

export interface CommentRecord {
  id: string;
  // Anchors expressed as relative positions on the file's Y.Text
  // so concurrent edits rebase the underlying offsets. Encoded as
  // number[] (the byte stream Yjs's createRelativePositionFromTypeIndex
  // emits, then `encodeRelativePosition` serialises).
  from: number[];
  to: number[];
  // Plain-text body + author identity + timestamp. Body is plain
  // text in V0.1 ; markdown / threaded replies land later.
  body: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  // Resolved comments stay visible (faded) until the user explicitly
  // deletes them. Mirrors Overleaf's "resolve" gesture.
  resolved: boolean;
  ts: number;
  // V0.7 threaded comments : when set, this comment is a reply to
  // another comment in the same array. Top-level comments (thread
  // roots) leave it undefined. Replies don't carry their own from/to
  // anchors — the renderer falls back to the root's range.
  parentId?: string;
  // V0.8 @-mentions : clientIDs (as strings, since Awareness clientID
  // is a number but Y.Map serialises bigint-ish keys to JSON strings
  // anyway) of peers that were @-mentioned in this comment's body.
  // Persisted so a future notification dispatcher can fan-out alerts
  // without re-scanning every body. Empty / missing on legacy records.
  mentions?: string[];
}

// Comments live as a Y.Array of Y.Map<field,value>. Each comment is a
// small Y.Map so the 'resolved' boolean can flip via cmap.set() — no
// delete+insert dance, no duplicate records on concurrent toggle.
export function commentsArray(ydoc: Y.Doc, file: string) {
  return ydoc.getArray<Y.Map<unknown>>('comments:' + file);
}

// Wrap a plain CommentRecord into a Y.Map so it can be pushed into the
// CRDT array. Field-level mutations (toggleResolved) are then conflict-
// free across peers.
export function newCommentMap(rec: CommentRecord): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', rec.id);
  m.set('from', rec.from);
  m.set('to', rec.to);
  m.set('body', rec.body);
  m.set('authorId', rec.authorId);
  m.set('authorName', rec.authorName);
  m.set('authorColor', rec.authorColor);
  m.set('resolved', rec.resolved);
  m.set('ts', rec.ts);
  if (rec.parentId) m.set('parentId', rec.parentId);
  if (rec.mentions && rec.mentions.length > 0) m.set('mentions', rec.mentions);
  return m;
}

// Snapshot a Y.Map<comment-field> back to a plain CommentRecord for the
// Svelte render path. Uses toJSON() to keep number[] anchors intact.
export function commentFromMap(m: Y.Map<unknown>): CommentRecord {
  const j = m.toJSON() as CommentRecord;
  return j;
}

// Helpers : encode + decode RelativePosition ↔ number[] so we can
// store anchors in Yjs arrays cleanly.
export function encodeRP(rp: Y.RelativePosition): number[] {
  const u = Y.encodeRelativePosition(rp);
  return Array.from(u);
}

export function decodeRP(arr: number[] | Uint8Array): Y.RelativePosition {
  const u = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
  return Y.decodeRelativePosition(u);
}

// Resolve a CommentRecord's anchors to current absolute offsets on
// the live ytext. Returns null when the anchors no longer resolve
// (e.g. the surrounding text was deleted) — the caller can choose
// to hide the comment or render it as "orphan".
export function resolveAnchors(
  ydoc: Y.Doc,
  ytext: Y.Text,
  rec: CommentRecord,
): { from: number; to: number } | null {
  try {
    const fromAbs = Y.createAbsolutePositionFromRelativePosition(decodeRP(rec.from), ydoc);
    const toAbs   = Y.createAbsolutePositionFromRelativePosition(decodeRP(rec.to),   ydoc);
    if (!fromAbs || !toAbs) return null;
    if (fromAbs.type !== ytext || toAbs.type !== ytext) return null;
    return { from: fromAbs.index, to: toAbs.index };
  } catch {
    return null;
  }
}

// genId returns a short, sortable id. The timestamp prefix keeps
// comments listed in chronological order without an explicit sort
// step.
export function genId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return t + '-' + r;
}
