// latexWysiwyg.ts — bi-directional LaTeX ↔ HTML translation for
// the Word-like editable surface. The contract :
//
//   parseLatex(source)        → { preamble, bodyHtml }
//   serializeLatex({pre, html}) → LaTeX source
//
// Round-trip rule : any LaTeX construct we don't understand is
// preserved verbatim via a `<span class="latex-raw" data-tex="…">`
// wrapper. The serialize step unwraps these back to their original
// bytes, so a document opened + saved without UI edits is
// byte-identical to the original.
//
// Supported subset (V0.1) :
//   - \section{X} → <h1>, \subsection{X} → <h2>, \subsubsection{X} → <h3>
//   - \textbf{X} → <strong>, \textit{X} / \emph{X} → <em>
//   - \texttt{X} → <code>, \underline{X} → <u>
//   - \begin{itemize} \item … → <ul><li>
//   - \begin{enumerate} \item … → <ol><li>
//   - $…$  → <span class="math math-inline" data-tex="…">…</span>
//   - \[…\] → <div class="math math-display" data-tex="…">…</div>
//   - \href{url}{label} → <a href="url">label</a>
//   - Plain paragraphs separated by blank lines → <p>…</p>
//   - The preamble (everything before \begin{document}) + the
//     \end{document} tail are kept VERBATIM, not parsed
//
// Anything else (\frac, \cite, \label, \ref, custom \newcommand
// invocations, comments, %, tables, figures, \input) round-trips as
// a `<span class="latex-raw">` to be displayed inline + edited as
// LaTeX-source when the cursor lands on it. V0.2 lifts more
// constructs out of latex-raw into native HTML.

export interface ParsedLatex {
  /** Everything up to and including `\begin{document}`. Verbatim. */
  preamble: string;
  /** HTML representation of the body between `\begin{document}` and `\end{document}`. */
  bodyHtml: string;
  /** Trailing source after `\end{document}` (typically a newline). Verbatim. */
  postamble: string;
}

// ─── parse ───────────────────────────────────────────────────────

const RE_BEGIN_DOC = /\\begin\{document\}/;
const RE_END_DOC = /\\end\{document\}/;

export function parseLatex(source: string): ParsedLatex {
  const beginMatch = source.match(RE_BEGIN_DOC);
  if (!beginMatch || beginMatch.index === undefined) {
    // No document environment ; treat the whole file as body so the
    // user can still edit something. The preamble is empty.
    return {
      preamble: '',
      bodyHtml: latexBodyToHtml(source),
      postamble: '',
    };
  }
  const bodyStart = beginMatch.index + beginMatch[0].length;
  const endMatch = source.slice(bodyStart).match(RE_END_DOC);
  const endIdx = endMatch && endMatch.index !== undefined
    ? bodyStart + endMatch.index
    : source.length;
  return {
    preamble: source.slice(0, bodyStart),
    bodyHtml: latexBodyToHtml(source.slice(bodyStart, endIdx)),
    postamble: source.slice(endIdx),
  };
}

