// changelog-collab.ts — the track-changes log for the LaTeX WYSIWYG surface, on
// go-crdt/collab.
//
// # Why this is a plain list and comments are not
//
// comments-collab gives each comment a map part of its own, because a comment's
// `resolved` flag flips and two people flipping it at once must leave one
// comment. wysiwygAuthorship.ts said it needed the same thing — "using Y.Map for
// the per-record container keeps `status` mutable without delete+insert" — but
// it never used it. `status` is written 'pending' and read back by a filter that
// is therefore always true; accept and reject both *delete* the record. So the
// nesting bought nothing, and the field it existed for is gone here.
//
// What the two gestures need instead is that deleting the same record twice
// leaves it deleted, which a list already gives: `delete` of an index that is
// already a tombstone is not an error and does not take a neighbour with it.
//
// # Why records are whole
//
// A record is written once and never edited. Encoding it as one value rather
// than a part per field is not a shortcut — it is the same reason the chat is
// one: a field that never changes alone has nothing to gain from being
// addressable alone, and every part costs a name in the document.
//
// # Persistence
//
// This part lives in the project's document, so the log is on the server's disk
// with everything else. The Yjs version kept it in a Y.Doc that existed for as
// long as somebody had the file open — reload the page and the pending changes
// were whatever the relay still held.

import { encode, records, watch, type List, type Session } from './collab';

export interface ChangeRecord {
  id: string;
  /**
   * Who made the change, as a replica identity. It was a Yjs clientID (a
   * number) and is a site (a string), which is what everything else here
   * already compares against — the peer list, the authorship colours.
   */
  site: string;
  author: string;
  color: string;
  at: number;
  /** The LaTeX source before and after, which is what the redline diffs. */
  before: string;
  after: string;
}

export interface ChangeLog {
  /** Every pending change, newest first. */
  pending(): ChangeRecord[];
  recordChange(
    site: string,
    author: string,
    color: string,
    before: string,
    after: string,
  ): Promise<void>;
  /** The source already holds `after`, so accepting is dropping the record. */
  accept(id: string): Promise<void>;
  /**
   * Drops the record and asks the editor to put the source back. The rollback
   * travels as a window event because that is the only channel between these
   * two components, exactly as it did before.
   */
  reject(id: string): Promise<void>;
  /** Calls back on every change to this log, from here or from a peer. */
  subscribe(fn: () => void): () => void;
  destroy(): void;
}

/** The list part holding one file's change log. */
export function changeLogPart(file: string): string {
  return `changelog:${file}`;
}

function genChangeId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

export async function attachChangeLog(session: Session, file: string): Promise<ChangeLog> {
  const name = changeLogPart(file);
  const list: List = await session.list(name);
  const subscribers = new Set<() => void>();

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  // One watch for the part, fanned out to whoever is listening. The panel is
  // the only subscriber today, but the editor mounting a second one must not
  // silently unregister the first — which is the shape the peer and part
  // watchers already had to be given.
  //
  // It reports what peers did and not what this replica did — collab never
  // replays a local edit, which is the same property cmbinding relies on to
  // avoid echoing typing back into the editor. So every write below notifies
  // as well. Without that the tab that records a change is the one tab that
  // does not list it, which is exactly how it first behaved.
  let unwatch: (() => void) | undefined;
  let stopped = false;
  void watch(session, {
    list: (changed) => {
      if (changed === name) notify();
    },
  })
    .then((off) => {
      if (stopped) off();
      else unwatch = off;
    })
    .catch((err) => console.error('collab: watching the change log', err));

  const read = (): ChangeRecord[] => records<ChangeRecord>(list);

  const indexOf = (id: string): number => read().findIndex((rec) => rec.id === id);

  const drop = async (id: string): Promise<ChangeRecord | undefined> => {
    const at = indexOf(id);
    if (at < 0) return undefined;
    const rec = read()[at];
    await list.delete(at, 1);
    notify();
    return rec;
  };

  return {
    pending(): ChangeRecord[] {
      // Newest first, which is what the panel renders. The list is in the
      // order the records were appended, and that is nearly this order
      // already — but two replicas' clocks are not the same clock, so the
      // sort is what makes the panel agree with itself.
      return read().sort((a, b) => b.at - a.at);
    },

    async recordChange(site, author, color, before, after) {
      // Nothing changed, nothing to log. The editor guards this too; a caller
      // that forgets should not fill the log with empty records.
      if (before === after) return;
      await list.append(
        encode({ id: genChangeId(), site, author, color, at: Date.now(), before, after }),
      );
      notify();
    },

    async accept(id) {
      await drop(id);
    },

    async reject(id) {
      // The record goes first, so the editor's rewrite back to `before` does
      // not come straight back through recordChange as a new pending change.
      const rec = await drop(id);
      if (!rec) return;
      if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('weft-loom:rollback-change', {
            detail: { id: rec.id, before: rec.before },
          }),
        );
      }
    },

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    destroy() {
      stopped = true;
      subscribers.clear();
      unwatch?.();
    },
  };
}
