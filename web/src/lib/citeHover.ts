// citeHover.ts — CodeMirror hoverTooltip extension that pops the
// resolved BibTeX entry when the cursor sits over a `\cite{key}`
// argument. Pulls from bibStore.byKey ; falls back to "unknown key"
// when the bib hasn't been indexed yet.
//
// Also handles `\ref{label}` → scans the doc for matching `\label{}`
// definitions + shows the line where the label is defined.

import { hoverTooltip, type Tooltip } from '@codemirror/view';
import { bib } from './bibStore.svelte';
import { formatEntry } from './bibtex';

export const citeHover = hoverTooltip((view, pos): Tooltip | null => {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;

  // Cite : walk left from pos to find `\cite{` or `\cite[opt]{` etc.
  const citeRe = /\\(?:cite|citep|citet|citeauthor|citeyear)(?:\[[^\]]*\])?\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = citeRe.exec(text))) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    if (pos < start || pos > end) continue;
    // Identify which comma-key the cursor is hovering. Citations can
    // be `\cite{a, b, c}` ; we resolve the segment under the caret.
    const inner = m[1];
    const innerStart = line.from + m.index + m[0].indexOf('{') + 1;
    let cursor = innerStart;
    for (const raw of inner.split(',')) {
      const segEnd = cursor + raw.length;
      if (pos >= cursor && pos <= segEnd) {
        const key = raw.trim();
        const entry = bib.byKey.get(key);
        return {
          pos: cursor,
          end: segEnd,
          above: true,
          create() {
            const dom = document.createElement('div');
            dom.className = 'cm-tooltip-cite';
            if (entry) {
              dom.innerHTML =
                '<div class="font-bold text-xs">' + escapeHTML(entry.key) + '</div>' +
                '<div class="text-xs opacity-80">' + escapeHTML(formatEntry(entry)) + '</div>';
            } else {
              dom.innerHTML = '<div class="text-xs opacity-70 italic">Unknown citation key : ' + escapeHTML(key) + '</div>';
            }
            return { dom };
          },
        };
      }
      cursor = segEnd + 1; // skip the comma
    }
  }

  // Ref : resolve `\ref{label}` against the doc's \label{} set.
  const refRe = /\\(?:ref|pageref|eqref|autoref|cref|Cref)\{([^{}]+)\}/g;
  while ((m = refRe.exec(text))) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    if (pos < start || pos > end) continue;
    const key = m[1].trim();
    const labelRe = new RegExp('\\\\label\\{' + escapeRegExp(key) + '\\}');
    let labelLine = -1;
    const doc = view.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      if (labelRe.test(doc.line(i).text)) { labelLine = i; break; }
    }
    return {
      pos: start,
      end,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-tooltip-cite';
        if (labelLine >= 0) {
          dom.innerHTML =
            '<div class="font-bold text-xs">' + escapeHTML(key) + '</div>' +
            '<div class="text-xs opacity-80">Defined on line ' + labelLine + '</div>';
        } else {
          dom.innerHTML = '<div class="text-xs opacity-70 italic">Unknown label : ' + escapeHTML(key) + '</div>';
        }
        return { dom };
      },
    };
  }

  return null;
});

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
