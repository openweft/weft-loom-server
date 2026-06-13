// rtf.ts — tiny RTF reader. Strips control words + groups to yield
// the document's plain text + a coarse HTML rendering for the
// PreviewPane.
//
// Not a full spec implementation — RTF 1.9 has 350+ control words
// and the spec runs ~210 pages. We handle the subset that matters
// for documents produced by Word / TextEdit / LibreOffice :
//
//   - control words : \par \line \tab \b \i \ul \plain \fs<N>
//     \cf<N> \highlight<N> \f<N> \strike \super \sub \nosupersub
//     \ansicpg<N> \fonttbl \colortbl \pict (skipped) \stylesheet
//   - control symbols : \\ \{ \} \~ \- \_
//   - unicode escapes : \uNNNN  (with \ucN fallback-skip)
//   - groups : { ... } (nested)
//   - hex escapes : \'XX  (decoded via \ansicpg when relevant)
//
// The renderer returns sanitised HTML (only b / i / u / br / p /
// span tags with a fixed attribute set) — safe to inject without
// DOMPurify because we don't pass any user-controlled attribute
// through.

export interface RTFParsed {
  text: string;
  html: string;
  // Surfaced metadata when the doc carries `\title{...}` etc inside
  // an `\info` group (Word + TextEdit drop those).
  meta: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    company?: string;
    manager?: string;
    creatim?: string;
    revtim?: string;
    version?: string;
  };
}

// CP1252 C1-range (0x80-0x9F) mapping. Outside this range CP1252
// matches Latin-1 so we fall through to String.fromCharCode.
const CP1252_C1: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
  0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ',
  0x8E: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”',
  0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ',
  0x9E: 'ž', 0x9F: 'Ÿ',
};

// T10 V0.3 : pre-pass that hoists every `{\field{\*\fldinst INSTR}
// {\fldrslt VISIBLE}}` construct out of the source + replaces each
// with a placeholder the main parser surfaces as an inline
// `<span class="rtf-field" ...>`. Done as a pre-pass because the
// field's `{` / `}` pairs nest inside the parser's brace stack and
// the char-by-char loop can't easily look ahead.
interface RTFField {
  kind: string;
  name: string;
  visible: string;
}
function extractRTFFields(src: string): { src: string; fields: RTFField[] } {
  const fields: RTFField[] = [];
  let out = '';
  let i = 0;
  const N = src.length;
  while (i < N) {
    // Look for `{\field` at the current position.
    if (src.startsWith('{\\field', i)) {
      let depth = 1;
      i += 7; // past `{\field`
      const innerStart = i;
      while (i < N && depth > 0) {
        if (src[i] === '\\' && (src[i + 1] === '{' || src[i + 1] === '}' || src[i + 1] === '\\')) {
          i += 2; continue;
        }
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
        if (depth === 0) break;
      }
      const inner = src.slice(innerStart, i - 1);
      const instr = pickRTFGroup(inner, 'fldinst');
      const visible = pickRTFGroup(inner, 'fldrslt');
      let kind = 'unknown';
      let name = '';
      if (instr) {
        const m = /^\s*(\\\*\s*)?\\?([A-Z]+)\s*(.*)$/.exec(instr);
        if (m) {
          kind = m[2].toLowerCase();
          // DOCPROPERTY / USERPROPERTY take an argument (the variable
          // name) — quoted or bare.
          const rest = m[3].trim();
          if (rest) {
            const q = /^"([^"]+)"/.exec(rest) ?? /^(\S+)/.exec(rest);
            if (q) name = q[1];
          }
        }
      }
      fields.push({ kind, name, visible: (visible ?? '').trim() });
      const idx = fields.length - 1;
      out += '\\WLFIELD' + idx + ' ';
      // i already past the closing brace.
      continue;
    }
    out += src[i];
    i++;
  }
  return { src: out, fields };
}

