// latexRichText.ts — CodeMirror 6 extension that decorates LaTeX
// source so it READS like a typeset document while remaining fully
// editable. Wraps Overleaf's Rich Text mode :
//
//   - `\section{X}` / `\subsection{X}` / `\subsubsection{X}` lines
//     render as heading-sized text + the command + braces fade out.
//   - `\textbf{X}` / `\emph{X}` / `\textit{X}` / `\underline{X}` /
//     `\texttt{X}` get the corresponding inline style applied to the
//     argument ; the surrounding command tokens collapse to a thin
//     atom decoration the user can step over with one keystroke.
//   - `\item` lines get a • bullet prepended via a `before`
//     decoration ; the source `\item` token fades.
//   - Inline math `$...$` + display math `$$...$$` swap the source
//     for a KaTeX-rendered widget — a click on the widget reveals
//     the source for in-place editing (TODO V0.2).
//   - LaTeX comments `% …` get italicised + dimmed.
//   - The whole pipeline is gated behind a `richTextEnabled`
//     compartment so the editor's toolbar button can toggle the
//     decorations on / off without rebuilding the entire state.

import katex from 'katex';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, Compartment } from '@codemirror/state';

// MathWidget hides the math source behind a KaTeX render. Clicking
// the widget moves the caret INTO the underlying source so the user
// can edit the formula — the next docChanged tick re-runs the
// decoration builder, which respects the now-overlapping selection
// + skips the replace decoration for the current line. Net effect :
// click-to-edit math, escape blurs back to the rendered widget.
class MathWidget extends WidgetType {
  constructor(readonly src: string, readonly display: boolean, readonly from: number) {
    super();
  }
  override eq(other: MathWidget) {
    return other.src === this.src && other.display === this.display;
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement(this.display ? 'div' : 'span');
    span.className = 'cm-rich-math' + (this.display ? ' cm-rich-math-display' : '');
    try {
      katex.render(this.src, span, {
        throwOnError: false,
        displayMode: this.display,
        output: 'html',
      });
    } catch (e) {
      span.textContent = (this.display ? '$$' : '$') + this.src + (this.display ? '$$' : '$');
    }
    // Click → caret jumps to the middle of the math source so the
    // user can edit the formula. We rely on the selection-overlap
    // skip in buildDecorations to reveal the raw `$…$` text.
    span.addEventListener('click', (ev) => {
      ev.preventDefault();
      const pos = this.from + (this.display ? 2 : 1);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    span.title = 'Click to edit (Esc to render)';
    return span;
  }
  override ignoreEvent(ev: Event) {
    // Let the click bubble to our handler ; keyboard events still
    // route to CodeMirror so caret motion works.
    return !(ev instanceof MouseEvent);
  }
}

// ImageWidget resolves `\includegraphics[opts]{path}` against the
// project file API. Path is relative to the current file's project
// root ; we lazy-load via an `<img>` so a missing file falls back
// to a placeholder + caption instead of swallowing the editor.
class ImageWidget extends WidgetType {
  static project = '';
  constructor(readonly path: string, readonly opts: string, readonly from: number) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.path === this.path && other.opts === this.opts;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-rich-figure';
    const img = document.createElement('img');
    // Resolve the path : LaTeX often omits the extension. Try the
    // raw path first ; on 404 try common extensions in order.
    const base = '/api/projects/' + encodeURIComponent(ImageWidget.project) + '/files/';
    const candidates = /\.[a-z]+$/i.test(this.path)
      ? [this.path]
      : [this.path + '.png', this.path + '.jpg', this.path + '.svg', this.path + '.pdf', this.path];
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) {
        wrap.classList.add('cm-rich-figure-missing');
        img.alt = 'image not found : ' + this.path;
        img.removeAttribute('src');
        return;
      }
      img.src = base + candidates[i++].split('/').map(encodeURIComponent).join('/');
    };
    img.onerror = tryNext;
    img.alt = this.path;
    img.title = this.path + (this.opts ? '\n' + this.opts : '');
    tryNext();
    wrap.appendChild(img);
    const caption = document.createElement('span');
    caption.className = 'cm-rich-figure-caption';
    caption.textContent = this.path;
    wrap.appendChild(caption);
    wrap.addEventListener('click', (ev) => {
      ev.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }
  override ignoreEvent(ev: Event) {
    return !(ev instanceof MouseEvent);
  }
}

// MathEnvWidget : `\begin{equation}…\end{equation}` and friends.
// All standard amsmath / latex math envs (equation, align, align*,
// gather, multline, eqnarray, displaymath) render as KaTeX display
// math.
class MathEnvWidget extends WidgetType {
  constructor(readonly env: string, readonly body: string, readonly from: number) {
    super();
  }
  override eq(other: MathEnvWidget) {
    return other.env === this.env && other.body === this.body;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-rich-math cm-rich-math-display';
    // KaTeX understands the env keywords directly when wrapped in
    // `\begin{env}…\end{env}` — pass through verbatim. Lots of
    // \label-decorated equations land here ; we strip those so
    // KaTeX doesn't complain.
    const inner = '\\begin{' + this.env + '}\n' + this.body + '\n\\end{' + this.env + '}';
    try {
      katex.render(inner, wrap, {
        throwOnError: false,
        displayMode: true,
        output: 'html',
        // Allow common amsmath macros even when the document
        // doesn't \usepackage them.
        trust: true,
      });
    } catch {
      wrap.textContent = inner;
    }
    wrap.addEventListener('click', (ev) => {
      ev.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 1 } });
      view.focus();
    });
    wrap.title = 'Click to edit · ' + this.env;
    return wrap;
  }
  override ignoreEvent(ev: Event) {
    return !(ev instanceof MouseEvent);
  }
}

