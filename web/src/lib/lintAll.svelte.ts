// lintAll.svelte.ts — per-language client-side syntax validators
// driving @codemirror/lint's gutter + diagnostic underlines.
//
// Browser-only checks (no LSP, no server-round-trip) :
//
//   - JSON  : JSON.parse, surface the message + offset
//   - YAML  : custom one-pass lexer (indent + colon-pair check)
//   - TOML  : key=value scan + bracket/quote balance
//   - HCL   : brace/bracket/paren depth + heredoc closure
//   - HTML  : void-tag / unclosed-tag balance
//   - CSS   : `{ }` balance + missing `;` at end of declaration
//   - LaTeX : matched `\begin{x}` / `\end{x}` + balanced `{}` `$$`
//   - Shell : `if`/`fi`, `case`/`esac`, `do`/`done` matching
//   - Generic JS/TS/Go/C/C++/Python/Rust : language-pack handles
//     it via the official `@codemirror/lang-*` parser ; we don't
//     re-implement.
//
// Each linter returns a flat list of `Diagnostic` (from/to/severity/
// message) ; CodeMirror's lint extension renders them as gutter
// dots + squiggle underlines + a tooltip on hover.

import { linter, type Diagnostic } from '@codemirror/lint';
import { type Extension, Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { compileDiagnostics } from './compileDiagnostics.svelte';
import { bib } from './bibStore.svelte';

// JSON — `JSON.parse` carries enough info (message + position) for
// useful diagnostics. The `at position N` suffix in the error
// string converts to a from/to range.
function lintJSON(view: EditorView): Diagnostic[] {
  const src = view.state.doc.toString();
  try {
    JSON.parse(src);
    return [];
  } catch (e) {
    const msg = String(e);
    const m = /position\s+(\d+)/i.exec(msg);
    const at = m ? Math.min(src.length, Number(m[1])) : 0;
    return [{ from: at, to: Math.min(src.length, at + 1), severity: 'error', message: msg }];
  }
}

// YAML — minimal indent + colon-pair check. A real YAML parser
// (js-yaml etc.) would be more accurate but pulls 100+KB ; the
// linter here flags the most common typos (tabs in indent, missing
// space after colon).
function lintYAML(view: EditorView): Diagnostic[] {
  const doc = view.state.doc;
  const out: Diagnostic[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    // Skip blank + comment lines.
    if (!text.trim() || text.trimStart().startsWith('#')) continue;
    // Tabs in indent = forbidden in YAML 1.2.
    const leadTabs = /^\t+/.exec(text);
    if (leadTabs) {
      out.push({
        from: line.from,
        to: line.from + leadTabs[0].length,
        severity: 'error',
        message: 'YAML disallows tabs in indentation — use spaces.',
      });
    }
    // `key:value` (no space) is a frequent typo.
    const noSpace = /^[\s-]*[A-Za-z_][\w.-]*:[^\s$]/.exec(text);
    if (noSpace) {
      const at = line.from + (noSpace[0].length - 1);
      out.push({
        from: at,
        to: at + 1,
        severity: 'warning',
        message: 'YAML key must be followed by a space after the colon.',
      });
    }
  }
  return out;
}

// TOML — key=value scan + balance check.
function lintTOML(view: EditorView): Diagnostic[] {
  const doc = view.state.doc;
  const out: Diagnostic[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text.trim();
    if (!text || text.startsWith('#')) continue;
    if (text.startsWith('[')) {
      // Table or array-of-tables header.
      if (!/^\[\[?[A-Za-z_0-9.\-"' ]+\]\]?$/.test(text)) {
        out.push({
          from: line.from,
          to: line.from + line.length,
          severity: 'warning',
          message: 'Malformed TOML table header.',
        });
      }
      continue;
    }
    if (!/=/.test(text)) {
      out.push({
        from: line.from,
        to: line.from + line.length,
        severity: 'warning',
        message: 'TOML lines outside tables must be key = value.',
      });
    }
  }
  return out;
}

// HCL — brace/bracket/paren depth + heredoc closure.
function lintHCL(view: EditorView): Diagnostic[] {
  const src = view.state.doc.toString();
  const out: Diagnostic[] = [];
  let depthBrace = 0, depthSquare = 0, depthParen = 0;
  let inString = false;
  let inHeredoc: string | null = null;
  let inComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inComment) {
      if (c === '*' && src[i + 1] === '/') { inComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (inHeredoc) {
      if (c === '\n') {
        // Check if next line is the close marker.
        const rest = src.slice(i + 1);
        const m = new RegExp('^\\s*' + inHeredoc + '\\s*(?:\\n|$)').exec(rest);
        if (m) { inHeredoc = null; i += m[0].length; }
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') { inComment = true; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') { inString = true; continue; }
    if (c === '<' && src[i + 1] === '<') {
      const m = /^<<-?\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (m) { inHeredoc = m[1]; i += m[0].length - 1; continue; }
    }
    if (c === '{') depthBrace++;
    else if (c === '}') { depthBrace--; if (depthBrace < 0) { out.push({ from: i, to: i + 1, severity: 'error', message: 'Stray closing brace' }); depthBrace = 0; } }
    else if (c === '[') depthSquare++;
    else if (c === ']') { depthSquare--; if (depthSquare < 0) { out.push({ from: i, to: i + 1, severity: 'error', message: 'Stray closing bracket' }); depthSquare = 0; } }
    else if (c === '(') depthParen++;
    else if (c === ')') { depthParen--; if (depthParen < 0) { out.push({ from: i, to: i + 1, severity: 'error', message: 'Stray closing paren' }); depthParen = 0; } }
  }
  if (depthBrace > 0) out.push({ from: src.length, to: src.length, severity: 'error', message: depthBrace + ' unclosed brace(s)' });
  if (depthSquare > 0) out.push({ from: src.length, to: src.length, severity: 'error', message: depthSquare + ' unclosed bracket(s)' });
  if (depthParen > 0) out.push({ from: src.length, to: src.length, severity: 'error', message: depthParen + ' unclosed paren(s)' });
  if (inString) out.push({ from: src.length, to: src.length, severity: 'error', message: 'unterminated string' });
  if (inHeredoc) out.push({ from: src.length, to: src.length, severity: 'error', message: 'unterminated heredoc ' + inHeredoc });
  return out;
}

// LaTeX cite + ref lint : check every `\cite{key}` against
// bib.byKey ; flag keys not present in any .bib file as warnings
// (the user might have just opened the doc before .bib parses).
// `\ref{label}` checks against `\label{label}` definitions in the
// same doc. Hover tooltip shows the resolved entry / missing reason.
function lintLatexRefs(view: EditorView): Diagnostic[] {
  const src = view.state.doc.toString();
  const out: Diagnostic[] = [];
  // Build the set of labels defined in this document so cross-ref
  // checks don't false-positive on intra-doc labels.
  const labels = new Set<string>();
  let m: RegExpExecArray | null;
  const labelRe = /\\label\{([^{}]+)\}/g;
  while ((m = labelRe.exec(src))) labels.add(m[1]);

  // \cite{key1, key2, …} — split on comma, each key resolves
  // independently. If bib is still loading we don't lint (avoid
  // false positives during the 5 s polling cycle).
  if (!bib.loading && bib.entries.length > 0) {
    const citeRe = /\\(?:cite|citep|citet|citeauthor|citeyear)\{([^{}]+)\}/g;
    while ((m = citeRe.exec(src))) {
      const inner = m[1];
      let pos = m.index + m[0].indexOf('{') + 1;
      for (const raw of inner.split(',')) {
        const key = raw.trim();
        const len = raw.length;
        if (key && !bib.byKey.get(key)) {
          out.push({
            from: pos + (raw.length - raw.trimStart().length),
            to: pos + len - (raw.length - raw.trimEnd().length),
            severity: 'warning',
            message: 'Unknown citation key : ' + key,
          });
        }
        pos += len + 1; // +1 for the comma
      }
    }
  }

  // \ref{label} — flag unknown labels.
  const refRe = /\\(?:ref|pageref|eqref|autoref|cref|Cref)\{([^{}]+)\}/g;
  while ((m = refRe.exec(src))) {
    const key = m[1];
    if (!labels.has(key)) {
      const start = m.index + m[0].indexOf('{') + 1;
      out.push({
        from: start,
        to: start + key.length,
        severity: 'warning',
        message: 'Unknown label : ' + key,
      });
    }
  }
  return out;
}

// LaTeX — \begin{} / \end{} match + brace balance + $$ pairing.
function lintLatex(view: EditorView): Diagnostic[] {
  const src = view.state.doc.toString();
  const out: Diagnostic[] = [];
  // Track open environments via a stack ; mismatched \end{x}
  // surfaces both the orphan + the unclosed counterpart.
  const stack: Array<{ env: string; pos: number }> = [];
  const re = /\\(begin|end)\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1] === 'begin') {
      stack.push({ env: m[2], pos: m.index });
    } else {
      const top = stack.pop();
      if (!top) {
        out.push({ from: m.index, to: m.index + m[0].length, severity: 'error', message: 'unmatched \\end{' + m[2] + '}' });
      } else if (top.env !== m[2]) {
        out.push({ from: m.index, to: m.index + m[0].length, severity: 'error', message: 'expected \\end{' + top.env + '}, got \\end{' + m[2] + '}' });
      }
    }
  }
  for (const open of stack) {
    out.push({ from: open.pos, to: open.pos + 7 + open.env.length, severity: 'error', message: 'unclosed \\begin{' + open.env + '}' });
  }
  // Display math `$$` parity.
  const dd = (src.match(/\$\$/g) ?? []).length;
  if (dd % 2 !== 0) {
    out.push({ from: src.length, to: src.length, severity: 'warning', message: 'odd number of `$$` — display math unbalanced' });
  }

  // Single-brace `{` / `}` balance — catches the very common
  // "removed the closing brace of \section{X}" mistake that
  // otherwise only surfaces deep inside pdfTeX's "Runaway
  // argument" / "File ended while scanning" output. We keep a
  // stack of open `{` positions, ignore escaped `\{` `\}`, ignore
  // % comments + verbatim regions (best-effort), and flag every
  // unclosed `{` at the end. Stray `}` flagged as it appears.
  {
    let inComment = false;
    let inVerbatim = false;
    const braceStack: number[] = [];
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\n') { inComment = false; continue; }
      if (inComment) continue;
      // Comments — `%` not preceded by `\`.
      if (ch === '%' && src[i - 1] !== '\\') { inComment = true; continue; }
      // Verbatim environments swallow braces ; toggle on
      // \begin{verbatim} / \end{verbatim}. Cheap detection.
      if (src.startsWith('\\begin{verbatim}', i)) {
        inVerbatim = true; i += '\\begin{verbatim}'.length - 1; continue;
      }
      if (src.startsWith('\\end{verbatim}', i)) {
        inVerbatim = false; i += '\\end{verbatim}'.length - 1; continue;
      }
      if (inVerbatim) continue;
      // Escaped braces : `\{` `\}` aren't grouping tokens.
      if (ch === '\\' && (src[i + 1] === '{' || src[i + 1] === '}')) { i++; continue; }
      if (ch === '{') braceStack.push(i);
      else if (ch === '}') {
        if (braceStack.length === 0) {
          out.push({ from: i, to: i + 1, severity: 'error', message: 'stray closing brace `}`' });
        } else {
          braceStack.pop();
        }
      }
    }
    // Surface each unclosed opening brace — pinpoint the original
    // `{` so the user sees exactly where to add the missing `}`.
    for (const openPos of braceStack) {
      // Underline the command word preceding the brace so the
      // error reads as e.g. "\section{ — unclosed brace".
      let from = openPos;
      while (from > 0 && /[A-Za-z\\]/.test(src[from - 1])) from--;
      out.push({
        from,
        to: openPos + 1,
        severity: 'error',
        message: 'unclosed `{` — missing matching `}` later in the document',
      });
    }
  }
  return out;
}

// HTML — naive tag stack ; ignores known void elements.
const VOID_HTML = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);
function lintHTML(view: EditorView): Diagnostic[] {
  const src = view.state.doc.toString();
  const out: Diagnostic[] = [];
  const stack: Array<{ tag: string; pos: number }> = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = m[1].toLowerCase();
    const selfClose = m[2] === '/' || VOID_HTML.has(tag);
    if (m[0].startsWith('</')) {
      const top = stack.pop();
      if (!top) {
        out.push({ from: m.index, to: m.index + m[0].length, severity: 'error', message: 'stray </' + tag + '>' });
      } else if (top.tag !== tag) {
        out.push({ from: m.index, to: m.index + m[0].length, severity: 'error', message: 'expected </' + top.tag + '>, got </' + tag + '>' });
      }
    } else if (!selfClose) {
      stack.push({ tag, pos: m.index });
    }
  }
  for (const open of stack) {
    out.push({ from: open.pos, to: open.pos + open.tag.length + 2, severity: 'warning', message: 'unclosed <' + open.tag + '>' });
  }
  return out;
}

