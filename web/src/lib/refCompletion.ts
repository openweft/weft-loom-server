// refCompletion.ts — CodeMirror CompletionSource that fires inside
// a `\ref{` / `\eqref{` / `\pageref{` / `\autoref{` brace block.
// Scans the current document for `\label{key}` occurrences and
// suggests each `key`.
//
// No project-wide scan ; refs are typically within the same file
// (multi-file refs use \externalref / xr package, V0.2).

import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';

const REF = /\\(?:ref|eqref|pageref|autoref)\{([^{}]*)$/;
const LABEL = /\\label\{([^{}]+)\}/g;
const VALID = /^[A-Za-z0-9_:\-]*$/;
const MAX_SUGGESTIONS = 50;

export function refCompletion(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const upToCursor = line.text.slice(0, ctx.pos - line.from);

  const refMatch = REF.exec(upToCursor);
  if (!refMatch) return null;

  const prefix = refMatch[1];
  const start = ctx.pos - prefix.length;
  const prefixLc = prefix.toLowerCase();

  // Walk the whole document for \label{...} keys. O(n) on every
  // keystroke is fine — labels are sparse and docs rarely huge.
  const doc = ctx.state.doc.sliceString(0, ctx.state.doc.length);
  const labels = new Set<string>();
  let m: RegExpExecArray | null;
  LABEL.lastIndex = 0;
  while ((m = LABEL.exec(doc))) labels.add(m[1]);

  if (labels.size === 0) return null;

  const options: Completion[] = [];
  for (const key of labels) {
    if (prefixLc && !key.toLowerCase().startsWith(prefixLc)) continue;
    options.push({ label: key, type: 'enum', detail: 'label' });
    if (options.length >= MAX_SUGGESTIONS) break;
  }

  return {
    from: start,
    options,
    validFor: VALID,
  };
}