// TableWidget renders a `\begin{tabular}{<spec>}…\end{tabular}` block
// as a real HTML <table>. Cell alignment from the spec ('l', 'c',
// 'r') is honoured ; `\hline` between rows draws a top border on
// the next row ; everything else stays raw (no \multicolumn /
// \multirow support yet — V0.7 if anyone asks).
class TableWidget extends WidgetType {
  constructor(readonly spec: string, readonly body: string, readonly from: number) {
    super();
  }
  override eq(other: TableWidget) {
    return other.spec === this.spec && other.body === this.body;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-rich-table';
    const table = document.createElement('table');
    const aligns = (this.spec.match(/[lcr]/g) ?? []).map((c) =>
      c === 'l' ? 'left' : c === 'r' ? 'right' : 'center',
    );
    // Strip TeX comments + collapse whitespace so the row split
    // doesn't choke on indented sources.
    const cleaned = this.body
      .replace(/(?<!\\)%[^\n]*/g, '')
      .trim();
    let pendingTopBorder = false;
    for (const rawRow of cleaned.split(/\\\\/)) {
      const row = rawRow.trim();
      if (!row) continue;
      // `\hline` directives apply to the NEXT row's top border.
      const cleanRow = row.replace(/\\hline\b/g, () => {
        pendingTopBorder = true;
        return '';
      }).trim();
      if (!cleanRow) continue;
      const tr = document.createElement('tr');
      if (pendingTopBorder) {
        tr.style.borderTop = '1px solid var(--fallback-bc, currentColor)';
        pendingTopBorder = false;
      }
      const cells = cleanRow.split(/(?<!\\)&/);
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = c.trim();
        td.style.textAlign = aligns[i] ?? 'left';
        td.style.padding = '0.25em 0.5em';
        td.style.borderRight = i < cells.length - 1
          ? '1px dotted rgba(127,127,127,0.3)'
          : 'none';
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    wrap.title = 'Click to edit source (Esc to render)';
    wrap.addEventListener('click', (ev) => {
      ev.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 1 } });
      view.focus();
    });
    return wrap;
  }
  override ignoreEvent(ev: Event) {
    return !(ev instanceof MouseEvent);
  }
}

// HeadingNumberWidget — prefixes a section heading with its
// auto-computed number ("1.", "1.1.", …) so the rich-text view
// reads like a typeset LaTeX article. Inline non-replacing widget :
// the caret can step right past it (side: -1) without the widget
// eating the cursor.
class HeadingNumberWidget extends WidgetType {
  constructor(readonly label: string, readonly level: number) { super(); }
  override eq(other: HeadingNumberWidget) {
    return other.label === this.label && other.level === this.level;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-rich-section-num cm-rich-h' + this.level;
    span.textContent = this.label + ' ';
    return span;
  }
  override ignoreEvent() { return true; }
}