// latexBodyToHtml is exported for tests. Walks the body once,
// emitting HTML nodes for the known constructs + falling back to
// latex-raw spans for everything else.
export function latexBodyToHtml(body: string): string {
  // Strategy : split into block-level chunks (paragraphs +
  // environments + section headings), then inline-translate each.
  const out: string[] = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      // Blank line = paragraph break ; skip.
      i++;
      continue;
    }

    // Section headings : single-line constructs. The regex captures
    // the FIRST balanced brace pair (non-greedy [^{}]*) so a
    // `\section{Intro}\label{sec:intro}` on the same line splits
    // cleanly : heading title goes inline-parsed into <h>, and any
    // trailing \label{} (or other inline commands) get rendered as
    // sibling children of the heading via inlineLatexToHtml.
    const heading = trimmed.match(/^\\(section|subsection|subsubsection)\*?\{([^{}]*)\}(.*)$/);
    if (heading) {
      const level = heading[1] === 'section' ? 1 : heading[1] === 'subsection' ? 2 : 3;
      const title = inlineLatexToHtml(heading[2]);
      const trailing = heading[3].trim();
      const trail = trailing ? inlineLatexToHtml(trailing) : '';
      out.push(`<h${level}>${title}${trail}</h${level}>`);
      i++;
      continue;
    }

    // Environments (itemize / enumerate / display-math) span lines.
    const envOpen = trimmed.match(/^\\begin\{(itemize|enumerate)\}/);
    if (envOpen) {
      const envName = envOpen[1];
      const tag = envName === 'itemize' ? 'ul' : 'ol';
      const items: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^\s*\\end\{[^}]+\}/)) {
        const l = lines[i].trim();
        const itemMatch = l.match(/^\\item\s*(.*)$/);
        if (itemMatch) {
          items.push(`<li>${inlineLatexToHtml(itemMatch[1])}</li>`);
        } else if (l && items.length > 0) {
          // Continuation of the last item.
          items[items.length - 1] = items[items.length - 1].replace(
            /<\/li>$/,
            ' ' + inlineLatexToHtml(l) + '</li>',
          );
        }
        i++;
      }
      i++; // consume \end{...}
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // equation / align / equation* / align* — render as display
     // math via KaTeX (the editor swaps the rendered HTML in,
     // data-env carries the original env name for serialisation).
    const mathEnv = trimmed.match(/^\\begin\{(equation|align|gather|multline)\*?\}/);
    if (mathEnv) {
      const envName = trimmed.match(/^\\begin\{([^}]+)\}/)?.[1] ?? mathEnv[1];
      const buf: string[] = [trimmed.slice(('\\begin{' + envName + '}').length)];
      i++;
      while (i < lines.length && !lines[i].match(/^\s*\\end\{[^}]+\}/)) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume \end{…}
      const tex = buf.join('\n').trim();
      // Extract any \label{x} from the math body : keep it in
      // data-tex (so the source round-trip is byte-faithful) but
      // ALSO emit a NESTED <span class="latex-label"> inside the
      // math-env div so refResolver's ancestor-walk detects kind='eq'
      // and assigns the per-kind counter correctly. KaTeX rendering
      // overwrites .innerHTML on first render — we put the label
      // span back via the editor's renderMathNodes pipeline (the
      // label survives serialization through data-tex).
      const labelMatch = tex.match(/\\label\{([^}]+)\}/);
      const labelHtml = labelMatch
        ? `<span class="latex-label" data-label="${escapeAttr(labelMatch[1])}" contenteditable="false" title="label: ${escapeAttr(labelMatch[1])}" style="display:none">¶</span>`
        : '';
      out.push(`<div class="math math-env" data-tex="${escapeAttr(tex)}" data-env="${escapeAttr(envName)}">\\begin{${escapeHtml(envName)}}${escapeHtml(tex)}\\end{${escapeHtml(envName)}}${labelHtml}</div>`);
      continue;
    }

    // tabular : <table> with one tr per `\\`-separated row, one td
    // per `&`-separated cell. The column spec carries through via
    // data-spec ; \hline lines turn into a `border-top` on the
    // following row.
    const tabularOpen = trimmed.match(/^\\begin\{tabular\}\{([^}]*)\}/);
    if (tabularOpen) {
      const spec = tabularOpen[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^\s*\\end\{tabular\}/)) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume \end{tabular}
      // Strip \hline + split on `\\` to get rows.
      const body = buf.join('\n');
      const rows = body.split(/\\\\/).map((row) => row.replace(/\\hline/g, '').trim());
      const trs = rows.filter((r) => r.length > 0).map((row) => {
        const cells = splitTabularCells(row);
        return '<tr>' + cells.map((c) => `<td>${inlineLatexToHtml(c.trim())}</td>`).join('') + '</tr>';
      }).join('');
      out.push(`<table class="latex-tabular" data-spec="${escapeAttr(spec)}">${trs}</table>`);
      continue;
    }

    // figure env : \begin{figure}[opts]...\end{figure}. Inside we
    // recognize \centering (consumed), \includegraphics, \caption,
    // \label. Anything else inside is ignored (V0.1 — multi-image
    // figures or stray text could be a follow-up).
    const figureOpen = trimmed.match(/^\\begin\{figure\}(\[[^\]]*\])?/);
    if (figureOpen) {
      const figOpts = figureOpen[1] ? figureOpen[1].slice(1, -1) : '';
      let imgHtml = '';
      let captionHtml = '';
      let labelHtml = '';
      i++;
      while (i < lines.length && !lines[i].match(/^\s*\\end\{figure\}/)) {
        const l = lines[i].trim();
        if (l === '\\centering' || l === '') {
          i++;
          continue;
        }
        const imgMatch = l.match(/^\\includegraphics(\[[^\]]*\])?\{([^}]*)\}/);
        if (imgMatch) {
          const imgOpts = imgMatch[1] ? imgMatch[1].slice(1, -1) : '';
          const path = imgMatch[2];
          imgHtml = `<img class="latex-figure" src="" data-path="${escapeAttr(path)}" data-opts="${escapeAttr(imgOpts)}" alt="${escapeAttr(path)}" />`;
          i++;
          continue;
        }
        const capMatch = l.match(/^\\caption\{(.*)\}$/);
        if (capMatch) {
          captionHtml = `<figcaption>${inlineLatexToHtml(capMatch[1])}</figcaption>`;
          i++;
          continue;
        }
        const lblMatch = l.match(/^\\label\{([^}]*)\}$/);
        if (lblMatch) {
          const lbl = lblMatch[1];
          labelHtml = `<span class="latex-label" data-label="${escapeAttr(lbl)}" contenteditable="false" title="label: ${escapeAttr(lbl)}">¶</span>`;
          i++;
          continue;
        }
        // Unknown line inside the figure : skip (V0.1).
        i++;
      }
      i++; // consume \end{figure}
      out.push(`<figure class="latex-figure-env" data-opts="${escapeAttr(figOpts)}">${imgHtml}${captionHtml}${labelHtml}</figure>`);
      continue;
    }

    // Theorem-like envs : theorem/lemma/proof/definition/corollary/
    // proposition/remark/example (+ * variants). Body is joined +
    // parsed inline ; the header text is title-cased env name (no
    // numbering — that's the rendering layer's job).
    const thmOpen = trimmed.match(/^\\begin\{(theorem|lemma|proof|definition|corollary|proposition|remark|example)\*?\}/);
    if (thmOpen) {
      const envName = trimmed.match(/^\\begin\{([^}]+)\}/)?.[1] ?? thmOpen[1];
      const baseName = thmOpen[1];
      const headerText = baseName.charAt(0).toUpperCase() + baseName.slice(1);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^\s*\\end\{[^}]+\}/)) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume \end{...}
      const body = inlineLatexToHtml(buf.join('\n').trim());
      out.push(`<div class="latex-theorem" data-env="${escapeAttr(envName)}"><div class="latex-theorem-header">${escapeHtml(headerText)}</div><div class="latex-theorem-body">${body}</div></div>`);
      continue;
    }

    // Display-math delimited environments — match the LITERAL `\[`
    // opening (no real LaTeX command after the backslash, just the
    // bracket pair).
    if (trimmed.startsWith('\\[')) {
      const buf: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length && !lines[i].includes('\\]')) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const endIdx = lines[i].indexOf('\\]');
        buf.push(lines[i].slice(0, endIdx));
        i++;
      }
      const tex = buf.join('\n').trim();
      out.push(`<div class="math math-display" data-tex="${escapeAttr(tex)}">\\[${escapeHtml(tex)}\\]</div>`);
      continue;
    }

    // Plain paragraph : accumulate consecutive non-blank lines.
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' &&
           !lines[i].trim().match(/^\\(section|subsection|subsubsection|begin|\[)/)) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineLatexToHtml(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

// inlineLatexToHtml handles inline constructs : \textbf, \textit,
// $…$, \href, etc. Recursive-descent friendly — we walk char by
// char + recognise commands.
export function inlineLatexToHtml(s: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const cmd = readCommand(s, i);
      if (cmd) {
        const html = renderInlineCommand(cmd.name, cmd.args);
        out.push(html);
        i = cmd.end;
        continue;
      }
      // Unknown backslash sequence — emit verbatim as latex-raw up
      // to the next whitespace.
      const next = s.slice(i).match(/^\\[a-zA-Z]+\*?/);
      if (next) {
        out.push(rawSpan(next[0]));
        i += next[0].length;
        continue;
      }
      out.push(rawSpan(ch));
      i++;
      continue;
    }
    if (ch === '$') {
      // Inline math : $…$. Doubled `$$` is display math but we
      // only see it inline here ; treat that as a single $.
      const end = findInlineMathEnd(s, i + 1);
      if (end >= 0) {
        const tex = s.slice(i + 1, end);
        out.push(`<span class="math math-inline" data-tex="${escapeAttr(tex)}">$${escapeHtml(tex)}$</span>`);
        i = end + 1;
        continue;
      }
    }
    if (ch === '<' || ch === '>' || ch === '&') {
      out.push(escapeHtml(ch));
      i++;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

// splitTabularCells splits a tabular row on unescaped `&`. Skips
// `\&` (an `&` in user text) as well as `\\` cell-ends embedded in
// math `$…$` blocks (rare but possible — we don't want to lose a
// cell because the user typed `a & b` inside `$$`).
function splitTabularCells(row: string): string[] {
  const cells: string[] = [];
  let depth = 0;
  let inMath = false;
  let buf = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) {
      buf += ch + row[i + 1];
      i++;
      continue;
    }
    if (ch === '$') inMath = !inMath;
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === '&' && depth === 0 && !inMath) {
      cells.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  return cells;
}

// findInlineMathEnd locates the matching `$` for an inline-math
// segment, skipping escaped `\$` along the way.
function findInlineMathEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '$') return i;
    if (s[i] === '\n' && s[i + 1] === '\n') return -1; // paragraph break = malformed
  }
  return -1;
}