// pickRTFGroup : find `\fldinst` / `\fldrslt` and return the text
// inside its `{...}` group (the destination's payload). We do a
// shallow scan : the payload itself may carry control words but
// for V0.3 we just collapse them to their plain text.
function pickRTFGroup(src: string, name: string): string | null {
  const marker = '\\' + name;
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  // Walk back to the opening `{` that started the group containing
  // the marker.
  let braceStart = idx;
  while (braceStart > 0 && src[braceStart] !== '{') braceStart--;
  // Walk forward through the group body until its matching `}`.
  let depth = 1;
  let j = braceStart + 1;
  while (j < src.length && depth > 0) {
    if (src[j] === '\\' && (src[j + 1] === '{' || src[j + 1] === '}')) { j += 2; continue; }
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    if (depth === 0) break;
    j++;
  }
  const body = src.slice(idx + marker.length, j);
  // Drop the leading whitespace + the trailing `\*` or ignorable
  // markers ; keep the visible text by stripping any leftover
  // control words.
  return body.replace(/^\s+/, '').replace(/\\[A-Za-z]+(-?\d+)?\s?/g, '').trim();
}

// Style stack frame — every `{` clones, every `}` restores.
interface StyleFrame {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  skip: boolean;
  color?: string;
  background?: string;
  fontIdx?: number;
  fontSize?: number;
  strike?: boolean;
  vAlign?: 'sub' | 'super';
  uc: number; // \ucN bytes to skip after a \u escape
}

function freshFrame(): StyleFrame {
  return { bold: false, italic: false, underline: false, skip: false, uc: 1 };
}

