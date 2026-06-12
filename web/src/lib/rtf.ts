// rtf.ts — tiny RTF reader. Strips control words + groups to yield
// the document's plain text + a coarse HTML rendering for the
// PreviewPane.
//
// Not a full spec implementation — RTF 1.9 has 350+ control words
// and the spec runs ~210 pages. We handle the subset that matters
// for documents produced by Word / TextEdit / LibreOffice :
//
//   - control words : \par \line \tab \b \i \ul \plain \fs<N>
//     \cf<N> \fonttbl (skipped) \colortbl (skipped) \pict (skipped)
//   - control symbols : \\ \{ \} \~ \- \_
//   - unicode escapes : \uNNNN
//   - groups : { ... } (nested)
//   - hex escapes : \'XX
//
// The renderer returns sanitised HTML (only b / i / u / br / p
// tags) — safe to inject without DOMPurify because we don't pass
// any user-controlled attribute through.

export interface RTFParsed {
  text: string;
  html: string;
  // Surfaced metadata when the doc carries `\title{...}` etc inside
  // an `\info` group (Word + TextEdit drop those).
  meta: { title?: string; author?: string };
}

export function parseRTF(src: string): RTFParsed {
  let i = 0;
  const N = src.length;
  // Stack of style frames so `{` saves, `}` restores.
  const stack: Array<{ bold: boolean; italic: boolean; underline: boolean; skip: boolean }> = [
    { bold: false, italic: false, underline: false, skip: false },
  ];
  let html = '';
  let plain = '';
  const meta: RTFParsed['meta'] = {};
  // Active "destination" — when a known control destination opens
  // (\fonttbl, \colortbl, \stylesheet, \pict, \info, …) we collect
  // text into a separate buffer that gets routed to meta or
  // discarded.
  let destination: 'doc' | 'fonttbl' | 'colortbl' | 'stylesheet' | 'pict' | 'info' | 'title' | 'author' = 'doc';
  let infoBuf = '';

  function appendChar(c: string) {
    if (destination !== 'doc') {
      if (destination === 'title' || destination === 'author') infoBuf += c;
      return;
    }
    const top = stack[stack.length - 1];
    if (top.skip) return;
    plain += c;
    // Encode for HTML.
    const escaped = c
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    let chunk = escaped;
    if (top.underline) chunk = '<u>' + chunk + '</u>';
    if (top.italic) chunk = '<i>' + chunk + '</i>';
    if (top.bold) chunk = '<b>' + chunk + '</b>';
    html += chunk;
  }
  function newline() {
    if (destination !== 'doc') return;
    plain += '\n';
    html += '<br/>';
  }
  function paragraph() {
    if (destination !== 'doc') return;
    plain += '\n\n';
    // Close any partial inline + open fresh paragraph.
    html += '</p><p>';
  }

  // Open the document wrapper paragraph.
  html += '<p>';

  while (i < N) {
    const ch = src[i];
    if (ch === '\\') {
      // Control word, control symbol or unicode escape.
      i++;
      if (i >= N) break;
      const next = src[i];
      // \' XX hex escape.
      if (next === "'") {
        const hex = src.slice(i + 1, i + 3);
        i += 3;
        const code = parseInt(hex, 16);
        if (!isNaN(code)) appendChar(String.fromCharCode(code));
        continue;
      }
      // Control symbols.
      if (next === '\\' || next === '{' || next === '}') {
        appendChar(next);
        i++;
        continue;
      }
      if (next === '~') { appendChar(' '); i++; continue; }
      if (next === '-' || next === '_') { i++; continue; }
      if (next === '*') { i++; continue; } // \* marks ignorable destination
      // Control word : alpha+ followed by optional numeric param.
      const cwMatch = /^([A-Za-z]+)(-?\d+)?\s?/.exec(src.slice(i));
      if (!cwMatch) { i++; continue; }
      const cw = cwMatch[1];
      const param = cwMatch[2] ? parseInt(cwMatch[2], 10) : null;
      i += cwMatch[0].length;
      const top = stack[stack.length - 1];
      switch (cw) {
        case 'par':       paragraph(); break;
        case 'line':      newline(); break;
        case 'tab':       appendChar('\t'); break;
        case 'b':         top.bold = param !== 0; break;
        case 'i':         top.italic = param !== 0; break;
        case 'ul':        top.underline = param !== 0; break;
        case 'ulnone':    top.underline = false; break;
        case 'plain':     top.bold = top.italic = top.underline = false; break;
        case 'u': {
          // \uN ? — N is a UTF-16 code point ; the `?` is a fallback
          // char emitted for older readers (we skip it).
          if (param != null) {
            appendChar(String.fromCharCode(param < 0 ? 0x10000 + param : param));
            // Skip the fallback char that follows.
            if (src[i] === '?') i++;
            else if (src[i]) i++;
          }
          break;
        }
        case 'fonttbl':   destination = 'fonttbl'; top.skip = true; break;
        case 'colortbl':  destination = 'colortbl'; top.skip = true; break;
        case 'stylesheet':destination = 'stylesheet'; top.skip = true; break;
        case 'pict':      destination = 'pict'; top.skip = true; break;
        case 'info':      destination = 'info'; top.skip = true; break;
        case 'title':     destination = 'title'; infoBuf = ''; top.skip = true; break;
        case 'author':    destination = 'author'; infoBuf = ''; top.skip = true; break;
        default:          break; // unknown control words silently skipped
      }
      continue;
    }
    if (ch === '{') {
      const prev = stack[stack.length - 1];
      stack.push({ ...prev });
      i++;
      continue;
    }
    if (ch === '}') {
      // Close current destination if it was opened by this group.
      if (destination === 'title') meta.title = infoBuf.trim();
      else if (destination === 'author') meta.author = infoBuf.trim();
      if (destination !== 'doc') destination = 'doc';
      stack.pop();
      if (stack.length === 0) stack.push({ bold: false, italic: false, underline: false, skip: false });
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') { i++; continue; }
    appendChar(ch);
    i++;
  }
  html += '</p>';
  // Collapse empty paragraphs.
  html = html.replace(/<p>\s*<\/p>/g, '');
  return { text: plain, html, meta };
}

// ---------------------------------------------------------------
// HTML → RTF writer. Inverse of parseRTF for the WYSIWYG editor's
// save path. Walks the DOM emitted by the contenteditable surface
// and serialises it back to a minimal but spec-compliant RTF 1.9
// document that Word / TextEdit / LibreOffice open without warnings.
//
// Supported HTML subset (same one parseRTF reads back) :
//
//   <p> / <div>         → \par-separated paragraph
//   <br>                → \line
//   <b> / <strong>      → \b … \b0
//   <i> / <em>          → \i … \i0
//   <u>                 → \ul … \ul0
//   <h1>…<h3>           → \b \fs<n> … \b0 \par
//   <ul><li>            → • bullet line
//   <ol><li>            → 1. enumerated line (best-effort)
//
// Unknown tags are recursed into (we just emit their children) ;
// unknown attributes are dropped. The output starts with the
// canonical `{\rtf1\ansi\deff0\uc1{\fonttbl{\f0\fnil Helvetica;}}…`
// header so Word's compatibility layer doesn't downgrade to plain
// text on open.

const RTF_HEADER =
  '{\\rtf1\\ansi\\deff0\\uc1{\\fonttbl{\\f0\\fnil Helvetica;}}' +
  '{\\colortbl;\\red0\\green0\\blue0;}' +
  '\\f0\\fs24 ';

// escapeRTFText : RTF requires `{` `}` `\` escaped. Non-ASCII goes
// through \uNNNN? where ? is the ASCII fallback (we use '?' so
// Word can substitute the glyph but a non-RTF reader degrades
// gracefully).
function escapeRTFText(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') { out += '\\\\'; continue; }
    if (ch === '{')  { out += '\\{';  continue; }
    if (ch === '}')  { out += '\\}';  continue; }
    if (code < 128) {
      out += ch;
    } else {
      // \uNNNN ? — JS strings are UTF-16, so codePointAt yields the
      // full codepoint ; values > 32767 wrap to a signed-16 negative.
      const u = code > 32767 ? code - 65536 : code;
      out += '\\u' + u + '?';
    }
  }
  return out;
}

