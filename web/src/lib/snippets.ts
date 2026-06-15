// snippets.ts — curated default snippet set + a CodeMirror
// CompletionSource that surfaces snippets in the autocomplete
// pipeline.
//
// Snippets follow CodeMirror's template syntax :
//   ${name}   → tab stop with a placeholder label
//   ${}       → tab stop without a label
//
// After completion the user presses Tab to cycle through tab stops ;
// nextSnippetField + prevSnippetField from @codemirror/autocomplete
// drive the navigation (already in defaultKeymap).
//
// Three groups :
//   - LaTeX (begin, section, frac, table, figure, item, …)
//   - Markdown (link, image, code fence, table)
//   - JS / TS (fn, const, import, log)
//
// Future : user-defined snippets persisted under .weft-loom/snippets.json.
// V0.1 ships only the curated defaults.

import { snippetCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';

interface SnippetDef {
  label: string;
  detail?: string;
  template: string;
  // Optional comma-separated list of language slugs ; undefined = all.
  langs?: string;
  // Type drives the autocomplete icon : 'keyword', 'function', 'class',
  // 'snippet' (snippet is the natural fit but its icon is sometimes
  // missing in older themes — 'keyword' is a safer fallback).
  type?: string;
}

// Each template uses CodeMirror's snippet markers :
//   ${name}  → placeholder
//   ${}      → empty cursor stop
// The end-cursor falls at the last position automatically.
const SNIPPETS: SnippetDef[] = [
  // ---------------- LaTeX ----------------
  {
    label: 'begin',
    detail: '\\begin{env} … \\end{env}',
    langs: 'latex',
    type: 'snippet',
    template: '\\begin{${env}}\n\t${}\n\\end{${env}}',
  },
  {
    label: 'section',
    detail: '\\section{…}',
    langs: 'latex',
    type: 'snippet',
    template: '\\section{${title}}\n${}',
  },
  {
    label: 'subsection',
    detail: '\\subsection{…}',
    langs: 'latex',
    type: 'snippet',
    template: '\\subsection{${title}}\n${}',
  },
  {
    label: 'subsubsection',
    detail: '\\subsubsection{…}',
    langs: 'latex',
    type: 'snippet',
    template: '\\subsubsection{${title}}\n${}',
  },
  {
    label: 'frac',
    detail: '\\frac{a}{b}',
    langs: 'latex',
    type: 'snippet',
    template: '\\frac{${num}}{${den}}${}',
  },
  {
    label: 'sum',
    detail: '\\sum_{i=…}^{n}',
    langs: 'latex',
    type: 'snippet',
    template: '\\sum_{${i=0}}^{${n}} ${}',
  },
  {
    label: 'int',
    detail: '\\int_{a}^{b}',
    langs: 'latex',
    type: 'snippet',
    template: '\\int_{${a}}^{${b}} ${} \\, d${x}',
  },
  {
    label: 'item',
    detail: 'itemize block',
    langs: 'latex',
    type: 'snippet',
    template: '\\begin{itemize}\n\t\\item ${}\n\\end{itemize}',
  },
  {
    label: 'enum',
    detail: 'enumerate block',
    langs: 'latex',
    type: 'snippet',
    template: '\\begin{enumerate}\n\t\\item ${}\n\\end{enumerate}',
  },
  {
    label: 'table',
    detail: 'tabular block',
    langs: 'latex',
    type: 'snippet',
    template: '\\begin{table}[h]\n\t\\centering\n\t\\begin{tabular}{${ccc}}\n\t\t\\hline\n\t\t${a} & ${b} & ${c} \\\\\n\t\t\\hline\n\t\\end{tabular}\n\t\\caption{${caption}}\n\t\\label{tab:${label}}\n\\end{table}',
  },
  {
    label: 'figure',
    detail: 'figure with includegraphics',
    langs: 'latex',
    type: 'snippet',
    template: '\\begin{figure}[h]\n\t\\centering\n\t\\includegraphics[width=${0.8}\\textwidth]{${path}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}',
  },
  {
    label: 'eqn',
    detail: 'numbered equation',
    langs: 'latex',
    type: 'snippet',
    template: '\\begin{equation}\n\t${}\n\t\\label{eq:${label}}\n\\end{equation}',
  },
  {
    label: 'align',
    detail: 'aligned equation block',
    langs: 'latex',
    type: 'snippet',
    template: '\\begin{align}\n\t${} &= ${} \\\\\n\\end{align}',
  },
  {
    label: 'cite',
    detail: '\\cite{key}',
    langs: 'latex',
    type: 'snippet',
    template: '\\cite{${key}}${}',
  },
  {
    label: 'ref',
    detail: '\\ref{label}',
    langs: 'latex',
    type: 'snippet',
    template: '\\ref{${label}}${}',
  },
  {
    label: 'href',
    detail: 'hyperref',
    langs: 'latex',
    type: 'snippet',
    template: '\\href{${url}}{${text}}${}',
  },
  // ---------------- Markdown ----------------
  {
    label: 'link',
    detail: '[text](url)',
    langs: 'markdown',
    type: 'snippet',
    template: '[${text}](${url})${}',
  },
  {
    label: 'image',
    detail: '![alt](url)',
    langs: 'markdown',
    type: 'snippet',
    template: '![${alt}](${url})${}',
  },
  {
    label: 'code',
    detail: 'fenced code block',
    langs: 'markdown',
    type: 'snippet',
    template: '```${lang}\n${}\n```',
  },
  {
    label: 'table',
    detail: 'markdown table',
    langs: 'markdown',
    type: 'snippet',
    template: '| ${head1} | ${head2} | ${head3} |\n|---|---|---|\n| ${a} | ${b} | ${c} |\n${}',
  },
  // ---------------- JavaScript / TypeScript ----------------
  {
    label: 'fn',
    detail: 'function declaration',
    langs: 'javascript,typescript',
    type: 'snippet',
    template: 'function ${name}(${args}) {\n\t${}\n}',
  },
  {
    label: 'afn',
    detail: 'arrow function',
    langs: 'javascript,typescript',
    type: 'snippet',
    template: 'const ${name} = (${args}) => {\n\t${}\n};',
  },
  {
    label: 'log',
    detail: 'console.log',
    langs: 'javascript,typescript',
    type: 'snippet',
    template: "console.log('${tag}', ${});",
  },
  {
    label: 'imp',
    detail: 'import statement',
    langs: 'javascript,typescript',
    type: 'snippet',
    template: "import { ${what} } from '${where}';${}",
  },
  // ---------------- Python ----------------
  {
    label: 'def',
    detail: 'function',
    langs: 'python',
    type: 'snippet',
    template: 'def ${name}(${args}):\n\t${}',
  },
  {
    label: 'cls',
    detail: 'class',
    langs: 'python',
    type: 'snippet',
    template: 'class ${Name}:\n\tdef __init__(self${args}):\n\t\t${}',
  },
  {
    label: 'main',
    detail: 'if __name__ == "__main__"',
    langs: 'python',
    type: 'snippet',
    template: 'if __name__ == "__main__":\n\t${}',
  },
  // ---------------- Go ----------------
  {
    label: 'func',
    detail: 'function',
    langs: 'go',
    type: 'snippet',
    template: 'func ${name}(${args}) ${ret} {\n\t${}\n}',
  },
  {
    label: 'iferr',
    detail: 'if err != nil',
    langs: 'go',
    type: 'snippet',
    template: 'if err != nil {\n\treturn ${fmt.Errorf("%w", err)}\n}\n${}',
  },
];

// snippetSource builds a CompletionSource. The active language is
// captured at extension-creation time ; if the editor's language flips
// the caller re-builds the extension via the existing language
// Compartment (see Editor.svelte).
export function snippetSource(language: string) {
  // Pre-filter to the language's snippets so the per-keystroke path
  // doesn't re-walk the full table. Snippets without a `langs` field
  // are universal and always included.
  const pool = SNIPPETS.filter((s) => !s.langs || s.langs.split(',').includes(language));
  const completions = pool.map((s) =>
    snippetCompletion(s.template, {
      label: s.label,
      detail: s.detail,
      type: s.type ?? 'snippet',
      // boost = 1 keeps snippets just above the language-pack
      // completions of the same prefix so users get the snippet for
      // common stems like "imp" / "fn" / "begin".
      boost: 1,
    }),
  );
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[A-Za-z]+/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return {
      from: word.from,
      options: completions,
      validFor: /^[A-Za-z]*$/,
    };
  };
}

// snippetCount returns how many snippets are surfaced for a given
// language. Useful for the test harness + the future settings UI
// ("12 snippets active for LaTeX").
export function snippetCount(language: string): number {
  return SNIPPETS.filter((s) => !s.langs || s.langs.split(',').includes(language)).length;
}