export function parseRTF(rawSrc: string): RTFParsed {
  const { src, fields } = extractRTFFields(rawSrc);
  // The main parser loop reads the rewritten source ; whenever it
  // sees `\WLFIELD<idx>` it emits the field span instead of a
  // control word.
  let i = 0;
  const N = src.length;
  // Stack of style frames so `{` saves, `}` restores.
  const stack: StyleFrame[] = [freshFrame()];
  let html = '';
  let plain = '';
  const meta: RTFParsed['meta'] = {};
  let ansicpg = 0; // 0 = unspecified → fall back to Latin-1
  // Active "destination" — when a known control destination opens
  // (\fonttbl, \colortbl, \stylesheet, \pict, \info, …) we collect
  // text into a separate buffer that gets routed to meta or
  // discarded.
  type Destination =
    | 'doc' | 'fonttbl' | 'colortbl' | 'stylesheet' | 'pict' | 'info'
    | 'title' | 'author' | 'subject' | 'keywords' | 'company' | 'manager'
    | 'creatim' | 'revtim';
  let destination: Destination = ((): Destination => 'doc')();
  // Track which group depth opened the current non-doc destination so
  // nested groups inside the destination don't reset it prematurely.
  let destinationDepth = 0;
  let infoBuf = '';
  const colorTable: string[] = [];
  const fontTable: Array<{ name: string; family?: string }> = [];
  // Active builders for the table destinations + nested info date.
  let colorR = 0, colorG = 0, colorB = 0, colorHasRGB = false;
  let fontBuf = '';
  let fontFamily: string | undefined;
  let fontIdxBuf: number | undefined;
  const dateParts: { yr?: number; mo?: number; dy?: number; hr?: number; min?: number } = {};

  function buildIsoDate(): string {
    const yr = dateParts.yr ?? 0;
    const mo = dateParts.mo ?? 1;
    const dy = dateParts.dy ?? 1;
    const hr = dateParts.hr ?? 0;
    const mn = dateParts.min ?? 0;
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return pad(yr, 4) + '-' + pad(mo) + '-' + pad(dy) + 'T' + pad(hr) + ':' + pad(mn) + ':00';
  }
  function resetDateParts() {
    dateParts.yr = dateParts.mo = dateParts.dy = dateParts.hr = dateParts.min = undefined;
  }

  function escapeAttr(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c],
    );
  }

  function appendChar(c: string) {
    if (destination !== 'doc') {
      if (
        destination === 'title' || destination === 'author' ||
        destination === 'subject' || destination === 'keywords' ||
        destination === 'company' || destination === 'manager'
      ) infoBuf += c;
      else if (destination === 'colortbl') {
        // Color entries are delimited by ';' — accumulate \red/\green/\blue.
        if (c === ';') {
          if (colorHasRGB) {
            colorTable.push('rgb(' + colorR + ',' + colorG + ',' + colorB + ')');
          } else {
            // Empty entry (the auto-color slot) — still take a slot.
            colorTable.push('');
          }
          colorR = colorG = colorB = 0;
          colorHasRGB = false;
        }
      } else if (destination === 'fonttbl') {
        if (c === ';') {
          const name = fontBuf.trim();
          if (fontIdxBuf != null) {
            fontTable[fontIdxBuf] = { name, family: fontFamily };
          } else if (name) {
            fontTable.push({ name, family: fontFamily });
          }
          fontBuf = '';
          fontFamily = undefined;
          fontIdxBuf = undefined;
        } else {
          fontBuf += c;
        }
      }
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
    if (top.strike) chunk = '<s>' + chunk + '</s>';
    if (top.vAlign === 'sub') chunk = '<sub>' + chunk + '</sub>';
    else if (top.vAlign === 'super') chunk = '<sup>' + chunk + '</sup>';
    // Color + background : wrap in a styled span (attribute values
    // come from the colortbl, never from user text — safe to inline).
    const styleBits: string[] = [];
    if (top.color) styleBits.push('color:' + top.color);
    if (top.background) styleBits.push('background:' + top.background);
    if (styleBits.length) chunk = '<span style="' + escapeAttr(styleBits.join(';')) + '">' + chunk + '</span>';
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
  function setDestination(d: Destination, depth: number, skip = true) {
    destination = d;
    destinationDepth = depth;
    if (skip) stack[stack.length - 1].skip = true;
  }
  function closeDestination() {
    if (destination === 'title')    meta.title = infoBuf.trim();
    else if (destination === 'author')   meta.author = infoBuf.trim();
    else if (destination === 'subject')  meta.subject = infoBuf.trim();
    else if (destination === 'keywords') meta.keywords = infoBuf.trim();
    else if (destination === 'company')  meta.company = infoBuf.trim();
    else if (destination === 'manager')  meta.manager = infoBuf.trim();
    else if (destination === 'creatim')  meta.creatim = buildIsoDate();
    else if (destination === 'revtim')   meta.revtim = buildIsoDate();
    else if (destination === 'colortbl') {
      // Push any in-flight entry without a trailing ';' (edge case).
      if (colorHasRGB) {
        colorTable.push('rgb(' + colorR + ',' + colorG + ',' + colorB + ')');
        colorR = colorG = colorB = 0; colorHasRGB = false;
      }
    } else if (destination === 'fonttbl') {
      const name = fontBuf.trim();
      if (fontIdxBuf != null && name) {
        fontTable[fontIdxBuf] = { name, family: fontFamily };
      }
      fontBuf = ''; fontFamily = undefined; fontIdxBuf = undefined;
    }
    infoBuf = '';
    destination = 'doc';
    destinationDepth = 0;
  }

  // Open the document wrapper paragraph.
  html += '<p>';

  // Depth tracks the group nesting (1 = top, post root brace).
  let depth = 0;
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
        if (!isNaN(code)) {
          let glyph: string;
          if (ansicpg === 1252 && code >= 0x80 && code <= 0x9F && CP1252_C1[code]) {
            glyph = CP1252_C1[code];
          } else {
            glyph = String.fromCharCode(code);
          }
          appendChar(glyph);
        }
        continue;
      }
      // Control symbols.
      if (next === '\\' || next === '{' || next === '}') {
        appendChar(next);
        i++;
        continue;
      }
      if (next === '~') { appendChar(' '); i++; continue; }
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
        case 'plain':
          top.bold = top.italic = top.underline = false;
          top.strike = false;
          top.vAlign = undefined;
          top.color = undefined;
          top.background = undefined;
          break;
        case 'strike':    top.strike = param !== 0; break;
        case 'super':     top.vAlign = 'super'; break;
        case 'sub':       top.vAlign = 'sub'; break;
        case 'nosupersub':top.vAlign = undefined; break;
        case 'cf':
          if (param != null) {
            const c = colorTable[param];
            top.color = c && c.length ? c : undefined;
          }
          break;
        case 'highlight':
          if (param != null) {
            const c = colorTable[param];
            top.background = c && c.length ? c : undefined;
          }
          break;
        case 'f':
          if (destination === 'fonttbl') {
            // Inside the font table this defines the entry being built.
            fontIdxBuf = param ?? 0;
          } else if (param != null) {
            top.fontIdx = param;
          }
          break;
        case 'fnil': case 'froman': case 'fswiss': case 'fmodern':
        case 'fscript': case 'fdecor': case 'ftech': case 'fbidi':
          if (destination === 'fonttbl') fontFamily = cw;
          break;
        case 'fs':
          if (param != null) top.fontSize = param;
          break;
        case 'uc':
          // \ucN — number of fallback bytes that follow each \u escape.
          if (param != null && param >= 0) top.uc = param;
          break;
        case 'ansicpg':
          if (param != null) ansicpg = param;
          break;
        case 'red':   if (destination === 'colortbl' && param != null) { colorR = param; colorHasRGB = true; } break;
        case 'green': if (destination === 'colortbl' && param != null) { colorG = param; colorHasRGB = true; } break;
        case 'blue':  if (destination === 'colortbl' && param != null) { colorB = param; colorHasRGB = true; } break;
        // \info date sub-fields.
        case 'yr':  if ((destination === 'creatim' || destination === 'revtim') && param != null) dateParts.yr = param; break;
        case 'mo':  if ((destination === 'creatim' || destination === 'revtim') && param != null) dateParts.mo = param; break;
        case 'dy':  if ((destination === 'creatim' || destination === 'revtim') && param != null) dateParts.dy = param; break;
        case 'hr':  if ((destination === 'creatim' || destination === 'revtim') && param != null) dateParts.hr = param; break;
        case 'min': if ((destination === 'creatim' || destination === 'revtim') && param != null) dateParts.min = param; break;
        case 'version':
          // \version<N> inside \info — version number.
          if (destination === 'info' && param != null) meta.version = String(param);
          break;
        case 'u': {
          // \uN ? — N is a UTF-16 code point ; the ASCII fallback that
          // follows is `top.uc` byte(s) long (default 1). Skip exactly
          // that many code units, regardless of whether they're '?'.
          if (param != null) {
            appendChar(String.fromCharCode(param < 0 ? 0x10000 + param : param));
            let skipped = 0;
            const want = top.uc;
            while (skipped < want && i < N) {
              const c = src[i];
              if (c === '\\' || c === '{' || c === '}') break;
              // Whitespace immediately after the control word is the
              // delimiter, already consumed by the regex — but if any
              // remains, treat it as part of the fallback char run.
              i++;
              skipped++;
            }
          }
          break;
        }
        case 'WLFIELD':
          // T10 V0.3 : the extract-pre-pass emitted `\WLFIELD<idx> ` ;
          // resolve to the captured field + emit a <span.rtf-field>.
          if (destination === 'doc' && !top.skip) {
            const idx = param ?? 0;
            const f = fields[idx];
            if (f) {
              const safeName = escapeAttr(f.name);
              const safeVisible = escapeAttr(f.visible);
              const safeKind = escapeAttr(f.kind);
              html += '<span class="rtf-field" data-kind="' + safeKind + '"'
                   + (f.name ? ' data-name="' + safeName + '"' : '')
                   + '>' + safeVisible + '</span>';
              plain += f.visible;
            }
          }
          break;
        case 'fonttbl':   setDestination('fonttbl', depth); break;
        case 'colortbl':  setDestination('colortbl', depth); break;
        case 'stylesheet':setDestination('stylesheet', depth); break;
        case 'pict':      setDestination('pict', depth); break;
        case 'info':      setDestination('info', depth); break;
        case 'title':     setDestination('title', depth); infoBuf = ''; break;
        case 'author':    setDestination('author', depth); infoBuf = ''; break;
        case 'subject':   setDestination('subject', depth); infoBuf = ''; break;
        case 'keywords':  setDestination('keywords', depth); infoBuf = ''; break;
        case 'company':   setDestination('company', depth); infoBuf = ''; break;
        case 'manager':   setDestination('manager', depth); infoBuf = ''; break;
        case 'creatim':   setDestination('creatim', depth); resetDateParts(); break;
        case 'revtim':    setDestination('revtim', depth); resetDateParts(); break;
        default:          break; // unknown control words silently skipped
      }
      continue;
    }
    if (ch === '{') {
      const prev = stack[stack.length - 1];
      stack.push({ ...prev });
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      // Close current destination if THIS group is the one that opened
      // it. Inner groups inside the destination must not flush it.
      if (destination !== 'doc' && depth === destinationDepth) {
        closeDestination();
      }
      stack.pop();
      depth--;
      if (stack.length === 0) stack.push(freshFrame());
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
//   <p> / <div>           → \par-separated paragraph
//   <br>                  → \line
//   <b> / <strong>        → \b … \b0
//   <i> / <em>            → \i … \i0
//   <u>                   → \ul … \ul0
//   <s> / <strike> / <del>→ \strike … \strike0
//   <sub>                 → \sub … \nosupersub
//   <sup>                 → \super … \nosupersub
//   <h1>…<h3>             → \b \fs<n> … \b0 \par
//   <ul><li>              → • bullet line
//   <ol><li>              → 1. enumerated line (best-effort)
//
// Unknown tags are recursed into (we just emit their children) ;
// unknown attributes are dropped. The output starts with the
// canonical `{\rtf1\ansi\deff0\uc1{\fonttbl{\f0\fnil Helvetica;}}…`
// header so Word's compatibility layer doesn't downgrade to plain
// text on open.

const RTF_HEADER_OPEN =
  '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fnil Helvetica;}}';
const RTF_HEADER_BODY = '\\f0\\fs24 ';

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

interface LeafFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  vAlign?: 'sub' | 'super';
  color?: string;       // CSS color string (rgb()/hex/name)
  background?: string;
}
interface BlockBoundary { kind: 'par' | 'line' | 'bullet' | 'enum'; ordinal?: number; }
interface Leaf { kind: 'text'; text: string; fmt: LeafFormat; }
interface BoundaryLeaf { kind: 'boundary'; boundary: BlockBoundary; }
interface FieldLeaf { kind: 'field'; field: { kind: string; name: string; visible: string }; fmt: LeafFormat; }
type Item = Leaf | BoundaryLeaf | FieldLeaf;

