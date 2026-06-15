// figureGen.ts — pure helper that turns a FigureWizard form spec into
// a LaTeX `\begin{figure}` snippet ready to be dropped into the WYSIWYG
// editor. Kept in its own module so node --test (which strips TS types
// natively under Node 24) can exercise the generator without touching
// Svelte.
//
// Output shape :
//   \begin{figure}[h]
//   \centering
//   \includegraphics[width=5cm]{figs/plot.png}
//   \caption{Caption text}
//   \label{fig:plot}
//   \end{figure}
//
// Width emits `[width=<spec>]` ONLY when non-empty. Caption + label
// lines are emitted ONLY when non-empty. `\centering` is always
// present. Placement defaults to `h` and is sanitised to the
// htbpH alphabet — anything else falls back to `h` so a typo in
// the wizard radio group can never produce an unparseable float.

export interface FigureOpts {
  /** Path to the image, relative to project root. */
  path: string;
  /** Width spec (e.g. "5cm", "0.5\\textwidth", or empty for natural). */
  width?: string;
  /** Float placement spec without brackets : "h", "t", "b", "p", "H".
   *  Default "h". */
  placement?: string;
  /** Caption text. Optional ; empty caption = no \caption line. */
  caption?: string;
  /** Label name (without the "fig:" prefix). Optional. */
  label?: string;
}

// LaTeX float placement alphabet : here, top, bottom, page, Here
// (capital, from the float package — forces exact spot). Anything
// outside this set is rejected upstream so the generator can't emit
// a `[xyz]` that pdflatex would later complain about.
const VALID_PLACEMENT = /^[htbpH]+$/;

function sanitisePlacement(p: string | undefined): string {
  const v = (p ?? '').trim();
  if (!v) return 'h';
  return VALID_PLACEMENT.test(v) ? v : 'h';
}

export function generateFigureLatex(opts: FigureOpts): string {
  const { path, width, placement, caption, label } = opts;

  const placeSpec = sanitisePlacement(placement);

  const widthSpec = (width ?? '').trim();
  const hasWidth = widthSpec.length > 0;
  const includeArgs = hasWidth ? `[width=${widthSpec}]` : '';
  const includeLine = `\\includegraphics${includeArgs}{${path}}`;

  const hasCaption = (caption ?? '').trim().length > 0;
  const hasLabel = (label ?? '').trim().length > 0;

  const lines: string[] = [];
  lines.push(`\\begin{figure}[${placeSpec}]`);
  lines.push('\\centering');
  lines.push(includeLine);
  if (hasCaption) lines.push(`\\caption{${caption}}`);
  if (hasLabel) lines.push(`\\label{fig:${label}}`);
  lines.push('\\end{figure}');
  return lines.join('\n') + '\n';
}