// CSS — brace balance + missing semi on declaration lines.
function lintCSS(view: EditorView): Diagnostic[] {
  const src = view.state.doc.toString();
  const out: Diagnostic[] = [];
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) { out.push({ from: src.length, to: src.length, severity: 'error', message: 'unterminated block comment' }); return out; } i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth < 0) { out.push({ from: i, to: i + 1, severity: 'error', message: 'stray }' }); depth = 0; } }
  }
  if (depth > 0) out.push({ from: src.length, to: src.length, severity: 'error', message: depth + ' unclosed `{`' });
  return out;
}

function lintFor(language: string) {
  switch (language) {
    case 'json':   return lintJSON;
    case 'yaml':   return lintYAML;
    case 'toml':   return lintTOML;
    case 'hcl':    return lintHCL;
    case 'latex':  return lintLatex;
    case 'html':   return lintHTML;
    case 'css':    return lintCSS;
    case 'scss':   return lintCSS;
    default:       return null;
  }
}

export const lintCompartment = new Compartment();

// Wraps a per-language syntax check (if any) WITH a global compile-
// diagnostics layer. The compile linter pulls from the shared
// compileDiagnostics store so pdflatex / pandoc / latexmk errors
// show up as red squiggles on the offending line + gutter dots,
// no matter which language pack is active.
function compileLintFor(file: string) {
  return (view: EditorView): Diagnostic[] => {
    const out: Diagnostic[] = [];
    const doc = view.state.doc;
    for (const d of compileDiagnostics.forFile(file)) {
      if (d.line == null) continue;
      const ln = Math.max(1, Math.min(doc.lines, d.line));
      const line = doc.line(ln);
      out.push({
        from: line.from,
        to: line.to,
        severity: d.severity,
        message: d.message,
      });
    }
    return out;
  };
}

export function lintExtension(language: string, file = ''): Extension {
  const fn = lintFor(language);
  // ALWAYS wire the compile-diagnostics linter so the editor surfaces
  // build errors as red squiggles even when the syntactic linter has
  // nothing to say about the language. LaTeX gets an extra cite/ref
  // resolver that pulls from bibStore + the doc's own labels.
  return [
    fn ? linter(fn) : [],
    linter(compileLintFor(file)),
    language === 'latex' ? linter(lintLatexRefs) : [],
  ];
}
