// tableGen.ts — pure helper that turns a TableWizard form spec into a
// LaTeX snippet ready to be dropped into the WYSIWYG editor. Kept in
// its own module so node --test (which strips TS natively under
// Node 24) can exercise the generator without touching Svelte.
//
// Two layers :
//   1. `\begin{tabular}{<spec>}` with empty cells + optional borders
//   2. an optional `\begin{table}[h]` float wrapper that only kicks
//      in when the user actually filled caption *or* label — the
//      v0.1 parser doesn't grok the float env (it renders as
//      latex-raw), but the user can still toggle to source view.

export type ColAlign = 'l' | 'c' | 'r';

export interface TableGenOpts {
  rows: number;
  cols: number;
  alignments: ColAlign[];
  bordered: boolean;
  hlines: boolean;
  caption?: string;
  label?: string;
}

// Build the column specifier — e.g. ['l','c','r'] + bordered=true →
// "|l|c|r|". We use the same separator everywhere ; bordered=false
// produces "lcr" (no pipes anywhere).
function buildSpec(alignments: ColAlign[], bordered: boolean): string {
  const sep = bordered ? '|' : '';
  return sep + alignments.join(sep) + sep;
}

// One blank row : (cols-1) ampersand separators followed by the
// row-terminator "\\". Cells are empty so the user can type in them
// after the snippet lands in the editor.
function blankRow(cols: number): string {
  // " & " between each empty cell + trailing "\\".
  return ' '.repeat(0) + Array(cols).fill('').join(' & ') + ' \\\\';
}

export function generateTabularLatex(opts: TableGenOpts): string {
  const { rows, cols, alignments, bordered, hlines, caption, label } = opts;

  // Defensive : if alignments[] is shorter than cols, pad with 'l' ;
  // if longer, slice. Keeps the generator total over weird inputs the
  // wizard might briefly produce while the user is dragging the cols
  // counter up and down.
  const aligns: ColAlign[] = [];
  for (let i = 0; i < cols; i++) {
    aligns.push(alignments[i] ?? 'l');
  }

  const spec = buildSpec(aligns, bordered);

  const rowLines: string[] = [];
  if (hlines) rowLines.push('\\hline');
  for (let i = 0; i < rows; i++) {
    rowLines.push(blankRow(cols));
    if (hlines) rowLines.push('\\hline');
  }

  const tabular =
    `\\begin{tabular}{${spec}}\n` +
    rowLines.join('\n') +
    `\n\\end{tabular}`;

  const hasCaption = (caption ?? '').trim().length > 0;
  const hasLabel = (label ?? '').trim().length > 0;
  if (!hasCaption && !hasLabel) return tabular;

  // Indent the tabular two spaces so the float body is visually nested
  // when the user toggles to source view. Caption / label only appear
  // when non-empty — half-filled floats are a common LaTeX trip wire.
  const indented = tabular
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n');

  const parts: string[] = [];
  parts.push('\\begin{table}[h]');
  parts.push('  \\centering');
  parts.push(indented);
  if (hasCaption) parts.push(`  \\caption{${caption}}`);
  if (hasLabel) parts.push(`  \\label{tab:${label}}`);
  parts.push('\\end{table}');
  return parts.join('\n');
}
