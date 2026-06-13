// commentDecorations.ts — CodeMirror 6 extension that paints a
// dotted yellow underline on every commented range in the live
// ytext. The underline is rebuilt every time the comments array
// or the doc changes, so concurrent edits via Yjs reflow the
// highlighted regions automatically.

import { Decoration, ViewPlugin, EditorView } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';

// Each entry is the resolved absolute range + the comment id (so
// the editor can map a click → focus in the side panel).
export interface CommentRange {
  id: string;
  from: number;
  to: number;
  resolved: boolean;
}

// Setter effect : the parent component recomputes the ranges from
// the Y.Array + dispatches an effect each time the array changes
// or the doc resolves to a different set of anchors.
export const setCommentRanges = StateEffect.define<CommentRange[]>();

const commentRangesField = StateField.define<CommentRange[]>({
  create: () => [],
  update(v, tr) {
    for (const ef of tr.effects) {
      if (ef.is(setCommentRanges)) return ef.value;
    }
    return v;
  },
});

const commentDecoration = Decoration.mark({
  class: 'cm-comment-anchor',
});
const commentDecorationResolved = Decoration.mark({
  class: 'cm-comment-anchor cm-comment-anchor-resolved',
});

function buildDecos(ranges: CommentRange[], docLen: number): DecorationSet {
  const sorted = [...ranges]
    .filter(r => r.from <= r.to && r.from >= 0 && r.to <= docLen)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of sorted) {
    if (r.from === r.to) continue;
    builder.add(r.from, r.to, r.resolved ? commentDecorationResolved : commentDecoration);
  }
  return builder.finish();
}

const commentRangesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      const ranges = view.state.field(commentRangesField);
      this.decorations = buildDecos(ranges, view.state.doc.length);
    }
    update(u: ViewUpdate) {
      const ranges = u.state.field(commentRangesField);
      const prev = u.startState.field(commentRangesField);
      if (u.docChanged || ranges !== prev) {
        this.decorations = buildDecos(ranges, u.state.doc.length);
      }
    }
  },
  { decorations: v => v.decorations },
);

export function commentDecorations(): Extension {
  return [
    commentRangesField,
    commentRangesPlugin,
    EditorView.baseTheme({
      '.cm-comment-anchor': {
        backgroundColor: 'rgba(255, 220, 0, 0.12)',
        borderBottom: '1.5px dotted rgba(180, 130, 0, 0.7)',
        cursor: 'help',
      },
      '.cm-comment-anchor-resolved': {
        backgroundColor: 'rgba(200, 200, 200, 0.08)',
        borderBottom: '1px dotted rgba(140, 140, 140, 0.6)',
      },
    }),
  ];
}
