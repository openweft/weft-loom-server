// cmbinding.ts — go-crdt ↔ CodeMirror 6 two-way binding.
//
// It replaces ybinding.ts and keeps its shape, because that shape was arrived at
// by fixing things: an extension for what the editor does, and an imperative
// attach for what everybody else does, because the first remote edit can arrive
// before any local transaction has fired and a view latched inside the update
// listener would still be null.
//
// Three things differ from the Yjs binding, and each one is a decision rather
// than a translation.
//
// Offsets. CodeMirror counts document positions in UTF-16 code units, and so
// does this binding, all the way down: collab's text handle takes and reports
// the same units. Nothing here converts, which is the point — an offset that
// would split a character is refused by collab rather than rounded, and a
// binding doing its own arithmetic is where that guarantee would be lost.
//
// Ordering. Every edit here returns a promise, and two edits issued without
// waiting could be applied in either order — which for a sequence of edits is
// not a race but a corruption. They go through one chain, so the second is sent
// after the first has landed.
//
// Batching. A Yjs delta describes one document state, so the old binding could
// turn a whole delta into one CodeMirror transaction. collab reports edits as
// they have to be applied — each against the text as it stands after the one
// before it — so batching them into a single `changes` array would need every
// offset after the first adjusted. One transaction per edit is what the editor
// would have to do anyway, and it is right by construction.

import { EditorView, type ViewUpdate } from '@codemirror/view';
import { Annotation, type Extension } from '@codemirror/state';
import { watch, type PartChange, type Session, type Text } from './collab';

/** Marks a transaction this binding made, so it is not sent back. */
const remoteAnnot = Annotation.define<boolean>();

/**
 * fromCollab reports whether an update is one this binding applied — somebody
 * else's edit arriving — rather than something the person at this keyboard did.
 *
 * It is exported because "did the local editor change this" is a question the
 * editor asks for its own reasons, and saving is the one that matters: a file is
 * written by whoever typed into it, not by everybody who was told about it.
 * With Yjs that question was answered by a transaction origin; here local edits
 * are simply never reported back, so the only place left to ask is the editor.
 */
export function fromCollab(update: ViewUpdate): boolean {
  return update.transactions.some((t) => t.annotation(remoteAnnot));
}

export interface CollabBinding {
  /** The extension to put in the EditorState's extensions array. */
  extension: Extension;
  /**
   * Call once after `new EditorView({state, parent})` exists, so remote edits
   * have somewhere to go. Returns what to call on teardown.
   */
  attach: (view: EditorView) => () => void;
}

/**
 * Binds one text part to a CodeMirror editor.
 *
 * `session` is watched rather than the handle, because a session reports what
 * every part did in one callback and a page has one session; `text.name` is
 * what picks this part's edits out of it.
 */
export function collabBinding(session: Session, text: Text): CollabBinding {
  // Local edits go out in order. A rejected one stops the chain from
  // collapsing: the next edit is still sent, because refusing one edit is not a
  // reason to stop sending the ones after it.
  let sending: Promise<unknown> = Promise.resolve();
  const send = (run: () => Promise<void>) => {
    sending = sending.then(run).catch((err) => {
      console.error('collab: sending an edit', err);
    });
  };

  const extension = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.docChanged) return;
    if (fromCollab(update)) return;
    // iterChanges walks in ascending order against the document as it was, and
    // each edit here shifts what follows it — so they are applied against the
    // running text by sending them in the same order, which the chain does.
    update.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
      const removed = toA - fromA;
      const insert = inserted.toString();
      // fromB is where this edit lands in the document being built, which is
      // where collab has to be told to put it: fromA is a position in a
      // document that no longer exists by the time the edit before this one has
      // been applied.
      if (removed > 0) send(() => text.delete(fromB, removed));
      if (insert.length > 0) send(() => text.insert(fromB, insert));
    });
  });

  const attach = (view: EditorView) => {
    let stopped = false;

    // What the document already holds. A session that joined an existing
    // document has its text before this runs, and without this the editor shows
    // an empty buffer with line numbers beside it — which is what a previous
    // version of this was reported as.
    const seed = text.toString();
    if (view.state.doc.length === 0 && seed.length > 0) {
      view.dispatch({
        changes: { from: 0, insert: seed },
        annotations: [remoteAnnot.of(true)],
      });
    }

    const apply = (edits: PartChange['text']) => {
      if (stopped || !edits) return;
      for (const edit of edits) {
        view.dispatch({
          changes: { from: edit.pos, to: edit.pos + edit.removed, insert: edit.insert },
          annotations: [remoteAnnot.of(true)],
        });
      }
    };

    let unwatch: (() => void) | undefined;
    void watch(session, {
      text: (name, edits) => {
        if (name === text.name) apply(edits);
      },
    })
      .then((off) => {
        if (stopped) off();
        else unwatch = off;
      })
      .catch((err) => console.error('collab: watching the text', err));

    return () => {
      stopped = true;
      unwatch?.();
    };
  };

  return { extension, attach };
}
