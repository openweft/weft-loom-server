// citeAutocomplete.ts — CodeMirror CompletionSource that fires
// inside a `\cite{` / `\citep{` / `\citet{` / `\autoref{` / `\ref{`
// argument list. Pulls keys + labels from bibStore (citations) and
// the active document (`\label{key}` scan for cross-refs).

import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { bib } from './bibStore.svelte';
import { formatEntry } from './bibtex';

const CITE = /\\(?:cite|citep|citet|citeauthor|citeyear)\{([^{}]*)$/;
const REF = /\\(?:ref|pageref|eqref|autoref|cref|Cref)\{([^{}]*)$/;

export function citeCompletion(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const upToCursor = line.text.slice(0, ctx.pos - line.from);

  const citeMatch = CITE.exec(upToCursor);
  if (citeMatch) {
    const start = ctx.pos - citeMatch[1].length;
    const options: Completion[] = bib.entries.map((e) => ({
      label: e.key,
      detail: e.type,
      info: formatEntry(e),
      apply: e.key,
    }));
    return {
      from: start,
      options,
      validFor: /^[\w:-]*$/,
    };
  }

  const refMatch = REF.exec(upToCursor);
  if (refMatch) {
    // Scan the full document for `\label{…}` definitions ; cheap
    // O(n) on every keystroke is fine since labels are sparse.
    const doc = ctx.state.doc.toString();
    const labels = new Set<string>();
    const re = /\\label\{([^{}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(doc))) labels.add(m[1]);
    const start = ctx.pos - refMatch[1].length;
    const options: Completion[] = Array.from(labels).map((label) => ({
      label,
      detail: 'label',
      apply: label,
    }));
    return {
      from: start,
      options,
      validFor: /^[\w:-]*$/,
    };
  }

  return null;
}