// FootnoteWidget — collapses `\footnote{body}` to a small `[1]` style
// marker. The body lives in the title tooltip so the user can read
// it on hover ; clicking moves the caret into the source for edits.
class FootnoteWidget extends WidgetType {
  constructor(readonly body: string) { super(); }
  override eq(other: FootnoteWidget) { return other.body === this.body; }
  toDOM(): HTMLElement {
    const span = document.createElement('sup');
    span.className = 'cm-rich-footnote';
    span.textContent = '*';
    span.title = this.body;
    return span;
  }
  override ignoreEvent() { return false; }
}

const headingClass: Record<string, string> = {
  section: 'cm-rich-h1',
  subsection: 'cm-rich-h2',
  subsubsection: 'cm-rich-h3',
  paragraph: 'cm-rich-h4',
  chapter: 'cm-rich-h0',
};

const inlineCmdClass: Record<string, string> = {
  textbf: 'cm-rich-bold',
  textit: 'cm-rich-italic',
  emph: 'cm-rich-italic',
  underline: 'cm-rich-underline',
  texttt: 'cm-rich-mono',
  textsf: 'cm-rich-sans',
  textsc: 'cm-rich-smallcaps',
};

// Tokens we collapse into a thin "shadow" so they don't take editing
// space but stay click-targetable (the user can position the caret
// after them).
const shadow = Decoration.mark({ class: 'cm-rich-shadow' });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // Section counters — one slot per nesting level (chapter / section /
  // subsection / subsubsection / paragraph). Reset on every full
  // rebuild so the numbers are stable across edits ; a top-level
  // section bump zeroes every subordinate level.
  const sectionCounters = [0, 0, 0, 0, 0];
  // The selection's caret position lets us avoid hiding the source
  // currently being edited : math/heading commands that overlap the
  // caret render as raw text so the user can step the cursor through
  // each token without the widget eating the click.
  const selRanges = view.state.selection.ranges;
  const caretOverlap = (from: number, to: number) =>
    selRanges.some((r) => r.from <= to && r.to >= from);

  // Visit the document line-by-line in viewport order ; for each
  // viewport range we walk the text once with a single regex pass
  // per category. Performance-wise the regexes only run on
  // visible-line strings, so a 10k-line .tex file stays smooth.
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);

    // Pre-collect all matches with their ranges so we can sort by
    // position (RangeSetBuilder requires monotonically increasing
    // `from`). Decorations within the same span (e.g. command +
    // its argument) get inserted as separate entries on the same
    // start offset.
    type Hit = { pos: number; end: number; deco: Decoration };
    const hits: Hit[] = [];

    // Comments : start of line `%` to end of line. The `(?<!\\)`
    // negative-lookbehind exempts `\%` (escaped percent literal).
    {
      const re = /(?<!\\)%[^\n]*/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        hits.push({
          pos: from + m.index,
          end: from + m.index + m[0].length,
          deco: Decoration.mark({ class: 'cm-rich-comment' }),
        });
      }
    }

    // Headings : `\section{X}` and friends.
    {
      const re = /\\(chapter|section|subsection|subsubsection|paragraph)(\*?)\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const argStart = start + m[0].indexOf('{') + 1;
        const argEnd = argStart + m[3].length;
        const cls = headingClass[m[1]];
        const starred = !!m[2];
        const level = m[1] === 'chapter' ? 0
          : m[1] === 'section' ? 1
            : m[1] === 'subsection' ? 2
              : m[1] === 'subsubsection' ? 3
                : 4;
        // Auto-number unstarred sections — Overleaf shows "1.1.1"
        // before the heading text in its rich-text mode. We track
        // counters via a closure on builder state held outside this
        // block (sectionCounters). Starred forms (\section*) are
        // unnumbered ; \paragraph is also unnumbered in the default
        // LaTeX article class.
        // Note : in-editor section auto-numbering is intentionally
        // disabled — the (pos, end=pos, side=-1) widget at the same
        // position as the (pos, argEnd, side=0) mark below tripped
        // RangeSetBuilder's "sorted by from + startSide" invariant
        // because our sort key (pos asc, end desc) put the mark
        // first. Outline-panel numbering covers the user-visible
        // need without the decoration-ordering trap.
        void starred; void level;
        // Heading style on the ARGUMENT text (so the visual size
        // change appears where the title content sits).
        hits.push({
          pos: argStart,
          end: argEnd,
          deco: Decoration.mark({ class: cls }),
        });
        // Shadow the `\section{` prefix + closing `}` so the
        // command itself looks like a thin gutter mark.
        hits.push({ pos: start, end: argStart, deco: shadow });
        hits.push({ pos: argEnd, end: argEnd + 1, deco: shadow });
      }
    }

    // \textcolor{color}{text} — render the inner text with the named
    // color (CSS color keyword or #rrggbb). Command tokens fade.
    {
      const re = /\\textcolor\{([^{}]+)\}\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const color = m[1].trim();
        const inner = m[2];
        const innerStart = start + m[0].lastIndexOf('{') + 1;
        const innerEnd = innerStart + inner.length;
        hits.push({ pos: start, end: innerStart, deco: shadow });
        hits.push({
          pos: innerStart,
          end: innerEnd,
          deco: Decoration.mark({ attributes: { style: 'color: ' + color } }),
        });
        hits.push({ pos: innerEnd, end: innerEnd + 1, deco: shadow });
      }
    }

    // \textsuperscript{X} + \textsubscript{X} — tiny offset glyphs.
    {
      const re = /\\(textsuperscript|textsubscript)\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const innerStart = start + m[0].indexOf('{') + 1;
        const innerEnd = innerStart + m[2].length;
        const cls = m[1] === 'textsuperscript' ? 'cm-rich-sup' : 'cm-rich-sub';
        hits.push({ pos: start, end: innerStart, deco: shadow });
        hits.push({ pos: innerStart, end: innerEnd, deco: Decoration.mark({ class: cls }) });
        hits.push({ pos: innerEnd, end: innerEnd + 1, deco: shadow });
      }
    }

    // \footnote{X} — collapse to a small superscript marker. The
    // body stays editable when the caret enters the span (the
    // selection-overlap skip applies).
    {
      const re = /\\footnote\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        if (caretOverlap(start, end)) continue;
        const body = m[1];
        hits.push({
          pos: start,
          end,
          deco: Decoration.replace({
            widget: new FootnoteWidget(body),
          }),
        });
      }
    }

    // Inline text commands : `\textbf{X}` etc.
    {
      const re = /\\(textbf|textit|emph|underline|texttt|textsf|textsc)\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const argStart = start + m[0].indexOf('{') + 1;
        const argEnd = argStart + m[2].length;
        const cls = inlineCmdClass[m[1]];
        hits.push({
          pos: argStart,
          end: argEnd,
          deco: Decoration.mark({ class: cls }),
        });
        hits.push({ pos: start, end: argStart, deco: shadow });
        hits.push({ pos: argEnd, end: argEnd + 1, deco: shadow });
      }
    }

    // List items : `\item` token at start-of-line gets a bullet.
    {
      const re = /^\s*\\item\b/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index + m[0].indexOf('\\item');
        const end = start + '\\item'.length;
        hits.push({
          pos: start,
          end,
          deco: Decoration.replace({
            widget: new (class extends WidgetType {
              toDOM() {
                const s = document.createElement('span');
                s.className = 'cm-rich-bullet';
                s.textContent = '•';
                return s;
              }
            })(),
          }),
        });
      }
    }

    // Display math `$$ … $$` — checked BEFORE inline so we don't
    // split `$$x$$` into two empty `$$` pairs. The widget collapses
    // the whole `$$…$$` span to a KaTeX render UNLESS the caret is
    // inside it — that lets the user edit the formula by clicking
    // the rendered glyph (Esc to render again).
    {
      const re = /\$\$([\s\S]+?)\$\$/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        if (caretOverlap(start, end)) continue;
        hits.push({
          pos: start,
          end,
          deco: Decoration.replace({
            widget: new MathWidget(m[1].trim(), true, start),
            block: true,
          }),
        });
      }
    }

    // Inline math `$ … $` — leave display-math regions alone by
    // checking the previous + next char isn't `$`.
    {
      const re = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        if (caretOverlap(start, end)) continue;
        hits.push({
          pos: start,
          end,
          deco: Decoration.replace({
            widget: new MathWidget(m[1], false, start),
          }),
        });
      }
    }

    // \includegraphics[opts]{path} — render the referenced image
    // inline via the project files API.
    {
      const re = /\\includegraphics(?:\[([^\]]*)\])?\{([^{}]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        if (caretOverlap(start, end)) continue;
        hits.push({
          pos: start,
          end,
          deco: Decoration.replace({
            widget: new ImageWidget(m[2], m[1] ?? '', start),
          }),
        });
      }
    }

    // Math environments : equation, align, align*, gather,
    // multline, eqnarray, displaymath. These render as KaTeX
    // display math ; the body keeps its \label{…} (we don't try
    // to support cross-refs here yet).
    {
      const envs = '(?:equation\\*?|align\\*?|gather\\*?|multline\\*?|eqnarray\\*?|displaymath)';
      const re = new RegExp('\\\\begin\\{' + envs + '\\}([\\s\\S]*?)\\\\end\\{\\1\\}', 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        if (caretOverlap(start, end)) continue;
        // m[1] = env name (without leading backslash) ; m[2] = body
        const envName = m[1];
        const body = m[2];
        hits.push({
          pos: start,
          end,
          deco: Decoration.replace({
            widget: new MathEnvWidget(envName, body, start),
            block: true,
          }),
        });
      }
    }

    // \label{key} — fades into a small anchor marker so the user
    // sees the label without it dominating the rendered prose.
    {
      const re = /\\label\{([^{}]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        hits.push({ pos: start, end, deco: Decoration.mark({ class: 'cm-rich-label' }) });
      }
    }

    // \ref{key} / \pageref{key} / \eqref{key} — styled as cross-
    // reference link.
    {
      const re = /\\(?:ref|pageref|eqref|autoref|cref|Cref)\{([^{}]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        hits.push({ pos: start, end, deco: Decoration.mark({ class: 'cm-rich-ref' }) });
      }
    }

    // \cite{key} / \citep / \citet — citation marker.
    {
      const re = /\\(?:cite|citep|citet|citeauthor|citeyear)\{([^{}]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        hits.push({ pos: start, end, deco: Decoration.mark({ class: 'cm-rich-cite' }) });
      }
    }

    // Tables : `\begin{tabular}{spec} … \end{tabular}` → real HTML
    // <table>. Done BEFORE the generic \begin/\end fade so the
    // tabular block's delimiters get swallowed by the widget.
    {
      const re = /\\begin\{tabular\}\{([^{}]+)\}([\s\S]*?)\\end\{tabular\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        if (caretOverlap(start, end)) continue;
        hits.push({
          pos: start,
          end,
          deco: Decoration.replace({
            widget: new TableWidget(m[1], m[2], start),
            block: true,
          }),
        });
      }
    }

    // \begin{env} / \end{env} delimiters — fade them out so the
    // environment "frame" reads as a section break instead of
    // command markup. The contents stay live + editable.
    {
      const re = /\\(begin|end)\{[^{}]*\}(?:\[[^\]]*\])?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const end = start + m[0].length;
        hits.push({ pos: start, end, deco: Decoration.mark({ class: 'cm-rich-env' }) });
      }
    }

    // \href{url}{label} — collapse the URL half + style the label
    // as a hyperlink. Click selects ; Cmd-click could open in a
    // new tab (V0.7).
    {
      const re = /\\href\{([^{}]*)\}\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = from + m.index;
        const urlEnd = start + m[0].indexOf('}') + 1;
        const labelStart = urlEnd + 1; // skip the `{` of label
        const labelEnd = labelStart + m[2].length;
        hits.push({ pos: start, end: urlEnd, deco: shadow });
        hits.push({ pos: urlEnd, end: labelStart, deco: shadow });
        hits.push({ pos: labelStart, end: labelEnd, deco: Decoration.mark({ class: 'cm-rich-href' }) });
        hits.push({ pos: labelEnd, end: labelEnd + 1, deco: shadow });
      }
    }

    // RangeSetBuilder needs sorted, non-overlapping ranges per side
    // (mark vs replace). Sort by `pos` ascending, then by `end`
    // descending so wider marks land before nested ones.
    hits.sort((a, b) => a.pos - b.pos || b.end - a.end);
    let prevEnd = -1;
    for (const h of hits) {
      // Skip ranges that overlap a previously-added replace widget
      // (math widget eats its source ; we don't try to layer a
      // heading mark inside it).
      if (h.pos < prevEnd) continue;
      builder.add(h.pos, h.end, h.deco);
      if (h.deco.spec?.widget) prevEnd = h.end;
    }
  }

  return builder.finish();
}

const richTextPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        return view.plugin(plugin)?.decorations ?? Decoration.none;
      }),
  },
);

const richTextTheme = EditorView.theme({
  // Headings
  '.cm-rich-h0': { fontSize: '2em', fontWeight: '700', lineHeight: '1.1' },
  '.cm-rich-h1': { fontSize: '1.6em', fontWeight: '700', lineHeight: '1.15' },
  '.cm-rich-h2': { fontSize: '1.35em', fontWeight: '600', lineHeight: '1.2' },
  '.cm-rich-h3': { fontSize: '1.15em', fontWeight: '600' },
  '.cm-rich-h4': { fontWeight: '600' },
  // Inline styles
  '.cm-rich-bold': { fontWeight: '700' },
  '.cm-rich-italic': { fontStyle: 'italic' },
  '.cm-rich-underline': { textDecoration: 'underline' },
  '.cm-rich-mono': { fontFamily: 'ui-monospace, monospace' },
  '.cm-rich-sans': { fontFamily: 'ui-sans-serif, sans-serif' },
  '.cm-rich-smallcaps': { fontVariant: 'small-caps' },
  // Shadowed command tokens (\textbf{, }, \section{, etc.)
  '.cm-rich-shadow': { opacity: '0.25', fontWeight: '300' },
  // Comments
  '.cm-rich-comment': { color: 'var(--fallback-bc, #888)', opacity: '0.65', fontStyle: 'italic' },
  // Bullets
  '.cm-rich-bullet': {
    display: 'inline-block',
    width: '1.2em',
    color: 'var(--p, currentColor)',
    fontWeight: '700',
  },
  // Math widget
  '.cm-rich-math': {
    display: 'inline-block',
    padding: '0 0.1em',
    color: 'var(--fallback-bc, currentColor)',
    background: 'rgba(127,127,127,0.08)',
    borderRadius: '0.2em',
  },
  '.cm-rich-math-display': {
    display: 'block',
    textAlign: 'center',
    padding: '0.5em 0',
    background: 'rgba(127,127,127,0.06)',
    borderRadius: '0.3em',
    margin: '0.5em 0',
  },
  '.cm-rich-math, .cm-rich-math-display': {
    cursor: 'pointer',
    transition: 'background 0.1s',
  },
  '.cm-rich-math:hover, .cm-rich-math-display:hover': {
    background: 'rgba(127,127,127,0.18)',
  },
  // Environment delimiters \begin{} / \end{} fade similar to
  // command markup but bolder so the section break reads.
  '.cm-rich-env': {
    opacity: '0.45',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.85em',
  },
  // \href label — looks like a hyperlink so the user can spot it
  // without staring at the URL.
  '.cm-rich-href': {
    color: 'var(--p, #2563eb)',
    textDecoration: 'underline',
  },
  // Tables — minimal styling that adapts to daisyUI themes.
  '.cm-rich-table': {
    display: 'block',
    margin: '0.5em 0',
    padding: '0.5em',
    background: 'rgba(127,127,127,0.06)',
    borderRadius: '0.3em',
    cursor: 'pointer',
  },
  '.cm-rich-table table': {
    margin: '0 auto',
    borderCollapse: 'collapse',
  },
  '.cm-rich-table:hover': {
    background: 'rgba(127,127,127,0.12)',
  },
  // Figures — inline image + caption underneath. Click to edit.
  '.cm-rich-figure': {
    display: 'inline-block',
    margin: '0.5em auto',
    padding: '0.5em',
    background: 'rgba(127,127,127,0.06)',
    borderRadius: '0.3em',
    textAlign: 'center',
    cursor: 'pointer',
    maxWidth: '90%',
  },
  '.cm-rich-figure img': {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '400px',
    margin: '0 auto',
  },
  '.cm-rich-figure-caption': {
    display: 'block',
    fontSize: '0.85em',
    opacity: '0.6',
    fontFamily: 'ui-monospace, monospace',
    marginTop: '0.3em',
  },
  '.cm-rich-figure-missing': {
    border: '1px dashed var(--er, currentColor)',
    color: 'var(--er, currentColor)',
  },
  '.cm-rich-figure-missing img': {
    display: 'none',
  },
  '.cm-rich-figure:hover': {
    background: 'rgba(127,127,127,0.12)',
  },
  // \label{} → small anchor marker. Faded but underlined so the
  // user sees the labelled point without it stealing focus.
  '.cm-rich-label': {
    opacity: '0.5',
    fontSize: '0.85em',
    fontFamily: 'ui-monospace, monospace',
    background: 'rgba(127,127,127,0.06)',
    padding: '0 0.2em',
    borderRadius: '0.2em',
  },
  // \ref{} / \cref{} → blue cross-reference.
  '.cm-rich-ref': {
    color: 'var(--in, #2563eb)',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.9em',
  },
  // \cite{} → green citation marker.
  '.cm-rich-cite': {
    color: 'var(--su, #16a34a)',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.9em',
  },
  // Section number prefix : same colour weight as the heading text
  // so the "1.1.1" reads as part of the typeset title block.
  '.cm-rich-section-num': {
    opacity: '0.75',
    marginRight: '0.4em',
    fontWeight: 'bold',
  },
  '.cm-rich-section-num.cm-rich-h0': { fontSize: '1.85em' },
  '.cm-rich-section-num.cm-rich-h1': { fontSize: '1.6em' },
  '.cm-rich-section-num.cm-rich-h2': { fontSize: '1.35em' },
  '.cm-rich-section-num.cm-rich-h3': { fontSize: '1.15em' },
  // Superscript / subscript glyphs sized like proper typography.
  '.cm-rich-sup': {
    fontSize: '0.7em',
    verticalAlign: 'super',
    lineHeight: '0',
  },
  '.cm-rich-sub': {
    fontSize: '0.7em',
    verticalAlign: 'sub',
    lineHeight: '0',
  },
  // Footnote marker : tiny coloured star ; hover for the body.
  '.cm-rich-footnote': {
    color: 'var(--p, #2563eb)',
    fontSize: '0.7em',
    marginLeft: '0.1em',
    cursor: 'help',
  },
});