// Leaf-walk approach. The per-element recursion above produced
// fragmented `\b … \b0` runs when the contenteditable split a
// bold word into one `<b>` per character (which happens after some
// edits). We work around it by collecting an ordered list of
// "leaves" — each leaf is a (text, format, block) tuple keyed by
// the cumulative format state from the leaf's ancestors. Then we
// emit RTF tokens by comparing consecutive format states, so a run
// of single-char bold leaves serialises as one `\b w o r l d \b0`
// block instead of `\b w\b0 \b o\b0 …`.

interface LeafFormat { bold: boolean; italic: boolean; underline: boolean; }
interface BlockBoundary { kind: 'par' | 'line' | 'bullet' | 'enum'; ordinal?: number; }
interface Leaf { kind: 'text'; text: string; fmt: LeafFormat; }
interface BoundaryLeaf { kind: 'boundary'; boundary: BlockBoundary; }
type Item = Leaf | BoundaryLeaf;

// Inline tags that mutate the format frame as we descend.
const INLINE_FORMAT: Record<string, Partial<LeafFormat>> = {
  b: { bold: true }, strong: { bold: true },
  i: { italic: true }, em: { italic: true },
  u: { underline: true },
};
// Heading tags map to bold + a font size. We approximate by setting
// bold and emitting a wrapping `\fs<n>` token at the block level.
const HEADING_BOLD = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function collectLeaves(node: Node, fmt: LeafFormat, out: Item[]): void {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const t = node.textContent ?? '';
    if (t) out.push({ kind: 'text', text: t, fmt: { ...fmt } });
    return;
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  // Inline format change : descend with augmented frame, no
  // boundary emit.
  if (INLINE_FORMAT[tag]) {
    const next = { ...fmt, ...INLINE_FORMAT[tag] };
    el.childNodes.forEach((c) => collectLeaves(c, next, out));
    return;
  }
  // Inline-but-no-format wrappers : span etc.
  if (tag === 'span' || tag === 'font') {
    el.childNodes.forEach((c) => collectLeaves(c, fmt, out));
    return;
  }
  // Headings : descend with bold ON, mark the block boundary as a
  // heading so the emitter wraps with the right `\fs` size.
  if (HEADING_BOLD.has(tag)) {
    const next = { ...fmt, bold: true };
    el.childNodes.forEach((c) => collectLeaves(c, next, out));
    const size = tag === 'h1' ? 48 : tag === 'h2' ? 36 : tag === 'h3' ? 28 : 26;
    // Encode heading-paragraph as a synthetic boundary so the
    // serialiser can wrap with \fs<n>… \fs24 \par.
    out.push({ kind: 'boundary', boundary: { kind: 'par', ordinal: size } });
    return;
  }
  // Block-level paragraph wrappers.
  if (tag === 'p' || tag === 'div') {
    el.childNodes.forEach((c) => collectLeaves(c, fmt, out));
    out.push({ kind: 'boundary', boundary: { kind: 'par' } });
    return;
  }
  // Line break.
  if (tag === 'br') {
    out.push({ kind: 'boundary', boundary: { kind: 'line' } });
    return;
  }
  // List items.
  if (tag === 'li') {
    const parent = el.parentElement;
    const ordered = parent && parent.tagName.toLowerCase() === 'ol';
    if (ordered) {
      const idx = Array.from(parent!.children).indexOf(el) + 1;
      out.push({ kind: 'text', text: idx + '. ', fmt: { ...fmt } });
    } else {
      // Use the actual bullet character — RTF readers don't all
      // know `\bullet`, but they all know U+2022 (handled by the
      // unicode escape in escapeRTFText).
      out.push({ kind: 'text', text: '• ', fmt: { ...fmt } });
    }
    el.childNodes.forEach((c) => collectLeaves(c, fmt, out));
    out.push({ kind: 'boundary', boundary: { kind: 'par' } });
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    el.childNodes.forEach((c) => collectLeaves(c, fmt, out));
    return;
  }
  // Unknown tag : descend transparently.
  el.childNodes.forEach((c) => collectLeaves(c, fmt, out));
}

