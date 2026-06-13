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
}

export function commentsArray(ydoc: Y.Doc, file: string) {
  return ydoc.getArray<CommentRecord>('comments:' + file);
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
