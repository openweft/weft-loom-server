// ybinding.ts — minimal Yjs ↔ CodeMirror 6 two-way binding.
//
// Two pieces of plumbing :
//
//   - cmToY  : EditorView.updateListener (returned as an Extension).
//              Every docChanged CodeMirror transaction with no
//              `remoteAnnot` flag becomes a Y.Text op inside
//              ydoc.transact(origin = YORIGIN_LOCAL).
//
//   - yToCm  : ytext.observe handler hooked up *imperatively* via
//              attachYToCm(view) once the EditorView exists. We can't
//              latch the view inside the updateListener because the
//              very first remote Y.Text update can arrive (e.g. the
//              seed-from-disk insert) BEFORE any local CM transaction
//              fires — at which point the listener never ran and the
//              view ref is null. The imperative attach side-steps
//              that race entirely.

import { EditorView, type ViewUpdate } from '@codemirror/view';
import { Annotation, type Extension } from '@codemirror/state';
import * as Y from 'yjs';

const YORIGIN_LOCAL = 'yb-local';
const remoteAnnot = Annotation.define<boolean>();

export interface YjsBinding {
  // The cmToY extension to put in the EditorState's extensions array.
  extension: Extension;
  // Call once after `new EditorView({state, parent})` is set up so
  // yToCm has a target to dispatch into. Returns a destroy fn the
  // caller invokes on editor teardown to unobserve the Y.Text.
  attach: (view: EditorView) => () => void;
}

export function yjsBinding(ytext: Y.Text, ydoc: Y.Doc): YjsBinding {
  const extension = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.docChanged) return;
    if (update.transactions.some((t) => t.annotation(remoteAnnot))) return;
    ydoc.transact(() => {
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (toA > fromA) ytext.delete(fromA, toA - fromA);
        const ins = inserted.toString();
        if (ins.length > 0) ytext.insert(fromA, ins);
      });
    }, YORIGIN_LOCAL);
  });

  const attach = (view: EditorView) => {
    const observer = (event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.origin === YORIGIN_LOCAL) return;
      let pos = 0;
      const changes: Array<{ from: number; to?: number; insert?: string }> = [];
      for (const d of event.delta) {
        if (typeof d.retain === 'number') {
          pos += d.retain;
        } else if (typeof d.insert === 'string') {
          changes.push({ from: pos, insert: d.insert });
          pos += d.insert.length;
        } else if (typeof d.delete === 'number') {
          changes.push({ from: pos, to: pos + d.delete });
        }
      }
      if (changes.length === 0) return;
      view.dispatch({
        changes,
        annotations: [remoteAnnot.of(true)],
      });
    };
    ytext.observe(observer);
    return () => ytext.unobserve(observer);
  };

  return { extension, attach };
}