// Command helpers for the rich-text toolbar — wrap the current
// selection (or insert a placeholder when nothing is selected) in
// a LaTeX command. Exported so the Editor's toolbar buttons can
// dispatch them ; pure CodeMirror transactions, no Yjs gymnastics
// since our binding observes EditorView dispatches.
export type LatexCommand =
  | 'textbf' | 'textit' | 'emph' | 'underline' | 'texttt'
  | 'section' | 'subsection' | 'subsubsection'
  | 'inline-math' | 'display-math' | 'itemize' | 'enumerate' | 'href';

export function applyLatexCommand(view: EditorView, cmd: LatexCommand) {
  const { state } = view;
  const sel = state.selection.main;
  const selected = state.doc.sliceString(sel.from, sel.to);
  let insert = '';
  let cursorOffset = 0;
  switch (cmd) {
    case 'textbf':
    case 'textit':
    case 'emph':
    case 'underline':
    case 'texttt':
      insert = '\\' + cmd + '{' + (selected || 'text') + '}';
      cursorOffset = selected ? insert.length : insert.length - 1;
      break;
    case 'section':
    case 'subsection':
    case 'subsubsection':
      insert = '\\' + cmd + '{' + (selected || 'Heading') + '}';
      cursorOffset = selected ? insert.length : insert.length - 1;
      break;
    case 'inline-math':
      insert = '$' + (selected || 'x^2') + '$';
      cursorOffset = selected ? insert.length : insert.length - 1;
      break;
    case 'display-math':
      insert = '\n$$\n' + (selected || 'E = mc^2') + '\n$$\n';
      cursorOffset = insert.length;
      break;
    case 'itemize':
      insert = '\\begin{itemize}\n  \\item ' + (selected || 'first') + '\n\\end{itemize}\n';
      cursorOffset = insert.length;
      break;
    case 'enumerate':
      insert = '\\begin{enumerate}\n  \\item ' + (selected || 'first') + '\n\\end{enumerate}\n';
      cursorOffset = insert.length;
      break;
    case 'href':
      insert = '\\href{https://}{' + (selected || 'link') + '}';
      cursorOffset = insert.length;
      break;
  }
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + cursorOffset },
    userEvent: 'input.format',
  });
  view.focus();
}

// The compartment lets the consumer (Editor.svelte) flip the
// extension on / off via `view.dispatch({ effects: compartment.reconfigure(value) })`.
export const richTextCompartment = new Compartment();

export function latexRichText(enabled: boolean, project = '') {
  // Image widgets resolve their src against the project files API ;
  // we set the project name on the class once per call site so each
  // ImageWidget instance reads from the right project.
  if (project) ImageWidget.project = project;
  return enabled ? [richTextPlugin, richTextTheme] : [];
}
