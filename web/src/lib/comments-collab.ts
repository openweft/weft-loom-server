// comments-collab.ts — comments on a file, on go-crdt/collab.
//
// # Why a part per comment
//
// The Yjs version keeps comments as a Y.Array of Y.Map, and says why: "Each
// comment is a small Y.Map so the 'resolved' boolean can flip via cmap.set() —
// no delete+insert dance, no duplicate records on concurrent toggle." That is
// the right requirement and it needed a nested CRDT to meet.
//
// collab does not nest, and does not need to. A document holds named parts, and
// a part exists because operations for it exist — so each comment is a map part
// of its own, `comment:<id>`, and a list part holds the order. Flipping
// `resolved` is then a Set on that part: one record, conflict-free, and no
// duplicate if two people resolve the same comment at the same moment. The
// property survives; the nesting is not needed to get it.
//
// A comment deleted leaves its map part behind, holding nothing anybody reads.
// That is the same bargain a tombstone is, and the same one Yjs made.
//
// # Anchors
//
// Yjs stored a RelativePosition as number[] and resolved it to an offset,
// returning null when it no longer resolved — which conflated "this comment is
// on text that was deleted" with "I cannot tell you". collab separates them:
// `position` reports where the character is *or was*, so a comment on a deleted
// sentence still knows where it belonged, and `visible` says whether the text is
// still there. A view can fade an orphan rather than lose it.

import { encode, decode, records, type List, type MapPart, type Session, type Text } from './collab';

/** The anchor collab hands back, which is what a comment holds onto. */
export interface Anchor {
  readonly site: string;
  readonly seq: string;
}

export interface CommentRecord {
  id: string;
  /** Where it starts and ends, as anchors on the file's text part. */
  from: Anchor;
  to: Anchor;
  body: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  /** Resolved comments stay visible, faded, until somebody deletes them. */
  resolved: boolean;
  ts: number;
  /** Set on a reply; a thread root leaves it undefined and owns the range. */
  parentId?: string;
  /** Replica identities that were @-mentioned, so a dispatcher need not re-scan. */
  mentions?: string[];
}

/** Where a comment sits now, and whether the text it is about is still there. */
export interface Resolved {
  from: number;
  to: number;
  /** False when the text was deleted: the comment knows where it belonged. */
  visible: boolean;
}

/** The list part holding the order of a file's comments. */
export function orderPart(file: string): string {
  return `comments:${file}`;
}

/** The map part holding one comment. */
export function commentPart(id: string): string {
  return `comment:${id}`;
}

/** The text part of a file, which is what a comment's anchors belong to. */
export function filePart(file: string): string {
  return `file:${file}`;
}

/**
 * genId returns a short, sortable id. The timestamp prefix keeps comments in
 * chronological order without a sort, and it is also the part name, so a
 * document's parts read in the order they were made.
 */
export function genId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/** The fields of a comment, as a map part holds them. */
const FIELDS = [
  'from',
  'to',
  'body',
  'authorId',
  'authorName',
  'authorColor',
  'resolved',
  'ts',
  'parentId',
  'mentions',
] as const;

/**
 * Writes a comment. Each field is its own key, which is the whole point: a
 * later change to one of them touches one key.
 */
export async function putComment(
  session: Session,
  file: string,
  rec: CommentRecord,
): Promise<void> {
  const part = await session.map(commentPart(rec.id));
  await Promise.all(
    FIELDS.filter((f) => rec[f] !== undefined).map((f) => part.set(f, encode(rec[f]))),
  );
  // The order goes last, so a comment is in the list only once it can be read.
  const order = await session.list(orderPart(file));
  if (!records<string>(order).includes(rec.id)) await order.append(encode(rec.id));
}

/** Reads one comment back, or undefined if this replica has none. */
export async function readComment(session: Session, id: string): Promise<CommentRecord | undefined> {
  const part = await session.map(commentPart(id));
  if (part.size === 0) return undefined;
  const rec: Record<string, unknown> = { id };
  for (const field of FIELDS) {
    const raw = await part.get(field);
    if (raw !== undefined) rec[field] = decode(raw);
  }
  return rec as unknown as CommentRecord;
}

/** Every comment on a file, in the order they were made. */
export async function readComments(session: Session, file: string): Promise<CommentRecord[]> {
  const order = await session.list(orderPart(file));
  const out: CommentRecord[] = [];
  for (const id of records<string>(order)) {
    const rec = await readComment(session, id);
    // An id in the order whose comment this replica has not got yet is skipped
    // rather than rendered empty: it will be there when its operations arrive.
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Flips a comment's resolved flag — the gesture this whole shape exists for.
 * One key, so two people doing it at once leave one comment rather than two.
 */
export async function setResolved(session: Session, id: string, resolved: boolean): Promise<void> {
  const part = await session.map(commentPart(id));
  await part.set('resolved', encode(resolved));
}

/**
 * Removes a comment from its file's order. The map part is left behind holding
 * what it held: nothing reads it, and taking it away would let an operation
 * still in flight bring the comment back.
 */
export async function removeComment(session: Session, file: string, id: string): Promise<void> {
  const order = await session.list(orderPart(file));
  const ids = records<string>(order);
  const at = ids.indexOf(id);
  if (at >= 0) await order.delete(at, 1);
}

/**
 * Where a comment sits in the text now.
 *
 * Undefined means this replica has never heard of the characters the anchors
 * name — not that they were deleted, which is what `visible` is for.
 */
export async function resolveAnchors(
  text: Text,
  rec: CommentRecord,
): Promise<Resolved | undefined> {
  const from = await text.position(rec.from);
  const to = await text.position(rec.to);
  if (from === undefined || to === undefined) return undefined;
  const visible = (await text.visible(rec.from)) && (await text.visible(rec.to));
  return { from: Math.min(from, to), to: Math.max(from, to), visible };
}

/** The anchors for a selection, which is what a new comment is made from. */
export async function anchorRange(
  text: Text,
  from: number,
  to: number,
): Promise<{ from: Anchor; to: Anchor }> {
  return { from: await text.anchor(from), to: await text.anchor(Math.max(from, to - 1)) };
}

export type { List, MapPart };