// Inline tags that mutate the format frame as we descend.
const INLINE_FORMAT: Record<string, Partial<LeafFormat>> = {
  b: { bold: true }, strong: { bold: true },
  i: { italic: true }, em: { italic: true },
  u: { underline: true },
  s: { strike: true }, strike: { strike: true }, del: { strike: true },
  sub: { vAlign: 'sub' },
  sup: { vAlign: 'super' },
};
// Heading tags map to bold + a font size. We approximate by setting
// bold and emitting a wrapping `\fs<n>` token at the block level.
const HEADING_BOLD = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function parseCSSColor(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

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
    const next: LeafFormat = { ...fmt, ...INLINE_FORMAT[tag] };
    el.childNodes.forEach((c) => collectLeaves(c, next, out));
    return;
  }
  // T10 V0.3 : <span class="rtf-field" data-kind data-name data-result>
  // → emit a synthetic "field" leaf that serialises back to
  // `{\field{\*\fldinst KIND}{\fldrslt VISIBLE}}` on the writer side.
  if (tag === 'span' && (el.getAttribute('class') ?? '').includes('rtf-field')) {
    const kind = (el.getAttribute('data-kind') ?? 'page').toUpperCase();
    const name = el.getAttribute('data-name') ?? '';
    const visible = el.textContent ?? '';
    out.push({ kind: 'field', field: { kind, name, visible }, fmt: { ...fmt } });
    return;
  }
  // Inline-but-no-format wrappers : span etc. — pick up inline color
  // from a style attribute if present (writer emits `<span style="color:…">`).
  if (tag === 'span' || tag === 'font') {
    let next = fmt;
    const styleAttr = el.getAttribute('style') ?? '';
    if (styleAttr) {
      const m1 = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(styleAttr);
      const m2 = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(styleAttr);
      const color = parseCSSColor(m1 ? m1[1] : undefined);
      const background = parseCSSColor(m2 ? m2[1] : undefined);
      if (color || background) next = { ...fmt, color: color ?? fmt.color, background: background ?? fmt.background };
    }
    el.childNodes.forEach((c) => collectLeaves(c, next, out));
    return;
  }
  // Headings : descend with bold ON, mark the block boundary as a
  // heading so the emitter wraps with the right `\fs` size.
  if (HEADING_BOLD.has(tag)) {
    const next: LeafFormat = { ...fmt, bold: true };
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

// Build a colortbl from the unique colors we'll emit. Index 0 is the
// auto-color slot per RTF convention. Each color string maps to a
// `\redR\greenG\blueB;` entry. Returns the table + a lookup.
function buildColorTable(items: Item[]): { tbl: string; lookup: Map<string, number> } {
  const lookup = new Map<string, number>();
  const entries: string[] = [];
  const push = (color: string | undefined) => {
    if (!color) return;
    if (lookup.has(color)) return;
    const rgb = cssColorToRGB(color);
    if (!rgb) return;
    lookup.set(color, entries.length + 1); // +1 because slot 0 is auto
    entries.push('\\red' + rgb[0] + '\\green' + rgb[1] + '\\blue' + rgb[2] + ';');
  };
  for (const it of items) {
    if (it.kind === 'text' || it.kind === 'field') {
      push(it.fmt.color);
      push(it.fmt.background);
    }
  }
  // Always emit the leading auto-color semicolon.
  const tbl = '{\\colortbl;' + entries.join('') + '}';
  return { tbl, lookup };
}

function cssColorToRGB(color: string): [number, number, number] | null {
  const s = color.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const hex = m[1];
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return [r, g, b];
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  // Minimal named-color set.
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0], white: [255, 255, 255],
    red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
    yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
    gray: [128, 128, 128], grey: [128, 128, 128],
  };
  return named[s] ?? null;
}

