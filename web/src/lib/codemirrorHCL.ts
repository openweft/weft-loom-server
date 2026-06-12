// codemirrorHCL.ts — HashiCorp Configuration Language tokenizer for
// CodeMirror 6's StreamLanguage. Drop-in replacement for the ruby
// fallback we used before official @codemirror/legacy-modes ships
// an HCL mode. Designed to be contributed back upstream once
// stabilised : the file has no weft-loom-specific dependencies.
//
// What it tokenises :
//
//   - Block headers   : `resource "type" "name" {`
//   - Attributes      : `key = "value"`
//   - Strings         : `"…"` with `${expr}` interpolation highlighted
//   - Heredocs        : `<<EOT`, `<<-EOT`, terminated by `EOT`
//   - Numbers         : 12, 1.5, 1e9, 0xdeadbeef
//   - Booleans        : `true`, `false`, `null`
//   - Comments        : `#…\n`, `//…\n`, `/* … */`
//   - Identifiers     : function/variable names, type refs
//   - Operators       : = == != >= <= > < + - * / % && || ! ? :
//   - Punctuation     : `{ } [ ] ( ) , .`
//
// Mapped to @codemirror/highlight tags so any CodeMirror theme
// (built-in or VSCode-imported) styles HCL correctly.

import type { StreamParser, StringStream } from '@codemirror/language';

interface State {
  // Stack of open contexts : 'block' (inside `{}`), 'list' (inside
  // `[]`), 'paren' (inside `()`). Used for indentation.
  ctxStack: Array<'block' | 'list' | 'paren'>;
  // When inside a heredoc, the closing marker we're scanning for ;
  // null when we're at top-level scope.
  heredocEnd: string | null;
  // Whether we just emitted a heredoc opener — the rest of THAT
  // line stays at the keyword tag (legacy quirk) and heredoc body
  // starts on the next line.
  pendingHeredoc: boolean;
  // Multi-line `/* … */` flag.
  inBlockComment: boolean;
}

const KEYWORDS = new Set([
  'true', 'false', 'null',
  // HCL2 template / for-expression keywords. Used inside `[for x in
  // list : x.id]` comprehensions, `${ if cond }…${ endif }` template
  // conditionals, and `${ for x in list }…${ endfor }` template
  // loops. Recognising these gives the comprehension reader the
  // same visual cue as Python / Go for-comprehensions.
  'for', 'in', 'if', 'else', 'endif', 'endfor',
]);

const BLOCK_NAMES = new Set([
  // Terraform top-level blocks — recognised so the editor colours
  // them like a typeName even though HCL itself doesn't reserve them.
  'resource', 'data', 'variable', 'output', 'module', 'provider',
  'terraform', 'locals', 'check', 'import', 'removed', 'moved',
  'ephemeral',
  // HCL2 dynamic blocks (`dynamic "ingress" { for_each = ... ;
  // content {} }`) — `dynamic` and `content` get the typeName look
  // when they head a block.
  'dynamic', 'content',
  // Nomad / Vault / Packer common ones too — keeps the palette
  // visually consistent across HashiCorp formats.
  'job', 'group', 'task', 'driver', 'config', 'service', 'template',
  'source', 'build', 'post-processor', 'provisioner',
  // weft / openweft HCL configs (cluster.hcl, .weft-loom config) —
  // adding our own block names keeps native HCL files in the openweft
  // ecosystem visually aligned with terraform.
  'cluster', 'host', 'datacenter', 'rack', 'project', 'vm',
  'microvm', 'drivers', 'mesh',
]);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentRest(c: string): boolean {
  return /[A-Za-z0-9_-]/.test(c);
}

