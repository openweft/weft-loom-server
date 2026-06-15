// latex-wysiwyg-roundtrip.mjs — node tests for the LaTeX↔HTML
// parser. Pins :
//   - parseLatex preserves the preamble verbatim
//   - inline commands (textbf, textit, texttt, $...$) become HTML
//   - block structures (section, itemize, \[...\]) become block HTML
//   - unknown commands round-trip via latex-raw spans
//   - serialize ∘ parse on a typical article body is a no-op
//     (ignoring whitespace tweaks)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from '../web/node_modules/esbuild/lib/main.js';

// Compile the .ts file via esbuild + load it as CJS. Robust against
// any TS syntax we throw at it (vs the regex-strip hack earlier
// tests use).
const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../web/src/lib/latexWysiwyg.ts');
const src = readFileSync(srcPath, 'utf8');

const built = esbuild.transformSync(src, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
});

// Force the regex fallback : DOMParser is undefined in node.
const wrapped = built.code + `
module.exports = { parseLatex, latexBodyToHtml, inlineLatexToHtml, htmlBodyToLatex, serializeLatex };
`;
const module = { exports: {} };
new Function('module', 'exports', wrapped)(module, module.exports);
const { parseLatex, latexBodyToHtml, inlineLatexToHtml, htmlBodyToLatex, serializeLatex } = module.exports;

test('parseLatex : preserves preamble verbatim', () => {
  const src = `\\documentclass{article}
\\usepackage{amsmath}
\\title{X}
\\begin{document}
Body content.
\\end{document}
`;
  const { preamble } = parseLatex(src);
  assert.ok(preamble.includes('\\documentclass{article}'));
  assert.ok(preamble.includes('\\usepackage{amsmath}'));
  assert.ok(preamble.endsWith('\\begin{document}'));
});

test('parseLatex : extracts body as HTML', () => {
  const src = `\\begin{document}
\\section{Intro}
Hello \\textbf{world}.
\\end{document}`;
  const { bodyHtml } = parseLatex(src);
  assert.ok(bodyHtml.includes('<h1>Intro</h1>'));
  assert.ok(bodyHtml.includes('<strong>world</strong>'));
});

test('inlineLatexToHtml : textbf, textit, texttt, underline', () => {
  assert.equal(inlineLatexToHtml('\\textbf{bold}'), '<strong>bold</strong>');
  assert.equal(inlineLatexToHtml('\\textit{italic}'), '<em>italic</em>');
  assert.equal(inlineLatexToHtml('\\emph{e}'), '<em>e</em>');
  assert.equal(inlineLatexToHtml('\\texttt{code}'), '<code>code</code>');
  assert.equal(inlineLatexToHtml('\\underline{u}'), '<u>u</u>');
});

test('inlineLatexToHtml : nested commands', () => {
  const html = inlineLatexToHtml('\\textbf{bold \\textit{italic}}');
  assert.equal(html, '<strong>bold <em>italic</em></strong>');
});

test('inlineLatexToHtml : inline math $...$', () => {
  const html = inlineLatexToHtml('Pythagoras : $a^2 + b^2 = c^2$.');
  assert.ok(html.includes('class="math math-inline"'));
  assert.ok(html.includes('data-tex="a^2 + b^2 = c^2"'));
});

test('inlineLatexToHtml : unknown commands fall through to latex-raw', () => {
  // \frac is unknown V0.1 ; it should round-trip via latex-raw.
  const html = inlineLatexToHtml('\\frac{1}{2}');
  assert.ok(html.includes('class="latex-raw"'));
  assert.ok(html.includes('data-tex="\\frac{1}{2}"'));
});

test('latexBodyToHtml : section + paragraph', () => {
  const html = latexBodyToHtml('\\section{Title}\n\nFirst paragraph.');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<p>First paragraph.</p>'));
});

test('latexBodyToHtml : itemize → ul', () => {
  const html = latexBodyToHtml(`\\begin{itemize}
\\item First
\\item Second
\\end{itemize}`);
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<li>First</li>'));
  assert.ok(html.includes('<li>Second</li>'));
  assert.ok(html.includes('</ul>'));
});

test('latexBodyToHtml : enumerate → ol', () => {
  const html = latexBodyToHtml(`\\begin{enumerate}
\\item Alpha
\\item Beta
\\end{enumerate}`);
  assert.ok(html.includes('<ol>'));
  assert.ok(html.includes('<li>Alpha</li>'));
});

test('latexBodyToHtml : display math \\[ ... \\]', () => {
  const html = latexBodyToHtml('\\[\nx^2 + y^2 = z^2\n\\]');
  assert.ok(html.includes('class="math math-display"'));
});

test('roundtrip : serialize ∘ parse preserves a typical article', () => {
  const src = `\\documentclass{article}
\\begin{document}
\\section{Intro}

This paragraph has \\textbf{bold} + \\textit{italic} and math $a+b$.

\\section{Lists}

\\begin{itemize}
  \\item Apple
  \\item Banana
\\end{itemize}

\\end{document}
`;
  const parsed = parseLatex(src);
  const round = serializeLatex(parsed, parsed.bodyHtml);
  // Preamble + closing must survive verbatim.
  assert.ok(round.includes('\\documentclass{article}'));
  assert.ok(round.includes('\\begin{document}'));
  assert.ok(round.includes('\\end{document}'));
  // Body contents must survive in some form.
  assert.ok(round.includes('\\section{Intro}'));
  assert.ok(round.includes('\\textbf{bold}'));
  assert.ok(round.includes('\\textit{italic}'));
  assert.ok(round.includes('\\begin{itemize}'));
  assert.ok(round.includes('\\item Apple'));
});

