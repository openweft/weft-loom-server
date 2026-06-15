// wysiwygAuthorship.ts — track-changes log for the LaTeX WYSIWYG
// contenteditable surface. The companion to authorship.ts (which
// paints per-character authorship inside CodeMirror) but adapted
// to the structural reality of the WYSIWYG side : every local
// edit in LatexWysiwygEditor.pushToYtext() does a whole-doc
// replace on the Y.Text (delete(0, length) + insert(0, source)).
// That overwrites Yjs's per-character item.id.client history, so
// the source-walking trick authorship.ts uses returns "the last
// author who saved" for the whole document.
//
// V0.1 therefore takes a different path : a SEPARATE change-log
// Y.Array, one record per accepted local edit, recording the
// before+after source snapshots so the UI can show a redline
// diff + offer Accept (drop the record, source is already at
// `after`) or Reject (drop the record + rewrite the Y.Text back
// to `before`).
//
// Storage layout
//
//   ydoc.getArray<Y.Map<...>>('changelog:<file-path>')
//
// per-file array of Y.Maps. Each map carries one ChangeRecord
// (id, clientID, author, color, at, before, after, status). Using
// Y.Map for the per-record container keeps `status` mutable
// without delete+insert — a peer accepting while another rejects
// just races on a single key.
//
// Wire-up : LatexWysiwygEditor would call attachChangeLog(ydoc,
// file) after the Y.Doc is constructed in load(), then call
// log.recordChange(...) inside pushToYtext() just BEFORE the
// ytext.delete/insert pair (so `before` captures the pre-edit
// source and `after` the post-edit one). The component itself
// stays untouched per the V0.1 scope ; the API contract is :
// the caller decides WHEN to log, this module owns HOW.

import * as Y from 'yjs';

export interface ChangeRecord {
  id: string;             // uuid-ish
  clientID: number;       // who made the change
  author: string;         // their display name from awareness
  color: string;          // their display color
  at: number;             // Date.now()
  /** Source-level snapshot : the LaTeX source BEFORE and AFTER
   *  the change. Used to compute the diff for accept/reject UI. */
  before: string;
  after: string;
  /** Status : 'pending' = displayed as a track-change ; 'accepted'
   *  = baked into the doc + dropped from the log ; 'rejected' =
   *  rolled back to `before` + dropped. */
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ChangeLog {
  /** A Y.Array<ChangeRecord> stored on the ydoc. Sub-keyed so the
   *  WYSIWYG's "file:<path>" Y.Text + the "changelog:<path>" Y.Array
   *  live alongside in the same doc. */
  yarray: Y.Array<ChangeRecord>;
  /** All pending changes, ordered by `at` desc. */
  pending(): ChangeRecord[];
  /** Record a new pending change. */
  recordChange(clientID: number, author: string, color: string, before: string, after: string): void;
  /** Mark a change accepted ; the source is already at `after`, just
   *  drop it from the log. */
  accept(id: string): void;
  /** Reject a change ; the caller MUST then rewrite the Y.Text to
   *  the `before` value (only safe when the change is the LAST one,
   *  V0.1). Drops the record. */
  reject(id: string): void;
  /** Tear down observers + return the destroy fn from any listeners. */
  destroy: () => void;
}

// genChangeId : timestamp prefix keeps records sortable + a 4-char
// random suffix de-dupes simultaneous edits from the same client.
// Mirrors the shape comments.ts uses for CommentRecord ids — same
// stable sort property without dragging in nanoid.
function genChangeId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return t + '-' + r;
}

// changeLogArray returns the Y.Array<Y.Map<unknown>> for a file.
// Each map holds one ChangeRecord — using maps (rather than plain
// objects) lets `status` flip atomically across peers without a
// delete+insert dance.
function changeLogArray(ydoc: Y.Doc, file: string): Y.Array<Y.Map<unknown>> {
  return ydoc.getArray<Y.Map<unknown>>('changelog:' + file);
}

// newChangeMap : wrap a ChangeRecord into a Y.Map for insertion
// into the CRDT array.
function newChangeMap(rec: ChangeRecord): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', rec.id);
  m.set('clientID', rec.clientID);
  m.set('author', rec.author);
  m.set('color', rec.color);
  m.set('at', rec.at);
  m.set('before', rec.before);
  m.set('after', rec.after);
  m.set('status', rec.status);
  return m;
}

// changeFromMap : snapshot a Y.Map back to a plain ChangeRecord.
// toJSON() is sufficient ; every field is a primitive.
function changeFromMap(m: Y.Map<unknown>): ChangeRecord {
  return m.toJSON() as ChangeRecord;
}

export function attachChangeLog(ydoc: Y.Doc, file: string): ChangeLog {
  const arr = changeLogArray(ydoc, file);

  // The "public" yarray cast : callers see Y.Array<ChangeRecord>,
  // we hold Y.Array<Y.Map<unknown>>. The map<->record conversion
  // happens at the pending() boundary so the external surface is
  // ergonomic without forcing callers to learn the Y.Map shape.
  const yarray = arr as unknown as Y.Array<ChangeRecord>;

  function findIndexById(id: string): number {
    for (let i = 0; i < arr.length; i++) {
      const m = arr.get(i);
      if (m.get('id') === id) return i;
    }
    return -1;
  }

  function pending(): ChangeRecord[] {
    const out: ChangeRecord[] = [];
    for (let i = 0; i < arr.length; i++) {
      const rec = changeFromMap(arr.get(i));
      if (rec.status === 'pending') out.push(rec);
    }
    // Newest first — UI lists pending edits with the most recent
    // change at the top of the panel.
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  function recordChange(
    clientID: number,
    author: string,
    color: string,
    before: string,
    after: string,
  ): void {
    // No-op when nothing actually changed — pushToYtext() short-
    // circuits the same way, but we double-check here so a caller
    // that forgets the guard doesn't pollute the log with empty
    // records.
    if (before === after) return;
    const rec: ChangeRecord = {
      id: genChangeId(),
      clientID,
      author,
      color,
      at: Date.now(),
      before,
      after,
      status: 'pending',
    };
    arr.push([newChangeMap(rec)]);
  }

  function accept(id: string): void {
    const idx = findIndexById(id);
    if (idx < 0) return;
    // V0.1 : accepting drops the record. The source already holds
    // `after` (the edit was applied at recordChange time), so
    // there's nothing else to do here.
    arr.delete(idx, 1);
  }

  function reject(id: string): void {
    const idx = findIndexById(id);
    if (idx < 0) return;
    const rec = changeFromMap(arr.get(idx));
    // Drop the record first so the caller's Y.Text rewrite back to
    // `before` doesn't re-trigger recordChange via pushToYtext().
    arr.delete(idx, 1);
    // Notify the editor to roll back the source. The window event
    // is the only cross-component channel we have without
    // restructuring LatexWysiwygEditor in V0.1 — the editor's
    // ytext.observe handler will receive the resulting WS-relayed
    // update as a peer edit + render normally.
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('weft-loom:rollback-change', {
        detail: { id: rec.id, before: rec.before },
      }));
    }
  }

  // We don't observe the array internally — consumers (the panel)
  // attach their own arr.observeDeep when they care about live
  // updates. destroy() is a no-op today but kept in the contract
  // so future internal observers can be torn down without breaking
  // callers.
  function destroy() {
    // intentionally empty — see comment above
  }

  return {
    yarray,
    pending,
    recordChange,
    accept,
    reject,
    destroy,
  };
}
