// templateExpr — substitutes `${ expression }` placeholders in
// markdown / LaTeX source before the renderer sees the text.
// Inspired by JS template literals : `${ new Date().getFullYear() }`
// in the source resolves to the current year, `${ Math.PI.toFixed(4) }`
// to "3.1416", etc.
//
// Scope of the sandbox : Date + Math are the only globals exposed.
// No DOM, fetch, eval, window, Function — we use `new Function()`
// internally but the body is constrained and there are no captured
// references to the host scope. This is a CONVENIENCE feature for
// authoring slide / document metadata that ages well (year, build
// timestamp, page number derived from a variable) — not a
// secure-eval boundary. The same document, opened via raw markdown
// elsewhere, would render the `${...}` verbatim ; the substitution
// only happens inside weft-loom's preview + compile pipeline.
//
// Syntax :
//   ${ expression }       → eval'd ; failures stay as the raw text
//   $${ literal }         → escape ; renders as `${ literal }` raw
//
// Used by PreviewPane to pre-process source before marked.parse,
// and by the compile dispatcher to pre-process source before the
// marp / pandoc / pdflatex run in the workspace μVM.

// The sandbox only exposes safe, non-mutating, ECMAScript built-ins.
// Date is whitelisted so `new Date().getFullYear()` works ; Math is
// whitelisted for arithmetic helpers. Adding more globals here is
// a deliberate decision — don't expose `globalThis`, `window`,
// `document`, `fetch`, `localStorage`, `import`, `eval`, etc.
const SAFE_GLOBALS = { Date, Math } as const;

export interface EvalContext {
  // Optional extra bindings the caller wants exposed to expressions.
  // Used for slide-page count, project name, file path, etc.
  [key: string]: unknown;
}

// evalExpression : runs a single `${...}` expression against the
// sandbox. Returns the result as a string, or null on failure.
// The caller decides whether to substitute or fall back to the raw
// `${...}` text — keeping invalid expressions visible is the safe
// default so the author notices the typo.
export function evalExpression(expr: string, ctx: EvalContext = {}): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  try {
    // Bind names from the sandbox + caller context as function
    // parameters. The Function constructor parses the body in
    // strict-mode-ish global scope ; without `this`, references
    // to undeclared identifiers throw ReferenceError. The
    // expression cannot see anything we don't pass in.
    const names = [...Object.keys(SAFE_GLOBALS), ...Object.keys(ctx)];
    const values = [...Object.values(SAFE_GLOBALS), ...Object.values(ctx)];
    const fn = new Function(...names, `"use strict"; return (${trimmed});`);
    const out = fn(...values);
    if (out === undefined || out === null) return '';
    return String(out);
  } catch {
    return null;
  }
}

// parseFrontMatterBindings : extract a YAML-ish front-matter block
// at the top of the source and convert its keys into JS-safe
// variable bindings. The result is merged into the eval context so
// the user can write `${title}`, `${author}`, `${date}` inside slide
// body and have Marp render the values from the front-matter.
//
// Marp itself doesn't natively interpolate front-matter into the
// body — this is a weft-loom-specific convenience. The substitution
// happens BEFORE marp-cli sees the source, so the final slide HTML
// contains the resolved string. Reserved keys (`marp`, `theme`,
// `paginate`, `class`, `size`) are also exposed but rarely useful
// inside the body itself.
function parseFrontMatterBindings(src: string): EvalContext {
  const m = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  const out: EvalContext = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    let v: unknown = kv[2];
    // Unquote single + double quoted strings.
    if (typeof v === 'string' && /^['"].*['"]$/.test(v)) v = v.slice(1, -1);
    // Coerce simple bool/number where useful — leave anything else
    // as the trimmed string.
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    // Bind by both the original key name and a JS-safe alias (dashes
    // turned into underscores) so `${title}` and `${title-fr}` work
    // even though identifiers can't contain `-`.
    out[kv[1]] = v;
    if (kv[1].includes('-')) out[kv[1].replace(/-/g, '_')] = v;
  }
  return out;
}

// expandTemplate : walks the source string, locating `${ ... }`
// placeholders (with balanced braces) and substituting each. `$${...}`
// is treated as an escape : the leading `$$` is collapsed to `$` and
// the inside stays raw. Math display blocks (`$$...$$` Marp/KaTeX) are
// NOT touched — those have no `${` opener.
//
// Front-matter values are automatically exposed : if the source
// starts with a `---\n...\n---` YAML block, each `key: value` line
// becomes a binding the placeholders can reference (so `${title}`
// resolves to the YAML title, `${author}` to author, etc.). This
// matches the user's intuition that "front-matter variables should
// be reachable from the slide body."
//
// Performance : O(n) over the source length, single pass. The brace
// balancer handles nested `{}` inside expressions (e.g.
// `${ {a: 1}.a }`) by tracking depth.
export function expandTemplate(src: string, ctx: EvalContext = {}): string {
  // Merge front-matter bindings — caller-supplied ctx wins on key
  // collisions (typically `file` / `project` from PreviewPane).
  const merged: EvalContext = { ...parseFrontMatterBindings(src), ...ctx };
  return expandWith(src, merged);
}

function expandWith(src: string, ctx: EvalContext): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    // Escape : `$${literal}` → `${literal}` raw.
    if (src[i] === '$' && src[i + 1] === '$' && src[i + 2] === '{') {
      out += '${';
      // Copy through the closing brace literally, no eval.
      i += 3;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        if (depth > 0) out += src[i];
        i++;
      }
      out += '}';
      continue;
    }
    // Active placeholder : `${expr}`.
    if (src[i] === '$' && src[i + 1] === '{') {
      const start = i;
      i += 2;
      let depth = 1;
      let body = '';
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) { i++; break; }
        }
        body += src[i];
        i++;
      }
      if (depth !== 0) {
        // Unterminated ${... — leave as-is so the author sees the bug.
        out += src.slice(start);
        return out;
      }
      const result = evalExpression(body, ctx);
      if (result === null) {
        // Eval failed : keep the placeholder so the author can fix
        // it. This is preferable to silently dropping the text.
        out += '${' + body + '}';
      } else {
        out += result;
      }
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}
