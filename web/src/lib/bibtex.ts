// bibtex.ts — minimal BibTeX parser used to resolve `\cite{key}` in
// the LaTeX editor. Goals :
//
//   - Surface a Map<key, Entry> consumed by both the autocomplete
//     extension (for `\cite{` completions) AND the rich-text
//     decoration pipeline (hover tooltip with author / title).
//   - Keep the parse forgiving : community .bib files routinely
//     omit closing braces, use `=` without spaces, and mix `"…"`
//     with `{…}` for field values. We don't error out on the small
//     deviations.
//
// Implementation is hand-rolled rather than `bibtex-js` etc. : the
// real-world variety of .bib formats is narrow enough that a 100-
// line regex pass covers > 99 % of cases without the dep cost.

export interface BibEntry {
  key: string;             // citation key, e.g. "knuth1986texbook"
  type: string;            // article / book / inproceedings / …
  fields: Record<string, string>;
  // Pre-computed display fields :
  author?: string;
  title?: string;
  year?: string;
  source?: string;         // journal / booktitle / publisher
}

// Each entry starts with `@type{key,` then a chain of
// `field = value,` pairs, finally a closing `}`. Brace + quote
// values are unwrapped ; comments `% …` stay raw.
export function parseBib(src: string): BibEntry[] {
  const out: BibEntry[] = [];
  // Strip TeX-style comments + collapse \r\n.
  const text = src.replace(/(?<!\\)%[^\n]*/g, '').replace(/\r\n?/g, '\n');
  // Match each entry up to the balanced closing brace. We use a
  // simple stack scan because regex can't balance ; the regex
  // anchors `@type{` then we consume manually.
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    const m = /@(\w+)\s*\{\s*([^,\s]+)\s*,/.exec(text.slice(at));
    if (!m) { i = at + 1; continue; }
    const type = m[1].toLowerCase();
    // Skip BibTeX directives (@string, @preamble, @comment).
    if (type === 'string' || type === 'preamble' || type === 'comment') {
      i = at + m[0].length;
      continue;
    }
    const key = m[2];
    let pos = at + m[0].length;
    let depth = 1; // inside the entry's outer `{`
    const start = pos;
    while (pos < text.length && depth > 0) {
      const c = text[pos];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (depth > 0) pos++;
    }
    const body = text.slice(start, pos);
    const fields = parseFields(body);
    const entry: BibEntry = {
      key, type, fields,
      author: fields.author,
      title: fields.title,
      year: fields.year,
      source: fields.journal || fields.booktitle || fields.publisher || fields.school,
    };
    out.push(entry);
    i = pos + 1;
  }
  return out;
}

// Parse the `field = value, …` body. Values can be quoted, braced,
// or bare (digits / strings). Whitespace around `=` + `,` is
// tolerated. Field names lower-cased so `Author` and `author`
// collapse to the same slot.
function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    // Skip whitespace + commas.
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    // Read field name.
    const start = i;
    while (i < body.length && /[\w-]/.test(body[i])) i++;
    const name = body.slice(start, i).toLowerCase();
    if (!name) { i++; continue; }
    // Eat `=` + whitespace.
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '=') continue;
    i++;
    while (i < body.length && /\s/.test(body[i])) i++;
    // Read value : `{…}`, `"…"`, or bareword.
    let value = '';
    if (body[i] === '{') {
      let depth = 1; i++;
      const s = i;
      while (i < body.length && depth > 0) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}') depth--;
        if (depth > 0) i++;
      }
      value = body.slice(s, i);
      i++;
    } else if (body[i] === '"') {
      i++;
      const s = i;
      while (i < body.length && body[i] !== '"') i++;
      value = body.slice(s, i);
      if (body[i] === '"') i++;
    } else {
      const s = i;
      while (i < body.length && /[^\s,}]/.test(body[i])) i++;
      value = body.slice(s, i);
    }
    out[name] = value.trim();
  }
  return out;
}

// formatEntry — single-line author / title / year display, suitable
// for autocomplete tooltips + lint hover messages.
export function formatEntry(e: BibEntry): string {
  const parts: string[] = [];
  if (e.author) parts.push(e.author);
  if (e.year) parts.push('(' + e.year + ')');
  if (e.title) parts.push('· ' + e.title);
  if (e.source) parts.push('— ' + e.source);
  return parts.join(' ');
}