interface CommandRead {
  name: string;
  args: string[];
  end: number;
}

// readCommand parses `\name[opt]{arg}{arg}...` at position i.
// Collects every consecutive brace-pair AND optional bracket-pair
// following the name. Returns null when the input doesn't start
// with a command-shaped sequence. Optional `[opts]` are included
// as the first arg (so \includegraphics[width=5cm]{x.png} yields
// args = ["width=5cm", "x.png"]).
function readCommand(s: string, i: number): CommandRead | null {
  const m = s.slice(i).match(/^\\([a-zA-Z]+)\*?/);
  if (!m) return null;
  let j = i + m[0].length;
  const args: string[] = [];
  while (j < s.length) {
    if (s[j] === '[') {
      const end = findMatching(s, j, '[', ']');
      if (end < 0) break;
      args.push(s.slice(j + 1, end));
      j = end + 1;
      continue;
    }
    if (s[j] === '{') {
      const end = findMatching(s, j, '{', '}');
      if (end < 0) break;
      args.push(s.slice(j + 1, end));
      j = end + 1;
      continue;
    }
    break;
  }
  if (args.length === 0) {
    // Bare command like \LaTeX with no args ; treat as raw.
    return null;
  }
  return { name: m[1], args, end: j };
}

// findMatching returns the index of the closing delim that
// balances the opening one at `start`, respecting nested pairs
// and backslash-escaped chars. -1 if unbalanced.
function findMatching(s: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let j = start + 1; j < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length) { j++; continue; }
    if (s[j] === open) depth++;
    else if (s[j] === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function renderInlineCommand(name: string, args: string[]): string {
  if (args.length === 0) return rawSpan('\\' + name);
  const arg = args[0];
  const inner = inlineLatexToHtml(arg);
  switch (name) {
    case 'textbf':
      return `<strong>${inner}</strong>`;
    case 'textit':
    case 'emph':
      return `<em>${inner}</em>`;
    case 'texttt':
      return `<code>${inner}</code>`;
    case 'underline':
      return `<u>${inner}</u>`;
    case 'href':
      // \href{url}{label}
      if (args.length >= 2) {
        return `<a href="${escapeAttr(args[0])}">${inlineLatexToHtml(args[1])}</a>`;
      }
      return `<a href="${escapeAttr(arg)}">${escapeHtml(arg)}</a>`;
    case 'url':
      return `<a href="${escapeAttr(arg)}">${escapeHtml(arg)}</a>`;
    case 'cite':
      return `<span class="latex-cite" data-key="${escapeAttr(arg)}" contenteditable="false">[${escapeHtml(arg)}]</span>`;
    case 'ref':
      return `<span class="latex-ref" data-label="${escapeAttr(arg)}" contenteditable="false">[ref:${escapeHtml(arg)}]</span>`;
    case 'label':
      return `<span class="latex-label" data-label="${escapeAttr(arg)}" contenteditable="false" title="label: ${escapeAttr(arg)}">¶</span>`;
    case 'footnote':
      return `<span class="latex-footnote" data-tex="${escapeAttr(arg)}" contenteditable="false" title="footnote">†</span>`;
    case 'includegraphics': {
      // \includegraphics[opts]{path} : opts in args[0] when bracket
      // syntax was used, path in args[args.length - 1].
      const path = args[args.length - 1];
      const opts = args.length > 1 ? args[0] : '';
      return `<img class="latex-figure" src="" data-path="${escapeAttr(path)}" data-opts="${escapeAttr(opts)}" alt="${escapeAttr(path)}" />`;
    }
    default:
      return rawSpan(`\\${name}${args.map((a) => '{' + a + '}').join('')}`);
  }
}

function rawSpan(tex: string): string {
  return `<span class="latex-raw" data-tex="${escapeAttr(tex)}">${escapeHtml(tex)}</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}

// ─── serialize ───────────────────────────────────────────────────

// serializeLatex inverts parseLatex : re-attaches the preserved
// preamble + walks the contenteditable HTML back to LaTeX source.
export function serializeLatex(parsed: ParsedLatex, currentBodyHtml: string): string {
  // currentBodyHtml is the LIVE state from the contenteditable ;
  // parsed.bodyHtml was the initial parse. We always serialize from
  // the live state to capture user edits.
  return parsed.preamble + '\n' + htmlBodyToLatex(currentBodyHtml) + '\n' + parsed.postamble.trimStart();
}

// htmlBodyToLatex parses the live contenteditable HTML back to
// LaTeX source. Uses DOMParser when available (browser) ; falls
// back to a regex pass in node tests.
export function htmlBodyToLatex(html: string): string {
  if (typeof DOMParser === 'undefined') {
    return htmlBodyToLatexRegex(html);
  }
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';
  return nodeToLatex(root).trim() + '\n';
}

function nodeToLatex(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(nodeToLatex).join('');
  switch (tag) {
    case 'h1': return `\\section{${inner}}\n`;
    case 'h2': return `\\subsection{${inner}}\n`;
    case 'h3': return `\\subsubsection{${inner}}\n`;
    case 'strong':
    case 'b': return `\\textbf{${inner}}`;
    case 'em':
    case 'i': return `\\textit{${inner}}`;
    case 'code': return `\\texttt{${inner}}`;
    case 'u': return `\\underline{${inner}}`;
    case 'a': {
      const href = (el as HTMLAnchorElement).getAttribute('href') ?? '';
      return `\\href{${href}}{${inner}}`;
    }
    case 'img': {
      const path = el.getAttribute('data-path') ?? '';
      const opts = el.getAttribute('data-opts') ?? '';
      return opts ? `\\includegraphics[${opts}]{${path}}` : `\\includegraphics{${path}}`;
    }
    case 'ul': {
      const items = Array.from(el.querySelectorAll(':scope > li'))
        .map((li) => `  \\item ${nodeChildrenToLatex(li)}`)
        .join('\n');
      return `\\begin{itemize}\n${items}\n\\end{itemize}\n`;
    }
    case 'ol': {
      const items = Array.from(el.querySelectorAll(':scope > li'))
        .map((li) => `  \\item ${nodeChildrenToLatex(li)}`)
        .join('\n');
      return `\\begin{enumerate}\n${items}\n\\end{enumerate}\n`;
    }
    case 'table': {
      const spec = el.getAttribute('data-spec') ?? 'l';
      const rows = Array.from(el.querySelectorAll(':scope > tr, :scope > tbody > tr'));
      const body = rows.map((tr) => {
        const cells = Array.from(tr.querySelectorAll(':scope > td')).map((td) => nodeChildrenToLatex(td));
        return cells.join(' & ');
      }).join(' \\\\\n');
      return `\\begin{tabular}{${spec}}\n${body}\n\\end{tabular}\n`;
    }
    case 'p': return inner + '\n\n';
    case 'figure': {
      if (el.className.includes('latex-figure-env')) {
        const figOpts = el.getAttribute('data-opts') ?? '';
        const img = el.querySelector(':scope > img.latex-figure');
        const cap = el.querySelector(':scope > figcaption');
        const lbl = el.querySelector(':scope > .latex-label');
        const parts: string[] = [];
        parts.push(figOpts ? `\\begin{figure}[${figOpts}]` : `\\begin{figure}`);
        parts.push('\\centering');
        if (img) {
          const path = img.getAttribute('data-path') ?? '';
          const opts = img.getAttribute('data-opts') ?? '';
          parts.push(opts ? `\\includegraphics[${opts}]{${path}}` : `\\includegraphics{${path}}`);
        }
        if (cap) {
          parts.push(`\\caption{${nodeChildrenToLatex(cap)}}`);
        }
        if (lbl) {
          parts.push(`\\label{${lbl.getAttribute('data-label') ?? ''}}`);
        }
        parts.push('\\end{figure}');
        return parts.join('\n') + '\n';
      }
      return inner;
    }
    case 'div':
    case 'span': {
      const cls = el.className;
      if (cls.includes('latex-theorem')) {
        const env = el.getAttribute('data-env') ?? 'theorem';
        const body = el.querySelector(':scope > .latex-theorem-body');
        const bodyTex = body ? nodeChildrenToLatex(body) : '';
        return `\\begin{${env}}\n${bodyTex}\n\\end{${env}}\n`;
      }
      if (cls.includes('math-env')) {
        const env = el.getAttribute('data-env') ?? 'equation';
        const tex = el.getAttribute('data-tex') ?? inner;
        return `\\begin{${env}}\n${tex}\n\\end{${env}}\n`;
      }
      if (cls.includes('math-display')) {
        return `\\[${el.getAttribute('data-tex') ?? inner}\\]\n`;
      }
      if (cls.includes('math-inline')) {
        return `$${el.getAttribute('data-tex') ?? inner}$`;
      }
      if (cls.includes('latex-raw')) {
        return el.getAttribute('data-tex') ?? inner;
      }
      if (cls.includes('latex-cite')) {
        return `\\cite{${el.getAttribute('data-key') ?? ''}}`;
      }
      if (cls.includes('latex-ref')) {
        return `\\ref{${el.getAttribute('data-label') ?? ''}}`;
      }
      if (cls.includes('latex-label')) {
        return `\\label{${el.getAttribute('data-label') ?? ''}}`;
      }
      if (cls.includes('latex-footnote')) {
        return `\\footnote{${el.getAttribute('data-tex') ?? ''}}`;
      }
      return inner;
    }
    case 'br': return '\n';
    default: return inner;
  }
}

function nodeChildrenToLatex(el: Element): string {
  return Array.from(el.childNodes).map(nodeToLatex).join('').trim();
}

// htmlBodyToLatexRegex : fallback when DOMParser isn't available
// (node tests). Best-effort ; not byte-identical with the browser
// path but good enough for unit-test round-trip checks.
function htmlBodyToLatexRegex(html: string): string {
  return html
    // Figure env first : capture the whole <figure> + extract child
    // img / figcaption / label via sub-patterns. Done before the
    // raw <img> + <span class="latex-label"> rules below so the
    // inner children don't get serialised prematurely.
    .replace(/<figure\s+class="latex-figure-env"(?:\s+data-opts="([^"]*)")?[^>]*>([\s\S]*?)<\/figure>/g, (_, optsAttr, inner) => {
      const figOpts = optsAttr ? unescapeAttr(optsAttr) : '';
      const parts: string[] = [];
      parts.push(figOpts ? `\\begin{figure}[${figOpts}]` : `\\begin{figure}`);
      parts.push('\\centering');
      const imgM = inner.match(/<img\s+([^>]*?)\/?>/);
      if (imgM) {
        const attrs = imgM[1];
        const pathM = attrs.match(/data-path="([^"]*)"/);
        const optsM = attrs.match(/data-opts="([^"]*)"/);
        const path = pathM ? unescapeAttr(pathM[1]) : '';
        const opts = optsM ? unescapeAttr(optsM[1]) : '';
        parts.push(opts ? `\\includegraphics[${opts}]{${path}}` : `\\includegraphics{${path}}`);
      }
      const capM = inner.match(/<figcaption>([\s\S]*?)<\/figcaption>/);
      if (capM) {
        // Strip inner tags ; caption text is plain in the regex
        // fallback (DOMParser path handles nested commands).
        const capText = capM[1].replace(/<[^>]+>/g, '').trim();
        parts.push(`\\caption{${capText}}`);
      }
      const lblM = inner.match(/<span\s+class="latex-label"\s+data-label="([^"]*)"[^>]*>[\s\S]*?<\/span>/);
      if (lblM) {
        parts.push(`\\label{${unescapeAttr(lblM[1])}}`);
      }
      parts.push('\\end{figure}');
      return parts.join('\n') + '\n';
    })
    // Theorem-like envs : capture the wrapper + emit \begin{env}...
    // \end{env}. Body div contents are inlined ; the header div is
    // discarded (it's display-only).
    .replace(/<div\s+class="latex-theorem"\s+data-env="([^"]*)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g, (_, envAttr, inner) => {
      const env = unescapeAttr(envAttr);
      const bodyM = inner.match(/<div\s+class="latex-theorem-body"[^>]*>([\s\S]*)$/);
      const bodyHtml = bodyM ? bodyM[1] : '';
      const bodyText = bodyHtml.replace(/<[^>]+>/g, '').trim();
      return `\\begin{${env}}\n${bodyText}\n\\end{${env}}\n`;
    })
    // Lists first : the inner <li> patterns must not collide with
    // the plain-text inline replacements below.
    .replace(/<ul>([\s\S]*?)<\/ul>/g, (_, inner) => {
      const items = inner
        .split(/<\/li>/)
        .map((s: string) => s.replace(/^.*?<li>/s, '').trim())
        .filter((s: string) => s.length > 0)
        .map((s: string) => `  \\item ${s}`)
        .join('\n');
      return `\\begin{itemize}\n${items}\n\\end{itemize}\n`;
    })
    .replace(/<ol>([\s\S]*?)<\/ol>/g, (_, inner) => {
      const items = inner
        .split(/<\/li>/)
        .map((s: string) => s.replace(/^.*?<li>/s, '').trim())
        .filter((s: string) => s.length > 0)
        .map((s: string) => `  \\item ${s}`)
        .join('\n');
      return `\\begin{enumerate}\n${items}\n\\end{enumerate}\n`;
    })
    .replace(/<h1>(.*?)<\/h1>/gs, '\\section{$1}\n')
    .replace(/<h2>(.*?)<\/h2>/gs, '\\subsection{$1}\n')
    .replace(/<h3>(.*?)<\/h3>/gs, '\\subsubsection{$1}\n')
    .replace(/<strong>(.*?)<\/strong>/gs, '\\textbf{$1}')
    .replace(/<em>(.*?)<\/em>/gs, '\\textit{$1}')
    .replace(/<code>(.*?)<\/code>/gs, '\\texttt{$1}')
    .replace(/<u>(.*?)<\/u>/gs, '\\underline{$1}')
    .replace(/<a\s+href="([^"]+)">(.*?)<\/a>/gs, '\\href{$1}{$2}')
    .replace(/<p>(.*?)<\/p>/gs, '$1\n\n')
    .replace(/<span\s+class="latex-raw"\s+data-tex="([^"]*)"[^>]*>.*?<\/span>/gs, (_, tex) => unescapeAttr(tex))
    .replace(/<span\s+class="latex-cite"\s+data-key="([^"]*)"[^>]*>.*?<\/span>/gs, (_, key) => `\\cite{${unescapeAttr(key)}}`)
    .replace(/<span\s+class="latex-ref"\s+data-label="([^"]*)"[^>]*>.*?<\/span>/gs, (_, lbl) => `\\ref{${unescapeAttr(lbl)}}`)
    .replace(/<span\s+class="latex-label"\s+data-label="([^"]*)"[^>]*>.*?<\/span>/gs, (_, lbl) => `\\label{${unescapeAttr(lbl)}}`)
    .replace(/<span\s+class="latex-footnote"\s+data-tex="([^"]*)"[^>]*>.*?<\/span>/gs, (_, tex) => `\\footnote{${unescapeAttr(tex)}}`)
    .replace(/<img\s+([^>]*?)\/?>/g, (_, attrs) => {
      const pathM = attrs.match(/data-path="([^"]*)"/);
      const optsM = attrs.match(/data-opts="([^"]*)"/);
      const path = pathM ? unescapeAttr(pathM[1]) : '';
      const opts = optsM ? unescapeAttr(optsM[1]) : '';
      return opts ? `\\includegraphics[${opts}]{${path}}` : `\\includegraphics{${path}}`;
    })
    .replace(/<span\s+class="math math-inline"\s+data-tex="([^"]*)"[^>]*>.*?<\/span>/gs, (_, tex) => `$${unescapeAttr(tex)}$`)
    .replace(/<div\s+class="math math-display"\s+data-tex="([^"]*)"[^>]*>.*?<\/div>/gs, (_, tex) => `\\[${unescapeAttr(tex)}\\]\n`)
    .replace(/<div\s+class="math math-env"\s+([^>]*)>.*?<\/div>/gs, (_, attrs) => {
      const envM = attrs.match(/data-env="([^"]*)"/);
      const texM = attrs.match(/data-tex="([^"]*)"/);
      const env = envM ? unescapeAttr(envM[1]) : 'equation';
      const tex = texM ? unescapeAttr(texM[1]) : '';
      return `\\begin{${env}}\n${tex}\n\\end{${env}}\n`;
    })
    .replace(/<table\s+class="latex-tabular"\s+data-spec="([^"]*)"[^>]*>([\s\S]*?)<\/table>/gs, (_, spec, body) => {
      const rows = body.split(/<\/tr>/i)
        .map((r: string) => r.replace(/^.*?<tr[^>]*>/is, ''))
        .filter((r: string) => r.includes('<td'))
        .map((r: string) => {
          const cells = r.split(/<\/td>/i)
            .map((c: string) => c.replace(/^.*?<td[^>]*>/is, ''))
            .filter((c: string) => c.length > 0 || c === '');
          // The split above produces a trailing empty after the last </td>.
          if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
          return cells.map((c: string) => c.replace(/<[^>]+>/g, '').trim()).join(' & ');
        })
        .join(' \\\\\n');
      return `\\begin{tabular}{${unescapeAttr(spec)}}\n${rows}\n\\end{tabular}\n`;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim() + '\n';
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}