export const hcl: StreamParser<State> = {
  startState(): State {
    return {
      ctxStack: [],
      heredocEnd: null,
      pendingHeredoc: false,
      inBlockComment: false,
    };
  },

  token(stream: StringStream, state: State): string | null {
    // Multi-line block comments take priority over everything else
    // — they swallow whitespace + braces verbatim until `*/`.
    if (state.inBlockComment) {
      while (!stream.eol()) {
        if (stream.match('*/')) {
          state.inBlockComment = false;
          return 'comment';
        }
        stream.next();
      }
      return 'comment';
    }

    // Heredoc body lines : everything between `<<EOT` line + the
    // sentinel-marker line goes to `string`.
    if (state.heredocEnd) {
      const end = state.heredocEnd;
      // The closing marker MUST be at the start of a line (modulo
      // optional whitespace for `<<-` indented variant). We accept
      // either form so the lexer doesn't refuse `<<-EOT` ... `  EOT`.
      if (stream.match(new RegExp('^\\s*' + end + '\\s*$'))) {
        state.heredocEnd = null;
        return 'keyword';
      }
      stream.skipToEnd();
      return 'string';
    }

    if (stream.eatSpace()) return null;

    // Comments — `#` line, `//` line, `/* … */` block.
    if (stream.match(/^#[^\n]*/)) return 'comment';
    if (stream.match(/^\/\/[^\n]*/)) return 'comment';
    if (stream.match('/*')) {
      state.inBlockComment = true;
      return 'comment';
    }

    const ch = stream.peek();
    if (ch === undefined) return null;

    // Heredoc opener : `<<EOT` or `<<-EOT`. The closing-marker name
    // is captured + stored ; subsequent lines become `string` until
    // the marker reappears.
    if (stream.match(/^<<-?\s*([A-Za-z_][A-Za-z0-9_]*)/, false)) {
      // The match-with-no-consume above lets us inspect ; now
      // really consume + capture the marker.
      stream.next(); stream.next(); // skip `<<`
      if (stream.peek() === '-') stream.next();
      stream.eatSpace();
      let marker = '';
      while (!stream.eol() && /[A-Za-z0-9_]/.test(stream.peek() ?? '')) {
        marker += stream.next();
      }
      state.heredocEnd = marker;
      return 'keyword';
    }

    // Strings with `${…}` interpolation. We bail on the first
    // unescaped `"` to keep state minimal ; interpolation expressions
    // get a separate `meta` tag so themes can highlight them.
    if (ch === '"') {
      stream.next();
      let escaped = false;
      while (!stream.eol()) {
        const c = stream.next();
        if (c === undefined) break;
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === '"') return 'string';
        if (c === '$' && stream.peek() === '{') {
          // Switch to interpolation : eat the `${` and consume
          // until balancing `}`. We use a tiny brace counter so
          // nested objects inside the interpolation don't escape.
          stream.next();
          let depth = 1;
          while (!stream.eol() && depth > 0) {
            const n = stream.next();
            if (n === '{') depth++;
            else if (n === '}') depth--;
          }
          // After interpolation we keep going inside the string.
        }
      }
      // Unterminated string : end-of-line.
      return 'string';
    }

    // Numbers — integer, float, hex, exponent.
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(stream.string[stream.pos + 1] ?? ''))) {
      stream.match(/^(?:0x[0-9a-fA-F]+|[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?)/);
      return 'number';
    }

    // Identifier-ish : keyword vs block-name vs plain identifier.
    if (isIdentStart(ch)) {
      let word = '';
      while (!stream.eol() && isIdentRest(stream.peek() ?? '')) {
        word += stream.next();
      }
      if (KEYWORDS.has(word)) return 'atom';
      if (BLOCK_NAMES.has(word)) return 'typeName';
      return 'variableName';
    }

    // Operators + punctuation.
    if (ch === '{') { stream.next(); state.ctxStack.push('block'); return 'brace'; }
    if (ch === '}') { stream.next(); state.ctxStack.pop(); return 'brace'; }
    if (ch === '[') { stream.next(); state.ctxStack.push('list'); return 'bracket'; }
    if (ch === ']') { stream.next(); state.ctxStack.pop(); return 'bracket'; }
    if (ch === '(') { stream.next(); state.ctxStack.push('paren'); return 'paren'; }
    if (ch === ')') { stream.next(); state.ctxStack.pop(); return 'paren'; }
    if (',' === ch || '.' === ch) { stream.next(); return 'punctuation'; }
    if (stream.match(/^(?:==|!=|<=|>=|&&|\|\||[=+\-*/%<>!?:])/)) return 'operator';

    // Fallback — consume one char so we don't loop.
    stream.next();
    return null;
  },

  indent(state: State, _textAfter: string, _cx): number {
    // CodeMirror 6 uses cx.unit ; we approximate with 2 spaces.
    return state.ctxStack.length * 2;
  },

  languageData: {
    commentTokens: { line: '#', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
    indentOnInput: /^\s*[\}\]\)]$/,
  },
};