test('inlineLatexToHtml : \\cite{key} → latex-cite span', () => {
  const html = inlineLatexToHtml('See \\cite{einstein1905}.');
  assert.ok(html.includes('class="latex-cite"'));
  assert.ok(html.includes('data-key="einstein1905"'));
  assert.ok(html.includes('[einstein1905]'));
});

test('inlineLatexToHtml : \\ref{x} \\label{x}', () => {
  assert.ok(inlineLatexToHtml('\\ref{sec:intro}').includes('class="latex-ref"'));
  assert.ok(inlineLatexToHtml('\\label{eq:1}').includes('class="latex-label"'));
});

test('inlineLatexToHtml : \\href{url}{label} multi-arg', () => {
  const html = inlineLatexToHtml('\\href{https://x.org}{X.org}');
  assert.ok(html.includes('href="https://x.org"'));
  assert.ok(html.includes('>X.org</a>'));
});

test('inlineLatexToHtml : \\includegraphics with opts', () => {
  const html = inlineLatexToHtml('\\includegraphics[width=5cm]{fig.png}');
  assert.ok(html.includes('<img'));
  assert.ok(html.includes('data-path="fig.png"'));
  assert.ok(html.includes('data-opts="width=5cm"'));
});

test('roundtrip : cite/ref/label survive', () => {
  const src = `\\begin{document}
See \\cite{key1} on \\ref{sec:intro} \\label{eq:foo}.
\\end{document}`;
  const parsed = parseLatex(src);
  const round = serializeLatex(parsed, parsed.bodyHtml);
  assert.ok(round.includes('\\cite{key1}'));
  assert.ok(round.includes('\\ref{sec:intro}'));
  assert.ok(round.includes('\\label{eq:foo}'));
});

test('roundtrip : includegraphics with opts survives', () => {
  const src = `\\begin{document}
\\includegraphics[width=10cm]{fig.png}
\\end{document}`;
  const parsed = parseLatex(src);
  const round = serializeLatex(parsed, parsed.bodyHtml);
  assert.ok(round.includes('\\includegraphics[width=10cm]{fig.png}'),
    `roundtrip missing includegraphics : ${round}`);
});

test('latexBodyToHtml : tabular → table', () => {
  const html = latexBodyToHtml(`\\begin{tabular}{|l|c|r|}
\\hline
a & b & c \\\\
d & e & f \\\\
\\hline
\\end{tabular}`);
  assert.ok(html.includes('<table'));
  assert.ok(html.includes('class="latex-tabular"'));
  assert.ok(html.includes('data-spec="|l|c|r|"'));
  assert.ok(html.includes('<td>a</td>'));
  assert.ok(html.includes('<td>f</td>'));
});

test('latexBodyToHtml : equation env → math-env', () => {
  const html = latexBodyToHtml(`\\begin{equation}
E = mc^2
\\end{equation}`);
  assert.ok(html.includes('class="math math-env"'));
  assert.ok(html.includes('data-env="equation"'));
  assert.ok(html.includes('data-tex="E = mc^2"'));
});

test('latexBodyToHtml : align env preserves env name', () => {
  const html = latexBodyToHtml(`\\begin{align}
x &= 1 \\\\
y &= 2
\\end{align}`);
  assert.ok(html.includes('data-env="align"'));
});

test('roundtrip : tabular preserves column spec + cells', () => {
  const src = `\\begin{document}
\\begin{tabular}{|l|c|r|}
\\hline
Name & Age & Score \\\\
Alice & 30 & 95 \\\\
\\hline
\\end{tabular}
\\end{document}`;
  const parsed = parseLatex(src);
  const round = serializeLatex(parsed, parsed.bodyHtml);
  assert.ok(round.includes('\\begin{tabular}{|l|c|r|}'), `missing tabular open : ${round}`);
  assert.ok(round.includes('Name & Age & Score'), `missing first row : ${round}`);
  assert.ok(round.includes('Alice & 30 & 95'), `missing second row : ${round}`);
  assert.ok(round.includes('\\end{tabular}'));
});

test('roundtrip : equation env survives', () => {
  const src = `\\begin{document}
\\begin{equation}
E = mc^2
\\end{equation}
\\end{document}`;
  const parsed = parseLatex(src);
  const round = serializeLatex(parsed, parsed.bodyHtml);
  assert.ok(round.includes('\\begin{equation}'));
  assert.ok(round.includes('E = mc^2'));
  assert.ok(round.includes('\\end{equation}'));
});

test('splitTabularCells : escaped & stays grouped', () => {
  // `a \& b & c` : the `\&` should NOT split the cell — both
  // `a \& b` and `c` should land as the only two cells.
  const html = latexBodyToHtml(`\\begin{tabular}{ll}
a \\& b & c \\\\
\\end{tabular}`);
  // Count <td> elements in the first <tr>.
  const trMatch = html.match(/<tr>(.*?)<\/tr>/s);
  const tdCount = (trMatch?.[1].match(/<td>/g) || []).length;
  assert.equal(tdCount, 2, `expected 2 cells (escaped & ignored), got ${tdCount} : ${html}`);
});

test('roundtrip : unknown commands survive untouched via latex-raw', () => {
  const src = `\\begin{document}
A \\cite{ref} citation and a \\label{foo} label.
\\end{document}`;
  const parsed = parseLatex(src);
  const round = serializeLatex(parsed, parsed.bodyHtml);
  assert.ok(round.includes('\\cite{ref}'), 'cite must survive');
  assert.ok(round.includes('\\label{foo}'), 'label must survive');
});