function emitLeaves(items: Item[]): string {
  let out = '';
  let cur: LeafFormat = { bold: false, italic: false, underline: false };
  // Track whether the current paragraph carries a `\fs<n>` heading
  // size so we know what to reset on \par. 24 (= 12pt) is the
  // document default.
  let curSize = 24;
  // Buffered heading size for the run of text since the last
  // boundary. We emit the size token before the first text-piece of
  // a heading paragraph, then reset on \par.
  let pendingSize = 24;
  // Accumulated since the last boundary — flushed when we hit a
  // boundary so we know which size to apply.
  const pending: string[] = [];
  const flushPending = () => {
    if (pending.length === 0) return;
    // Emit size if it changed for this paragraph.
    if (pendingSize !== curSize) {
      out += '\\fs' + pendingSize + ' ';
      curSize = pendingSize;
    }
    out += pending.join('');
    pending.length = 0;
  };
  const setFormat = (next: LeafFormat) => {
    // Emit transitions only where the bit actually changed.
    if (next.bold !== cur.bold) pending.push(next.bold ? '\\b ' : '\\b0 ');
    if (next.italic !== cur.italic) pending.push(next.italic ? '\\i ' : '\\i0 ');
    if (next.underline !== cur.underline) pending.push(next.underline ? '\\ul ' : '\\ul0 ');
    cur = { ...next };
  };
  for (const it of items) {
    if (it.kind === 'text') {
      setFormat(it.fmt);
      pending.push(escapeRTFText(it.text));
      continue;
    }
    // Boundary : flush + emit the boundary token + reset format
    // bits that don't carry across paragraphs.
    if (it.boundary.kind === 'par') {
      if (it.boundary.ordinal && it.boundary.ordinal !== 24) {
        pendingSize = it.boundary.ordinal;
      }
      flushPending();
      // Reset bold/italic/underline at paragraph end so the next
      // paragraph starts plain unless the leaf says otherwise.
      if (cur.bold)       { out += '\\b0 ';  cur.bold = false; }
      if (cur.italic)     { out += '\\i0 ';  cur.italic = false; }
      if (cur.underline)  { out += '\\ul0 '; cur.underline = false; }
      if (curSize !== 24) { out += '\\fs24 '; curSize = 24; }
      pendingSize = 24;
      out += '\\par ';
    } else if (it.boundary.kind === 'line') {
      flushPending();
      out += '\\line ';
    }
  }
  // Flush any tail content.
  flushPending();
  if (cur.bold)      out += '\\b0 ';
  if (cur.italic)    out += '\\i0 ';
  if (cur.underline) out += '\\ul0 ';
  return out;
}

// writeRTF : top-level entry. Accepts a snippet of HTML (or a full
// fragment) and returns a complete RTF document.
export function writeRTF(html: string): string {
  // Parse via DOMParser ; falls back to a div.innerHTML when DOMParser
  // is unavailable (SSR / Node test). Either path gives us a stable
  // tree we can walk.
  let root: Element;
  try {
    const doc = new DOMParser().parseFromString(
      '<!doctype html><html><body>' + html + '</body></html>',
      'text/html',
    );
    root = doc.body;
  } catch {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    root = tmp;
  }
  const items: Item[] = [];
  root.childNodes.forEach((n) => collectLeaves(n, { bold: false, italic: false, underline: false }, items));
  let body = emitLeaves(items);
  // Trim trailing \par so the document doesn't have a phantom blank
  // line at the end.
  body = body.replace(/(\\par\s*)+$/, '\\par ');
  return RTF_HEADER + body + '}';
}
