// inlineMathRender.ts — CodeMirror 6 extension that renders LaTeX
// math segments (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) inline using
// KaTeX. The user sees the rendered formula while the cursor is
// OUTSIDE the segment ; clicking into the segment reveals the raw
// source so it can be edited.
//
// Why this beats Overleaf : Overleaf's source editor never shows
// the rendered math ; the user has to wait for the next PDF compile
// to see whether the formula is right. Here the math glyphs come
// alive as the user types.
//
// Performance : KaTeX.renderToString is a few hundred microseconds
// for typical formulas, so even a doc with 50+ inline-math segments
// renders smoothly. We re-scan only the visible viewport on each
// update, and re-use the widget instances when the source hasn't
// changed.

import { Decoration, ViewPlugin, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate, Range } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import katex from 'katex';

interface MathMatch {
  from: number;
  to: number;
  body: string;
  displayMode: boolean;
}

// Regex covers the four delimiter shapes :
//   $…$            inline (single $)
//   $$…$$          display
//   \(…\)          inline (TeX style)
//   \[…\]          display (TeX style)
// Non-greedy bodies + escape-aware so $\$$ wouldn't match.
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$((?:[^\\$]|\\.)+?)\$|\\\(((?:[^\\)]|\\.)+?)\\\)/g;

function scanMath(text: string, baseOffset: number): MathMatch[] {
  const out: MathMatch[] = [];
  MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_RE.exec(text))) {
    const displayMode = m[1] != null || m[2] != null;
    const body = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    out.push({
      from: baseOffset + m.index,
      to: baseOffset + m.index + m[0].length,
      body,
      displayMode,
    });
  }
  return out;
}

class MathWidget extends WidgetType {
  constructor(readonly body: string, readonly displayMode: boolean) {
    super();
  }
  eq(other: MathWidget): boolean {
    return other.body === this.body && other.displayMode === this.displayMode;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-inline-math' + (this.displayMode ? ' cm-inline-math-display' : '');
    try {
      wrap.innerHTML = katex.renderToString(this.body, {
        throwOnError: false,
        displayMode: this.displayMode,
        output: 'html',
      });
    } catch (e) {
      // KaTeX surfaces malformed input as a thrown error when
      // throwOnError is on ; with it off we still want a visible
      // marker so the user knows something is off.
      wrap.textContent = '⚠ ' + this.body;
      wrap.classList.add('cm-inline-math-error');
    }
    return wrap;
  }
  ignoreEvent(): boolean {
    // Allow click events through so the user can place the caret
    // back into the source.
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const selectionFrom = view.state.selection.main.from;
  const selectionTo = view.state.selection.main.to;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const matches = scanMath(text, from);
    for (const m of matches) {
      // Don't render the widget while the caret / selection touches
      // this segment — otherwise the user can't edit the source.
      const cursorInside = selectionFrom <= m.to && selectionTo >= m.from;
      if (cursorInside) continue;
      // CRITICAL : CodeMirror forbids Decoration.replace that crosses
      // a line break from a ViewPlugin (they must come from a
      // StateField). A multi-line display-math segment ($$ … \n … $$
      // or \[ … \n … \]) would throw RangeError + abort the dispatch,
      // leaving the editor visually empty for the surrounding insert.
      // Skip such matches here ; the PreviewPane still renders them.
      // Single-line inline math + same-line display math still get
      // their widgets.
      const slice = view.state.doc.sliceString(m.from, m.to);
      if (slice.indexOf('\n') >= 0) continue;
      // Always inline replace — CodeMirror block widgets require
      // line-aligned bounds, but our regex matches the `$$`/`\[`
      // delimiters which sit mid-line, so block:true throws +
      // silently kills the editor. The display widget styles
      // itself as block via CSS instead.
      const deco = Decoration.replace({
        widget: new MathWidget(m.body, m.displayMode),
      });
      builder.add(m.from, m.to, deco);
    }
  }
  return builder.finish();
}

// cursorInsideAnyMath : O(visible-text) predicate that returns true
// iff the main selection overlaps any inline-math segment in the
// current viewport. Same regex pass as buildDecorations but with no
// widget allocation / RangeSetBuilder churn — the cheap signal we
// need to short-circuit pure-selection updates.
function cursorInsideAnyMath(view: EditorView): boolean {
  const selectionFrom = view.state.selection.main.from;
  const selectionTo = view.state.selection.main.to;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const matches = scanMath(text, from);
    for (const m of matches) {
      if (selectionFrom <= m.to && selectionTo >= m.from) return true;
    }
  }
  return false;
}

// inlineMathRender : public CM6 extension. Plug into the LaTeX
// extension stack in Editor.svelte alongside the language support
// + autocomplete.
export function inlineMathRender() {
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      // Caret-inside-any-math memo : pure caret motion (selectionSet
      // with no docChange / viewport change) only flips the decoration
      // set when this predicate's value flips. Skipping the rebuild
      // when it stays the same saves the widget allocation + the
      // KaTeX render that toDOM eventually performs on a cache miss.
      prevCursorInsideMath: boolean;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
        this.prevCursorInsideMath = cursorInsideAnyMath(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = buildDecorations(u.view);
          this.prevCursorInsideMath = cursorInsideAnyMath(u.view);
          return;
        }
        if (u.selectionSet) {
          const next = cursorInsideAnyMath(u.view);
          if (next === this.prevCursorInsideMath) return;
          this.prevCursorInsideMath = next;
          this.decorations = buildDecorations(u.view);
        }
      }
    }, {
      decorations: v => v.decorations,
    }),
    EditorView.baseTheme({
      '.cm-inline-math': {
        backgroundColor: 'rgba(0, 100, 200, 0.06)',
        borderRadius: '3px',
        padding: '0 2px',
      },
      '.cm-inline-math-display': {
        display: 'block',
        textAlign: 'center',
        margin: '0.4em 0',
        padding: '0.3em 0.6em',
        backgroundColor: 'rgba(0, 100, 200, 0.04)',
        borderLeft: '3px solid rgba(0, 100, 200, 0.3)',
      },
      '.cm-inline-math-error': {
        backgroundColor: 'rgba(220, 38, 38, 0.12)',
        color: '#7f1d1d',
      },
    }),
  ];
}