function emitLeaves(items: Item[], colorIdx: Map<string, number>): string {
  let out = '';
  let cur: LeafFormat = { bold: false, italic: false, underline: false, strike: false };
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
    if (next.strike !== cur.strike) pending.push(next.strike ? '\\strike ' : '\\strike0 ');
    if (next.vAlign !== cur.vAlign) {
      if (next.vAlign === 'super') pending.push('\\super ');
      else if (next.vAlign === 'sub') pending.push('\\sub ');
      else pending.push('\\nosupersub ');
    }
    if (next.color !== cur.color) {
      const idx = next.color ? colorIdx.get(next.color) : undefined;
      pending.push('\\cf' + (idx ?? 0) + ' ');
    }
    if (next.background !== cur.background) {
      const idx = next.background ? colorIdx.get(next.background) : undefined;
      pending.push('\\highlight' + (idx ?? 0) + ' ');
    }
    cur = { ...next };
  };
  for (const it of items) {
    if (it.kind === 'text') {
      setFormat(it.fmt);
      pending.push(escapeRTFText(it.text));
      continue;
    }
    if (it.kind === 'field') {
      setFormat(it.fmt);
      // {\field{\*\fldinst KIND [name]}{\fldrslt VISIBLE}}
      // Quote the DOCPROPERTY name so spaces survive.
      const fld = it.field;
      const arg = fld.name ? ' "' + fld.name.replace(/"/g, '') + '"' : '';
      pending.push(
        '{\\field{\\*\\fldinst ' + fld.kind + arg + '}'
        + '{\\fldrslt ' + escapeRTFText(fld.visible) + '}}'
      );
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
      if (cur.strike)     { out += '\\strike0 '; cur.strike = false; }
      if (cur.vAlign)     { out += '\\nosupersub '; cur.vAlign = undefined; }
      if (cur.color)      { out += '\\cf0 '; cur.color = undefined; }
      if (cur.background) { out += '\\highlight0 '; cur.background = undefined; }
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
  if (cur.bold)       out += '\\b0 ';
  if (cur.italic)     out += '\\i0 ';
  if (cur.underline)  out += '\\ul0 ';
  if (cur.strike)     out += '\\strike0 ';
  if (cur.vAlign)     out += '\\nosupersub ';
  if (cur.color)      out += '\\cf0 ';
  if (cur.background) out += '\\highlight0 ';
  return out;
}

// Build an \info group block from the supplied meta. Empty fields are
// skipped. Strings go through escapeRTFText so non-ASCII survives.
function buildInfoBlock(meta: NonNullable<RTFParsed['meta']>): string {
  const parts: string[] = [];
  const push = (cw: string, v: string | undefined) => {
    if (!v) return;
    parts.push('{\\' + cw + ' ' + escapeRTFText(v) + '}');
  };
  push('title', meta.title);
  push('author', meta.author);
  push('subject', meta.subject);
  push('keywords', meta.keywords);
  push('company', meta.company);
  push('manager', meta.manager);
  // Dates : if ISO yyyy-mm-ddThh:mm[:ss] we expand to sub-fields.
  const pushDate = (cw: string, iso: string | undefined) => {
    if (!iso) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
    if (!m) return;
    let body = '\\yr' + parseInt(m[1], 10) + '\\mo' + parseInt(m[2], 10) + '\\dy' + parseInt(m[3], 10);
    if (m[4]) body += '\\hr' + parseInt(m[4], 10) + '\\min' + parseInt(m[5], 10);
    parts.push('{\\' + cw + body + '}');
  };
  pushDate('creatim', meta.creatim);
  pushDate('revtim', meta.revtim);
  if (meta.version) parts.push('{\\version' + parseInt(meta.version, 10) + '}');
  if (parts.length === 0) return '';
  return '{\\info' + parts.join('') + '}';
}

// writeRTF : top-level entry. Accepts a snippet of HTML (or a full
// fragment) and returns a complete RTF document. Optional `meta`
// param emits an `\info` group with the supplied fields.
export function writeRTF(html: string, meta?: RTFParsed['meta']): string {
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
  root.childNodes.forEach((n) => collectLeaves(n, { bold: false, italic: false, underline: false, strike: false }, items));
  // Build the colortbl from the leaves so the indexes the emitter
  // refers to are guaranteed valid.
  const { tbl: colorTbl, lookup: colorIdx } = buildColorTable(items);
  let body = emitLeaves(items, colorIdx);
  // Trim trailing \par so the document doesn't have a phantom blank
  // line at the end.
  body = body.replace(/(\\par\s*)+$/, '\\par ');
  const info = meta ? buildInfoBlock(meta) : '';
  return RTF_HEADER_OPEN + colorTbl + info + RTF_HEADER_BODY + body + '}';
}
