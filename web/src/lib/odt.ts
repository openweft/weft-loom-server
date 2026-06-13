// odt.ts — minimal OpenDocument Text (ODT) reader / writer.
//
// ODF files are ZIP archives. Key entries :
//
//   mimetype          first entry, uncompressed, "application/vnd.oasis.opendocument.text"
//   content.xml       the document body
//   META-INF/manifest.xml
//   meta.xml          title / author / date metadata
//   styles.xml        document-wide styles (default for V0.1)
//
// V0.1 scope :
//
//   READ
//     - paragraphs (text:p)              → <p>
//     - headings   (text:h, level 1-6)  → <h1>..<h6>
//     - lists      (text:list, text:list-item, text:p)
//                                         → <ul><li>…</li></ul>
//     - inline styling                   → BEST-EFFORT via the
//                                         automatic-styles table
//                                         when style-name resolves
//                                         to fo:font-weight=bold,
//                                         fo:font-style=italic, or
//                                         style:text-underline-style.
//   WRITE
//     - paragraphs + headings + lists
//     - inline bold/italic/underline via per-document style refs
//
// Image embedding + tables + footnotes land in V0.2. The user can
// still author them in Word/LibreOffice ; we'll preserve them as
// raw HTML when the WYSIWYG round-trip can handle them.

import JSZip from 'jszip';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text:   'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style:  'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo:     'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  table:  'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw:   'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  svg:    'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink:  'http://www.w3.org/1999/xlink',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  meta:   'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  dc:     'http://purl.org/dc/elements/1.1/',
};

export interface ODTParsed {
  html: string;
  meta: {
    title?: string;
    author?: string;
    date?: string;
    // T10 : user-defined meta vars (<meta:user-defined name="X">value</meta:user-defined>).
    // Round-trip with the document ; surfaced in the Variables
    // sidebar so the user can edit them without touching XML.
    userDefined?: Record<string, string>;
  };
  // Raw `<office:automatic-styles>` block from the source content.xml.
  // The reader can't surface every Word-/LibreOffice-specific style
  // attribute as semantic HTML, so we stash the entries verbatim and
  // re-emit them on save — any user-customised paragraph/cell/list
  // style the document referenced by name still resolves correctly
  // in the saved file.
  preservedAutoStyles?: string;
}

// parseODT : read an ODT file (Blob / ArrayBuffer / Uint8Array) and
// return its body as HTML plus the meta-data. Pure-browser ; no
// network call.
//
// Embedded images : Pictures/* entries inside the zip are pre-loaded
// as base64 data URLs + handed to parseContent so `<draw:image>`
// references can be inlined into `<img src="data:...">`. Round-trip
// preserves the bytes : writeODT pulls the data URLs back out and
// re-packages them under Pictures/.
export async function parseODT(data: ArrayBuffer | Uint8Array | Blob): Promise<ODTParsed> {
  const zip = await JSZip.loadAsync(data);
  const contentEntry = zip.file('content.xml');
  if (!contentEntry) throw new Error('ODT : missing content.xml — is this actually an ODF file?');
  const contentText = await contentEntry.async('string');
  const metaEntry = zip.file('meta.xml');
  const metaText = metaEntry ? await metaEntry.async('string') : '';

  // Pre-load Pictures/* → data URLs. Each file's basename keeps its
  // MIME type via the extension (.png/.jpg/.svg/.gif/.webp) ; we
  // fall back to image/octet-stream when unknown.
  const pictures: Record<string, string> = {};
  await Promise.all(
    Object.entries(zip.files)
      .filter(([path, e]) => !e.dir && path.startsWith('Pictures/'))
      .map(async ([path, e]) => {
        const b64 = await e.async('base64');
        const mime = mimeForExt(path);
        pictures[path] = 'data:' + mime + ';base64,' + b64;
      }),
  );

  const meta = parseMeta(metaText);
  const html = parseContent(contentText, pictures);
  const preservedAutoStyles = extractAutoStyles(contentText);
  return { html, meta, preservedAutoStyles };
}

// T10 : the set of <text:*> local names we treat as fields. Any
// element here is replaced by a single <span class="odt-field"…>
// in the WYSIWYG. The list covers the high-frequency Word/LO
// surface — page counters, dates, title/author from <office:meta>,
// chapter / file-name navigation aids, AND the user-defined
// custom-variable getter (text:user-field-get).
const FIELD_LOCALS = new Set([
  'page-number',
  'page-count',
  'date',
  'time',
  'title',
  'subject',
  'description',
  'keywords',
  'author-name',
  'author-initials',
  'initial-creator',
  'creation-date',
  'creation-time',
  'modification-date',
  'modification-time',
  'chapter',
  'file-name',
  'user-field-get',
  'variable-get',
  'sequence',
]);

// Human-readable placeholder text for a field whose source doesn't
// carry a rendered value (the user may insert one from the toolbar
// before Word/LO has had a chance to evaluate it).
function fieldLabel(kind: string, name: string): string {
  switch (kind) {
    case 'page-number':       return '[#]';
    case 'page-count':        return '[N]';
    case 'date':              return '[date]';
    case 'time':              return '[time]';
    case 'title':             return '[title]';
    case 'subject':           return '[subject]';
    case 'description':       return '[description]';
    case 'keywords':          return '[keywords]';
    case 'author-name':       return '[author]';
    case 'author-initials':   return '[initials]';
    case 'initial-creator':   return '[creator]';
    case 'creation-date':     return '[created]';
    case 'creation-time':     return '[created-time]';
    case 'modification-date': return '[modified]';
    case 'modification-time': return '[modified-time]';
    case 'chapter':           return '[chapter]';
    case 'file-name':         return '[file]';
    case 'sequence':          return '[#' + name + ']';
    case 'user-field-get':
    case 'variable-get':
      return '[$' + (name || 'var') + ']';
    default: return '[' + kind + ']';
  }
}

// extractAutoStyles : pull the inner XML of <office:automatic-styles>
// from content.xml as a raw string. We can't re-serialise via
// DOMParser without losing prefix consistency, and the spec lets us
// pass the block through verbatim so we go with the regex.
function extractAutoStyles(xml: string): string {
  const m = /<office:automatic-styles[^>]*>([\s\S]*?)<\/office:automatic-styles>/.exec(xml);
  return m ? m[1].trim() : '';
}

function mimeForExt(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  switch (m?.[1]) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'tif': case 'tiff': return 'image/tiff';
    default: return 'application/octet-stream';
  }
}

// parseMeta : pull <dc:title>, <meta:initial-creator>, <dc:date> out
// of meta.xml, plus all <meta:user-defined> entries. All optional ;
// the result object only carries the keys that actually appeared.
function parseMeta(xml: string): ODTParsed['meta'] {
  const out: ODTParsed['meta'] = {};
  if (!xml) return out;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const title = doc.getElementsByTagNameNS(NS.dc, 'title')[0]?.textContent;
  if (title) out.title = title.trim();
  const creator = doc.getElementsByTagNameNS(NS.meta, 'initial-creator')[0]?.textContent
              || doc.getElementsByTagNameNS(NS.dc, 'creator')[0]?.textContent;
  if (creator) out.author = creator.trim();
  const date = doc.getElementsByTagNameNS(NS.dc, 'date')[0]?.textContent;
  if (date) out.date = date.trim();
  // T10 : user-defined meta vars. <meta:user-defined meta:name="X">val</…>
  const ud: Record<string, string> = {};
  for (const el of Array.from(doc.getElementsByTagNameNS(NS.meta, 'user-defined'))) {
    const name = el.getAttributeNS(NS.meta, 'name');
    const value = el.textContent ?? '';
    if (name) ud[name] = value;
  }
  if (Object.keys(ud).length) out.userDefined = ud;
  return out;
}

interface StyleHints {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  subscript?: boolean;
  superscript?: boolean;
  // V0.9 : per-span colour overrides. Lowercase #rrggbb format ;
  // 'transparent' is dropped to undefined (matches ODF's "no
  // background" semantics).
  color?: string;
  highlight?: string;
  // V0.13 : per-span font face + size. fontSize keeps the source
  // unit (pt / px / em / cm) so round-trip is byte-identical for
  // common Word-/LO-emitted values like "11pt" or "10.5pt".
  fontFamily?: string;
  fontSize?: string;
}

// Paragraph-level hints surface as inline-style values on the HTML
// <p>/<h1-6> so the contenteditable preserves them visually + the
// writer can pull them back off on save.
interface ParaHints {
  align?: 'left' | 'center' | 'right' | 'justify';
  pageBreakBefore?: boolean;
  lineHeight?: string;
  marginLeft?: string;
  textIndent?: string;
}

// ListKind : ODF lists are tagged with a style-name pointing into a
// <text:list-style> entry ; the entry's child element decides
// numbering (text:list-level-style-number) vs bullets
// (text:list-level-style-bullet). The reader exposes that distinction
// as <ol> vs <ul>.
type ListKind = 'ul' | 'ol';

// parseContent : walk content.xml and emit a sanitised HTML body
// snippet. The automatic-styles table is consulted to resolve span
// formatting (bold / italic / underline).
function parseContent(xml: string, pictures: Record<string, string>): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // Build a style-name → StyleHints map from <office:automatic-styles>.
  // Word / LibreOffice both emit one <style:style style:name="…">
  // per inline run, with text properties that map cleanly to HTML
  // tags.
  const styles = new Map<string, StyleHints>();
  const paraStyles = new Map<string, ParaHints>();
  const listKinds = new Map<string, ListKind>();
  const styleEls = doc.getElementsByTagNameNS(NS.style, 'style');
  for (const s of Array.from(styleEls)) {
    const name = s.getAttributeNS(NS.style, 'name');
    if (!name) continue;
    const tprops = s.getElementsByTagNameNS(NS.style, 'text-properties')[0];
    if (tprops) {
      const h: StyleHints = {};
      const fw = tprops.getAttributeNS(NS.fo, 'font-weight');
      if (fw && fw !== 'normal') h.bold = true;
      const fs = tprops.getAttributeNS(NS.fo, 'font-style');
      if (fs && fs !== 'normal') h.italic = true;
      const us = tprops.getAttributeNS(NS.style, 'text-underline-style');
      if (us && us !== 'none') h.underline = true;
      const ls = tprops.getAttributeNS(NS.style, 'text-line-through-style');
      if (ls && ls !== 'none') h.strike = true;
      const col = tprops.getAttributeNS(NS.fo, 'color');
      if (col && col.toLowerCase() !== 'transparent') h.color = col.toLowerCase();
      const bg = tprops.getAttributeNS(NS.fo, 'background-color');
      if (bg && bg.toLowerCase() !== 'transparent') h.highlight = bg.toLowerCase();
      const ff = tprops.getAttributeNS(NS.fo, 'font-family')
              || tprops.getAttributeNS(NS.style, 'font-name');
      if (ff) h.fontFamily = ff;
      const fz = tprops.getAttributeNS(NS.fo, 'font-size');
      if (fz) h.fontSize = fz;
      const pos = tprops.getAttributeNS(NS.style, 'text-position');
      if (pos) {
        const head = pos.split(/\s+/)[0];
        if (head === 'sub') h.subscript = true;
        else if (head === 'super') h.superscript = true;
        else {
          // Numeric percentage : positive = super, negative = sub.
          const pct = parseFloat(head);
          if (!Number.isNaN(pct)) {
            if (pct > 0) h.superscript = true;
            else if (pct < 0) h.subscript = true;
          }
        }
      }
      if (h.bold || h.italic || h.underline || h.strike || h.subscript || h.superscript || h.color || h.highlight || h.fontFamily || h.fontSize) {
        styles.set(name, h);
      }
    }
    const pprops = s.getElementsByTagNameNS(NS.style, 'paragraph-properties')[0];
    if (pprops) {
      const existing = paraStyles.get(name) ?? {};
      const ta = pprops.getAttributeNS(NS.fo, 'text-align');
      if (ta === 'start' || ta === 'left') existing.align = 'left';
      else if (ta === 'center') existing.align = 'center';
      else if (ta === 'end' || ta === 'right') existing.align = 'right';
      else if (ta === 'justify') existing.align = 'justify';
      const bb = pprops.getAttributeNS(NS.fo, 'break-before');
      if (bb === 'page') existing.pageBreakBefore = true;
      const lh = pprops.getAttributeNS(NS.fo, 'line-height');
      if (lh) existing.lineHeight = lh;
      const ml = pprops.getAttributeNS(NS.fo, 'margin-left');
      if (ml) existing.marginLeft = ml;
      const ti = pprops.getAttributeNS(NS.fo, 'text-indent');
      if (ti) existing.textIndent = ti;
      if (existing.align || existing.pageBreakBefore || existing.lineHeight
       || existing.marginLeft || existing.textIndent) {
        paraStyles.set(name, existing);
      }
    }
  }
  // <text:list-style style:name="LO1"> resolves to <ol> when the
  // first level uses text:list-level-style-number, to <ul> otherwise.
  const listStyleEls = doc.getElementsByTagNameNS(NS.text, 'list-style');
  for (const ls of Array.from(listStyleEls)) {
    const name = ls.getAttributeNS(NS.style, 'name');
    if (!name) continue;
    const hasNumber = ls.getElementsByTagNameNS(NS.text, 'list-level-style-number').length > 0;
    listKinds.set(name, hasNumber ? 'ol' : 'ul');
  }

  const ctx: ParseCtx = { styles, paraStyles, listKinds, pictures };
  const body = doc.getElementsByTagNameNS(NS.office, 'body')[0];
  const textRoot = body?.getElementsByTagNameNS(NS.office, 'text')[0];
  if (!textRoot) return '';
  let out = '';
  for (const child of Array.from(textRoot.children)) {
    out += emitBlock(child, ctx);
  }
  return out;
}

interface ParseCtx {
  styles: Map<string, StyleHints>;
  paraStyles: Map<string, ParaHints>;
  listKinds: Map<string, ListKind>;
  pictures: Record<string, string>;
}

function paraStyleAttrs(styleName: string, ctx: ParseCtx): string {
  let attrs = styleName ? ' data-odt-style="' + escapeAttr(styleName) + '"' : '';
  const ph = ctx.paraStyles.get(styleName);
  const parts: string[] = [];
  if (ph?.align)       parts.push('text-align: ' + ph.align);
  if (ph?.lineHeight)  parts.push('line-height: ' + ph.lineHeight);
  if (ph?.marginLeft)  parts.push('margin-left: ' + ph.marginLeft);
  if (ph?.textIndent)  parts.push('text-indent: ' + ph.textIndent);
  if (parts.length) attrs += ' style="' + parts.join('; ') + ';"';
  return attrs;
}

function emitBlock(node: Element, ctx: ParseCtx): string {
  const ln = node.localName;
  // Preserve any text:style-name on the paragraph / heading so the
  // writer can re-emit it verbatim. Named styles like "Quotation",
  // "Heading 1", or user-customised entries survive the round-trip.
  // Paragraph alignment resolved from <style:paragraph-properties
  // fo:text-align="…"> surfaces as inline style="text-align:…".
  const styleName = node.getAttributeNS(NS.text, 'style-name') ?? '';
  const attrs = paraStyleAttrs(styleName, ctx);
  // V0.10 : a paragraph whose resolved style carries break-before
  // becomes a sibling <hr class="page-break"> ; an empty body means
  // the whole paragraph IS the break marker (Word emits these).
  const ph = ctx.paraStyles.get(styleName);
  const pageBreak = ph?.pageBreakBefore ? '<hr class="page-break">' : '';
  if (ln === 'p') {
    const inner = emitInline(node, ctx.styles, ctx.pictures);
    if (pageBreak && !inner.trim()) return pageBreak;
    return pageBreak + '<p' + attrs + '>' + inner + '</p>';
  }
  if (ln === 'h') {
    const lvl = Math.min(6, Math.max(1, Number(node.getAttributeNS(NS.text, 'outline-level') ?? '1')));
    return '<h' + lvl + attrs + '>' + emitInline(node, ctx.styles, ctx.pictures) + '</h' + lvl + '>';
  }
  if (ln === 'list') {
    const listStyleName = node.getAttributeNS(NS.text, 'style-name') ?? '';
    const kind = ctx.listKinds.get(listStyleName) ?? 'ul';
    let inner = '';
    for (const li of Array.from(node.children)) {
      if (li.localName === 'list-item') {
        // V0.11 : a list-item carries one or more block children :
        //   - text:p / text:h → inline content of the <li>
        //   - text:list       → nested <ul>/<ol> as a child of <li>
        // Anything else falls through emitBlock so we don't drop
        // unfamiliar block markers.
        let txt = '';
        for (const child of Array.from(li.children)) {
          if (child.localName === 'p' || child.localName === 'h') {
            txt += emitInline(child, ctx.styles, ctx.pictures);
          } else if (child.localName === 'list') {
            txt += emitBlock(child, ctx);
          } else {
            txt += emitBlock(child, ctx);
          }
        }
        inner += '<li>' + txt + '</li>';
      }
    }
    return '<' + kind + '>' + inner + '</' + kind + '>';
  }
  if (ln === 'table') {
    let html = '<table>';
    for (const row of Array.from(node.children)) {
      if (row.localName !== 'table-row') continue;
      html += '<tr>';
      for (const cell of Array.from(row.children)) {
        if (cell.localName !== 'table-cell') continue;
        const cs = Number(cell.getAttributeNS(NS.table, 'number-columns-spanned') ?? '1');
        const rs = Number(cell.getAttributeNS(NS.table, 'number-rows-spanned') ?? '1');
        let cellInner = '';
        for (const child of Array.from(cell.children)) cellInner += emitBlock(child, ctx);
        const stripped = /^<p[^>]*>([\s\S]*)<\/p>$/.exec(cellInner.trim());
        const body = stripped ? stripped[1] : cellInner;
        let attrs = '';
        if (cs > 1) attrs += ' colspan="' + cs + '"';
        if (rs > 1) attrs += ' rowspan="' + rs + '"';
        html += '<td' + attrs + '>' + body + '</td>';
      }
      html += '</tr>';
    }
    return html + '</table>';
  }
  // Unknown block : fall through to inline so we don't drop content.
  return emitInline(node, ctx.styles, ctx.pictures);
}

function emitInline(node: Node, styles: Map<string, StyleHints>, pictures: Record<string, string>): string {
  let out = '';
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3 /* TEXT_NODE */) {
      out += escapeHTML(c.textContent ?? '');
      continue;
    }
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    const ln = el.localName;
    if (ln === 'span') {
      const name = el.getAttributeNS(NS.text, 'style-name') ?? '';
      const hints = styles.get(name);
      let inner = emitInline(el, styles, pictures);
      // V0.7 adds strike + sub/super. <sup>/<sub> wrap the innermost
      // so the visible text sits inside the smaller font ; <s>
      // sits outside so the strikethrough crosses all decorations.
      if (hints?.subscript)   inner = '<sub>' + inner + '</sub>';
      if (hints?.superscript) inner = '<sup>' + inner + '</sup>';
      if (hints?.underline)   inner = '<u>' + inner + '</u>';
      if (hints?.italic)      inner = '<i>' + inner + '</i>';
      if (hints?.bold)        inner = '<b>' + inner + '</b>';
      if (hints?.strike)      inner = '<s>' + inner + '</s>';
      // V0.9 + V0.13 : colour / highlight / font wrap the whole
      // inline subtree as a single styled span so contenteditable can
      // edit through it without splintering the formatting.
      if (hints?.color || hints?.highlight || hints?.fontFamily || hints?.fontSize) {
        const parts: string[] = [];
        if (hints.color)      parts.push('color: ' + hints.color);
        if (hints.highlight)  parts.push('background-color: ' + hints.highlight);
        if (hints.fontFamily) parts.push('font-family: ' + hints.fontFamily);
        if (hints.fontSize)   parts.push('font-size: ' + hints.fontSize);
        inner = '<span style="' + parts.join('; ') + ';">' + inner + '</span>';
      }
      out += inner;
    } else if (ln === 'line-break') {
      out += '<br>';
    } else if (ln === 'tab') {
      out += '\t';
    } else if (ln === 's') {
      // Compressed runs of spaces — `c="N"` is the count.
      const n = Number(el.getAttributeNS(NS.text, 'c') ?? '1');
      out += ' '.repeat(n);
    } else if (ln === 'a') {
      // Hyperlink ; we keep the visible text + the href.
      const href = el.getAttributeNS(NS.xlink, 'href') ?? '';
      out += '<a href="' + escapeAttr(href) + '">' + emitInline(el, styles, pictures) + '</a>';
    } else if (ln === 'bookmark' || ln === 'bookmark-start') {
      // V0.10 point + range bookmarks. Range bookmarks emit a marker
      // pair (-start + matching -end) ; for the contenteditable we
      // surface both as anchor-like <a class="odt-bookmark"> with a
      // data-role to distinguish them.
      const bmName = el.getAttributeNS(NS.text, 'name') ?? '';
      const role = ln === 'bookmark' ? 'point' : 'start';
      out += '<a class="odt-bookmark" data-name="' + escapeAttr(bmName)
          + '" data-role="' + role + '"></a>';
    } else if (ln === 'bookmark-end') {
      const bmName = el.getAttributeNS(NS.text, 'name') ?? '';
      out += '<a class="odt-bookmark" data-name="' + escapeAttr(bmName)
          + '" data-role="end"></a>';
    } else if (ln === 'soft-page-break') {
      out += '<hr class="page-break">';
    } else if (FIELD_LOCALS.has(ln) && el.namespaceURI === NS.text) {
      // T10 ODT field round-trip. Each ODF field maps to a single
      // <span class="odt-field" data-kind=… data-name=… data-fmt=…>
      // where kind is the field type ("page-number" / "page-count" /
      // "date" / "title" / "author-name" / "user-field-get" / …),
      // name the variable name (user-field-get only), fmt the
      // display format hint where the source provided one.
      const kind = ln;
      const name = el.getAttributeNS(NS.text, 'name') ?? '';
      const fmt = el.getAttributeNS(NS.style, 'num-format')
               || el.getAttributeNS(NS.text, 'fixed-date')
               || '';
      // Visible glyph : the source's displayed value. Word/LO render
      // the current value when they write the file, so we surface
      // it as-is + let the user pick whether to re-render on save.
      const visible = (el.textContent ?? '').trim();
      const label = visible || fieldLabel(kind, name);
      out += '<span class="odt-field"'
          + ' data-kind="' + escapeAttr(kind) + '"'
          + (name ? ' data-name="' + escapeAttr(name) + '"' : '')
          + (fmt ? ' data-fmt="' + escapeAttr(fmt) + '"' : '')
          + '>' + escapeHTML(label) + '</span>';
    } else if (ln === 'annotation' && el.namespaceURI === NS.office) {
      // V0.10 comments/annotations. ODF :
      //   <office:annotation>
      //     <dc:creator>…</dc:creator>
      //     <dc:date>…</dc:date>
      //     <text:p>…</text:p>+
      //   </office:annotation>
      // We surface as a single inline span carrying the metadata
      // in data-attrs ; rich-body paragraphs join on '\n' just like
      // footnote bodies.
      const creator = el.getElementsByTagNameNS(NS.dc, 'creator')[0]?.textContent ?? '';
      const date = el.getElementsByTagNameNS(NS.dc, 'date')[0]?.textContent ?? '';
      let bodyHTML = '';
      for (const p of Array.from(el.getElementsByTagNameNS(NS.text, 'p'))) {
        if (bodyHTML) bodyHTML += '\n';
        bodyHTML += emitInline(p, styles, pictures);
      }
      out += '<span class="odt-annotation"'
          + ' data-creator="' + escapeAttr(creator) + '"'
          + ' data-date="' + escapeAttr(date) + '"'
          + ' data-body="' + escapeAttr(bodyHTML) + '"'
          + ' title="' + escapeAttr(creator + (date ? ' — ' + date : '')) + '">'
          + '💬</span>';
    } else if (ln === 'note') {
      // <text:note text:id=… text:note-class="footnote">
      //   <text:note-citation>N</text:note-citation>
      //   <text:note-body><text:p>…</text:p></text:note-body>
      // </text:note>
      // We surface footnotes as <sup class="footnote" data-id=… data-body=…>N</sup>
      // so contenteditable can round-trip them in V0.5. Body is
      // plain text only ; rich-body lands in V0.6.
      const id = el.getAttributeNS(NS.text, 'id') ?? '';
      const cls = el.getAttributeNS(NS.text, 'note-class') ?? 'footnote';
      const cite = el.getElementsByTagNameNS(NS.text, 'note-citation')[0]?.textContent ?? '';
      const bodyEl = el.getElementsByTagNameNS(NS.text, 'note-body')[0];
      // Each <text:p> inside the body walks through emitInline so we
      // preserve inline bold/italic/underline (and links / breaks /
      // tab runs) — multi-paragraph bodies join on '\n'. The result
      // is HTML, attribute-encoded into data-body so contenteditable
      // doesn't render it.
      let bodyHTML = '';
      if (bodyEl) {
        for (const p of Array.from(bodyEl.getElementsByTagNameNS(NS.text, 'p'))) {
          if (bodyHTML) bodyHTML += '\n';
          bodyHTML += emitInline(p, styles, pictures);
        }
      }
      out += '<sup class="footnote ' + escapeAttr(cls)
          + '" data-id="' + escapeAttr(id)
          + '" data-body="' + escapeAttr(bodyHTML)
          + '">' + escapeHTML(cite) + '</sup>';
    } else if (ln === 'frame') {
      // draw:frame wraps draw:image (and other media). Find the
      // image child + resolve its href against the pictures map.
      // External http(s) hrefs pass through as-is ; internal
      // Pictures/* refs become data URLs.
      const img = el.getElementsByTagNameNS(NS.draw, 'image')[0];
      const href = img?.getAttributeNS(NS.xlink, 'href') ?? '';
      let src = href;
      if (href && !/^https?:|^data:/.test(href)) {
        // The href is a relative ZIP path. The Pictures-map key is
        // the same path verbatim ; if absent, fall back to the raw
        // href so the editor at least shows a broken-image icon
        // instead of silently dropping the media.
        src = pictures[href] ?? href;
      }
      // Pull the on-page name/title for alt text if present.
      const alt = el.getAttributeNS(NS.draw, 'name') ?? '';
      out += '<img src="' + escapeAttr(src) + '"'
          + (alt ? ' alt="' + escapeAttr(alt) + '"' : '')
          + '>';
    } else {
      // Unknown inline tag → recurse.
      out += emitInline(el, styles, pictures);
    }
  }
  return out;
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------
// Writer — HTML → ODT bytes.
//
// Round-trips the WysiwygEditor's output (the same DOM shape its
// writeRTF consumes). Emits an ODF 1.2 package with the four
// canonical entries (mimetype / META-INF/manifest.xml / content.xml
// / meta.xml). The mimetype entry is added first and uncompressed,
// as the spec requires.

const META_TEMPLATE = (now: string, userDefined?: Record<string, string>) => {
  let extras = '';
  if (userDefined) {
    for (const [name, value] of Object.entries(userDefined)) {
      extras += '    <meta:user-defined meta:name="' + escapeAttr(name) + '">'
              + escapeHTML(value) + '</meta:user-defined>\n';
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta
  xmlns:office="${NS.office}"
  xmlns:meta="${NS.meta}"
  xmlns:dc="${NS.dc}"
  office:version="1.2">
  <office:meta>
    <meta:generator>weft-loom-wysiwyg</meta:generator>
    <dc:date>${now}</dc:date>
${extras}  </office:meta>
</office:document-meta>
`;
};

interface CollectedImage { path: string; bytes: Uint8Array; mime: string; }

// writeODT : produce an ODT byte stream from a contenteditable HTML
// snippet. `now` is injected so tests can pin a deterministic
// dc:date.
//
// `<img src="data:image/*;base64,…">` tags are extracted during the
// HTML→ODT walk, the bytes land under Pictures/imageN.<ext> in the
// zip, the references become `<draw:frame><draw:image xlink:href=
// "Pictures/imageN.<ext>"/></draw:frame>` in content.xml, AND the
// manifest gains a file-entry per image so Word / LibreOffice can
// find the media. External http(s) URLs pass through unchanged (no
// repack — the xlink:href stays absolute).
export async function writeODT(
  html: string,
  now: string = new Date().toISOString(),
  preservedAutoStyles: string = '',
  userDefined?: Record<string, string>,
): Promise<Uint8Array> {
  const collected: CollectedImage[] = [];
  const contentXML = htmlToContentXML(html, collected, preservedAutoStyles);

  const zip = new JSZip();
  // The mimetype entry must be first + uncompressed.
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.folder('META-INF')!.file('manifest.xml', buildManifest(collected));
  zip.file('meta.xml', META_TEMPLATE(now, userDefined));
  zip.file('content.xml', contentXML);
  for (const img of collected) {
    zip.file(img.path, img.bytes);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function buildManifest(images: CollectedImage[]): string {
  let extras = '';
  for (const img of images) {
    extras += '  <manifest:file-entry manifest:full-path="' + img.path
           + '" manifest:media-type="' + img.mime + '"/>\n';
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="${NS.manifest}" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
${extras}</manifest:manifest>
`;
}

// htmlToContentXML : the inverse of parseContent. Walks the DOM
// emitted by the WYSIWYG and produces an ODF content.xml with
// per-document automatic-styles for the bold/italic/underline runs
// we encounter.
function htmlToContentXML(html: string, collected: CollectedImage[], preservedAutoStyles: string): string {
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
  // Collect distinct StyleHints sets used in the doc so we can emit
  // one <style:style> per combination. Flag encoding uses single
  // letters so the resulting name is stable + short :
  //   b=bold  i=italic  u=underline  s=strike  B=subscript  P=superscript
  // V0.9 adds colour + highlight by appending `_c<hex>` / `_h<hex>`
  // (hex stripped of '#') ; one auto-style entry per distinct combo.
  const usedStyles = new Map<string, StyleHints>();
  const styleNameFor = (h: StyleHints): string | null => {
    const flags = (h.bold ? 'b' : '')
                + (h.italic ? 'i' : '')
                + (h.underline ? 'u' : '')
                + (h.strike ? 's' : '')
                + (h.subscript ? 'B' : '')
                + (h.superscript ? 'P' : '');
    const colorKey = h.color ? '_c' + h.color.replace(/^#/, '') : '';
    const highlightKey = h.highlight ? '_h' + h.highlight.replace(/^#/, '') : '';
    const fontKey = h.fontFamily ? '_f' + h.fontFamily.replace(/\W+/g, '') : '';
    const sizeKey = h.fontSize ? '_z' + h.fontSize.replace(/\W+/g, '') : '';
    if (!flags && !colorKey && !highlightKey && !fontKey && !sizeKey) return null;
    const name = 'T_' + (flags || 'span') + colorKey + highlightKey + fontKey + sizeKey;
    usedStyles.set(name, h);
    return name;
  };
  // Paragraph-properties auto-style emit (V0.14 widens from just
  // text-align to align + line-height + margin-left + text-indent).
  // Each distinct (existingStyle × ph) combination produces one
  // <style:style style:family="paragraph"> ; the style ref attaches
  // to <text:p text:style-name="…">.
  const usedParaStyles = new Map<string, { ph: ParaHints; existing: string }>();
  const paraStyleNameFor = (existingStyle: string, ph: ParaHints): string | null => {
    const hasAny = ph.align || ph.lineHeight || ph.marginLeft || ph.textIndent;
    if (!hasAny) return existingStyle || null;
    // Synthesize a deterministic name from the props so identical
    // combos share a definition.
    const parts: string[] = [];
    if (ph.align)      parts.push('a' + ph.align);
    if (ph.lineHeight) parts.push('l' + ph.lineHeight.replace(/\W+/g, ''));
    if (ph.marginLeft) parts.push('m' + ph.marginLeft.replace(/\W+/g, ''));
    if (ph.textIndent) parts.push('t' + ph.textIndent.replace(/\W+/g, ''));
    const base = existingStyle || 'P';
    const name = base + '_' + parts.join('_');
    usedParaStyles.set(name, { ph, existing: existingStyle });
    return name;
  };
  // Ordered-list style : ODF wants <text:list-style> in automatic-
  // styles + <text:list text:style-name="L_ol">. We always emit
  // both L_ol + L_ul ; the unused one is harmless.
  let usedOL = false;
  let usedUL = false;
  let usedPagebreak = false;
  // Walk + emit body. Image collection runs as a side-effect of the
  // emitter — every <img> push appends to `collected`.
  const imageRefFor = (src: string, alt: string): string => {
    if (!src) return '';
    if (/^https?:/.test(src)) {
      // External URL — pass through verbatim, no repack.
      return drawFrame(src, alt);
    }
    if (src.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(src);
      if (!m) return '';
      const mime = m[1];
      const b64 = m[2];
      const ext = extForMime(mime);
      const idx = collected.length + 1;
      const path = 'Pictures/image' + idx + '.' + ext;
      collected.push({ path, mime, bytes: base64Decode(b64) });
      return drawFrame(path, alt);
    }
    // Unknown scheme (relative path etc.) — keep as-is.
    return drawFrame(src, alt);
  };

  let footnoteSeq = 0;
  const noteIdFor: NoteIdFor = () => 'ftn' + (++footnoteSeq);

  const writeCtx: WriteCtx = {
    styleNameFor,
    paraStyleNameFor,
    imageRefFor,
    noteIdFor,
    markListKind: (k: ListKind) => { if (k === 'ol') usedOL = true; else usedUL = true; },
    markPagebreak: () => { usedPagebreak = true; },
  };

  let body = '';
  for (const c of Array.from(root.childNodes)) {
    body += emitODTBlock(c, { }, writeCtx);
  }
  // Build the automatic-styles header. We re-emit the preserved
  // entries from the source content.xml first (so any user-customised
  // paragraph/cell/list styles still resolve), then append our
  // T_b/T_i/T_u entries. Dedup is name-scoped : a preserved entry with
  // the same style:name as one of ours wins, since the document body
  // likely references it.
  const preservedNames = new Set<string>();
  for (const m of preservedAutoStyles.matchAll(/style:name="([^"]+)"/g)) {
    preservedNames.add(m[1]);
  }
  let stylesXML = preservedAutoStyles ? preservedAutoStyles + '\n' : '';
  for (const [name, h] of usedStyles) {
    if (preservedNames.has(name)) continue;
    stylesXML += `    <style:style style:name="${name}" style:family="text">`
              + '<style:text-properties'
              + (h.bold        ? ' fo:font-weight="bold"' : '')
              + (h.italic      ? ' fo:font-style="italic"' : '')
              + (h.underline   ? ' style:text-underline-style="solid"' : '')
              + (h.strike      ? ' style:text-line-through-style="solid"' : '')
              + (h.subscript   ? ' style:text-position="sub 58%"' : '')
              + (h.superscript ? ' style:text-position="super 58%"' : '')
              + (h.color       ? ' fo:color="' + escapeAttr(h.color) + '"' : '')
              + (h.highlight   ? ' fo:background-color="' + escapeAttr(h.highlight) + '"' : '')
              + (h.fontFamily  ? ' fo:font-family="' + escapeAttr(h.fontFamily) + '"' : '')
              + (h.fontSize    ? ' fo:font-size="' + escapeAttr(h.fontSize) + '"' : '')
              + '/></style:style>\n';
  }
  for (const [name, { ph }] of usedParaStyles) {
    if (preservedNames.has(name)) continue;
    stylesXML += `    <style:style style:name="${name}" style:family="paragraph">`
              + '<style:paragraph-properties'
              + (ph.align       ? ' fo:text-align="' + ph.align + '"' : '')
              + (ph.lineHeight  ? ' fo:line-height="' + escapeAttr(ph.lineHeight) + '"' : '')
              + (ph.marginLeft  ? ' fo:margin-left="' + escapeAttr(ph.marginLeft) + '"' : '')
              + (ph.textIndent  ? ' fo:text-indent="' + escapeAttr(ph.textIndent) + '"' : '')
              + '/></style:style>\n';
  }
  if (usedOL && !preservedNames.has('L_ol')) {
    stylesXML += `    <text:list-style style:name="L_ol">
      <text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/>
    </text:list-style>\n`;
  }
  if (usedUL && !preservedNames.has('L_ul')) {
    stylesXML += `    <text:list-style style:name="L_ul">
      <text:list-level-style-bullet text:level="1" text:bullet-char="•"/>
    </text:list-style>\n`;
  }
  if (usedPagebreak && !preservedNames.has('P_pagebreak')) {
    stylesXML += `    <style:style style:name="P_pagebreak" style:family="paragraph">`
              + '<style:paragraph-properties fo:break-before="page"/>'
              + '</style:style>\n';
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="${NS.office}"
  xmlns:text="${NS.text}"
  xmlns:style="${NS.style}"
  xmlns:fo="${NS.fo}"
  xmlns:table="${NS.table}"
  xmlns:draw="${NS.draw}"
  xmlns:xlink="${NS.xlink}"
  xmlns:svg="${NS.svg}"
  xmlns:dc="${NS.dc}"
  office:version="1.2">
  <office:automatic-styles>
${stylesXML}  </office:automatic-styles>
  <office:body>
    <office:text>
${body}
    </office:text>
  </office:body>
</office:document-content>
`;
}

// drawFrame : ODF `<draw:frame>` wrapper around a `<draw:image>`
// reference. width/height default to a sensible thumbnail size when
// the DOM doesn't carry explicit values — the V0.3 reader doesn't
// preserve per-image sizing yet, this lands in V0.4.
function drawFrame(href: string, alt: string): string {
  const altAttr = alt ? ' draw:name="' + escapeAttr(alt) + '"' : '';
  return '<draw:frame' + altAttr + ' text:anchor-type="as-char" svg:width="3in" svg:height="2in">'
       + '<draw:image xlink:href="' + escapeAttr(href) + '" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>'
       + '</draw:frame>';
}

function extForMime(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/svg+xml': return 'svg';
    case 'image/webp': return 'webp';
    case 'image/bmp': return 'bmp';
    case 'image/tiff': return 'tiff';
    default: return 'bin';
  }
}

function base64Decode(b64: string): Uint8Array {
  // Browser path : atob → byte string → Uint8Array. The atob call
  // is fast for small payloads ; for very large images (> a few MB)
  // this hangs the main thread briefly but is acceptable for V0.3.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type ImageRef = (src: string, alt: string) => string;
type NoteIdFor = () => string;

interface WriteCtx {
  styleNameFor: (h: StyleHints) => string | null;
  paraStyleNameFor: (existingStyle: string, ph: ParaHints) => string | null;
  imageRefFor: ImageRef;
  noteIdFor: NoteIdFor;
  markListKind: (k: ListKind) => void;
  markPagebreak: () => void;
}

// Pull a normalised text-align value out of an element's style="…"
// attribute. Returns null when there's no inline alignment.
function pickAlign(el: Element): string | null {
  const inline = el.getAttribute('style') ?? '';
  const m = /text-align\s*:\s*([a-z]+)/i.exec(inline);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (v === 'left' || v === 'center' || v === 'right' || v === 'justify') return v;
  return null;
}

// pickParaProps : V0.14 generalisation of pickAlign. Returns the
// full set of paragraph-level inline-style props the writer can
// translate to fo:line-height / fo:margin-left / fo:text-indent.
function pickParaProps(el: Element): ParaHints {
  const out: ParaHints = {};
  const align = pickAlign(el);
  if (align === 'left' || align === 'center' || align === 'right' || align === 'justify') {
    out.align = align;
  }
  const inline = el.getAttribute('style') ?? '';
  const lh = /(?:^|;)\s*line-height\s*:\s*([^;]+)/i.exec(inline);
  if (lh) out.lineHeight = lh[1].trim();
  const ml = /(?:^|;)\s*margin-left\s*:\s*([^;]+)/i.exec(inline);
  if (ml) out.marginLeft = ml[1].trim();
  const ti = /(?:^|;)\s*text-indent\s*:\s*([^;]+)/i.exec(inline);
  if (ti) out.textIndent = ti[1].trim();
  return out;
}

function emitODTBlock(node: Node, fmt: StyleHints, ctx: WriteCtx): string {
  if (node.nodeType === 3) {
    return wrapInline(node.textContent ?? '', fmt, ctx.styleNameFor) ;
  }
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  // Resolve a style-name attribute string : existing data-odt-style +
  // any text-align lifted from the HTML inline style="…". When both
  // are absent we omit the attribute entirely.
  const odtBlockStyleAttr = (): string => {
    const odtStyle = el.getAttribute('data-odt-style') ?? '';
    const ph = pickParaProps(el);
    const name = ctx.paraStyleNameFor(odtStyle, ph);
    return name ? ' text:style-name="' + escapeAttr(name) + '"' : '';
  };
  if (tag === 'p' || tag === 'div') {
    return '      <text:p' + odtBlockStyleAttr() + '>' + emitODTInline(el, fmt, ctx) + '</text:p>\n';
  }
  if (/^h[1-6]$/.test(tag)) {
    const lvl = Number(tag.slice(1));
    return '      <text:h text:outline-level="' + lvl + '"' + odtBlockStyleAttr() + '>' + emitODTInline(el, fmt, ctx) + '</text:h>\n';
  }
  if (tag === 'ul' || tag === 'ol') {
    const kind: ListKind = tag === 'ol' ? 'ol' : 'ul';
    ctx.markListKind(kind);
    const listStyleName = kind === 'ol' ? 'L_ol' : 'L_ul';
    let inner = '';
    for (const li of Array.from(el.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      // V0.11 : split the <li>'s children into a text-prefix (the
      // <li>'s direct text + inline content) + any nested <ul>/<ol>
      // which become inner <text:list> blocks under this list-item.
      const items: Element[] = [];
      const inlineFrag = document.createDocumentFragment();
      for (const child of Array.from(li.childNodes)) {
        if (child.nodeType === 1) {
          const ct = (child as Element).tagName.toLowerCase();
          if (ct === 'ul' || ct === 'ol') {
            items.push(child as Element);
            continue;
          }
        }
        inlineFrag.appendChild(child.cloneNode(true));
      }
      const inlineXML = emitODTInline(inlineFrag as unknown as Element, fmt, ctx);
      let nestedXML = '';
      for (const n of items) {
        nestedXML += emitODTBlock(n, fmt, ctx);
      }
      inner += '        <text:list-item><text:p>' + inlineXML + '</text:p>'
            + (nestedXML ? '\n' + nestedXML + '        ' : '')
            + '</text:list-item>\n';
    }
    return '      <text:list text:style-name="' + listStyleName + '">\n' + inner + '      </text:list>\n';
  }
  if (tag === 'br') {
    return '      <text:p/>\n';
  }
  if (tag === 'hr' && (el.getAttribute('class') ?? '').includes('page-break')) {
    // V0.10 : emit a paragraph that carries a break-before style so
    // Word / LibreOffice both honour the page break. Style ref =
    // P_pagebreak ; the auto-style entry lands in stylesXML.
    ctx.markPagebreak();
    return '      <text:p text:style-name="P_pagebreak"/>\n';
  }
  if (tag === 'table') {
    // Walk all rows under <tbody> + <thead> indiscriminately. Most
    // contenteditable surfaces don't insert <tbody> wrappers, so
    // we accept either direct-child <tr> or wrapped.
    const rows: Element[] = [];
    for (const c of Array.from(el.children)) {
      const t = c.tagName.toLowerCase();
      if (t === 'tr') rows.push(c);
      else if (t === 'tbody' || t === 'thead' || t === 'tfoot') {
        for (const tr of Array.from(c.children)) {
          if (tr.tagName.toLowerCase() === 'tr') rows.push(tr);
        }
      }
    }
    const colCount = rows.reduce((m, r) => Math.max(m, r.children.length), 1);
    let out = '      <table:table>\n';
    out += '        <table:table-column table:number-columns-repeated="' + colCount + '"/>\n';
    for (const tr of rows) {
      out += '        <table:table-row>\n';
      for (const tdEl of Array.from(tr.children)) {
        const t = tdEl.tagName.toLowerCase();
        if (t !== 'td' && t !== 'th') continue;
        const cs = Number((tdEl as HTMLElement).getAttribute('colspan') ?? '1');
        const rs = Number((tdEl as HTMLElement).getAttribute('rowspan') ?? '1');
        let attrs = '';
        if (cs > 1) attrs += ' table:number-columns-spanned="' + cs + '"';
        if (rs > 1) attrs += ' table:number-rows-spanned="' + rs + '"';
        // The cell can contain text + inline images. Split into a
        // <text:p> for the text + bare <draw:frame> after when
        // there's an <img> child ; ODF prefers draw:frame as a
        // sibling of text:p rather than nested.
        const cellInline = emitODTInline(tdEl, fmt, ctx);
        out += '          <table:table-cell' + attrs + '>'
            + '<text:p>' + cellInline + '</text:p>'
            + '</table:table-cell>\n';
      }
      out += '        </table:table-row>\n';
    }
    out += '      </table:table>\n';
    return out;
  }
  // Block-level <img> (the contenteditable usually inserts inline,
  // but pasted images can land as direct children of the body) :
  // wrap in a <text:p> so the draw:frame has a paragraph parent.
  if (tag === 'img') {
    const src = (el as HTMLImageElement).getAttribute('src') ?? '';
    const alt = (el as HTMLImageElement).getAttribute('alt') ?? '';
    return '      <text:p>' + ctx.imageRefFor(src, alt) + '</text:p>\n';
  }
  // Unknown : descend transparently as a paragraph wrapper.
  return '      <text:p>' + emitODTInline(el, fmt, ctx) + '</text:p>\n';
}

function emitODTInline(node: Node, fmt: StyleHints, ctx: WriteCtx): string {
  let out = '';
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3) {
      out += wrapInline(c.textContent ?? '', fmt, ctx.styleNameFor);
      continue;
    }
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    const tag = el.tagName.toLowerCase();
    const klass = el.getAttribute('class') ?? '';
    const next: StyleHints = { ...fmt };
    // V0.10 specific markers : bookmark / annotation / footnote ALL
    // win over the generic <a>/<span>/<sup> chain below. Check them
    // first so the elif chain can't capture them by mistake.
    if (tag === 'span' && klass.includes('odt-field')) {
      // T10 : re-emit a span as the ODF field element it came from.
      const kind = el.getAttribute('data-kind') ?? 'page-number';
      const nm = el.getAttribute('data-name') ?? '';
      const fmt = el.getAttribute('data-fmt') ?? '';
      const visible = el.textContent ?? '';
      const safeKind = FIELD_LOCALS.has(kind) ? kind : 'page-number';
      const attrs: string[] = [];
      if (nm) attrs.push('text:name="' + escapeAttr(nm) + '"');
      if (fmt && (safeKind === 'page-number' || safeKind === 'page-count' || safeKind === 'sequence')) {
        attrs.push('style:num-format="' + escapeAttr(fmt) + '"');
      }
      if (safeKind === 'page-number') attrs.push('text:select-page="current"');
      const head = '<text:' + safeKind + (attrs.length ? ' ' + attrs.join(' ') : '') + '>';
      out += head + escapeHTML(visible) + '</text:' + safeKind + '>';
      continue;
    }
    if (tag === 'a' && klass.includes('odt-bookmark')) {
      const nm = el.getAttribute('data-name') ?? '';
      const role = el.getAttribute('data-role') ?? 'point';
      const eltag = role === 'point' ? 'text:bookmark'
                  : role === 'start' ? 'text:bookmark-start'
                  : 'text:bookmark-end';
      out += '<' + eltag + ' text:name="' + escapeAttr(nm) + '"/>';
      continue;
    }
    if (tag === 'span' && klass.includes('odt-annotation')) {
      const creator = el.getAttribute('data-creator') ?? '';
      const date = el.getAttribute('data-date') ?? '';
      const body = el.getAttribute('data-body') ?? '';
      const bodyParas = body.split('\n').map(lineHTML => {
        const tmp = (() => {
          try {
            return new DOMParser().parseFromString(
              '<!doctype html><html><body>' + lineHTML + '</body></html>',
              'text/html',
            ).body;
          } catch {
            const d = document.createElement('div');
            d.innerHTML = lineHTML;
            return d;
          }
        })();
        return '<text:p>' + emitODTInline(tmp, fmt, ctx) + '</text:p>';
      }).join('');
      out += '<office:annotation>'
          + (creator ? '<dc:creator>' + escapeHTML(creator) + '</dc:creator>' : '')
          + (date ? '<dc:date>' + escapeHTML(date) + '</dc:date>' : '')
          + bodyParas
          + '</office:annotation>';
      continue;
    }
    if (tag === 'sup' && klass.includes('footnote')) {
      // (V0.6 footnote handling moved here so it can't be captured
      //  by the generic <sup> case below.)
      const id = el.getAttribute('data-id') || ctx.noteIdFor();
      const cls = (klass.split(/\s+/).find(c => c !== 'footnote') ?? 'footnote');
      const cite = el.textContent ?? '';
      const body = el.getAttribute('data-body') ?? '';
      const bodyParas = body.split('\n').map(lineHTML => {
        const tmp = (() => {
          try {
            return new DOMParser().parseFromString(
              '<!doctype html><html><body>' + lineHTML + '</body></html>',
              'text/html',
            ).body;
          } catch {
            const d = document.createElement('div');
            d.innerHTML = lineHTML;
            return d;
          }
        })();
        return '<text:p>' + emitODTInline(tmp, fmt, ctx) + '</text:p>';
      }).join('');
      out += '<text:note text:id="' + escapeAttr(id)
          + '" text:note-class="' + escapeAttr(cls) + '">'
          + '<text:note-citation>' + escapeHTML(cite) + '</text:note-citation>'
          + '<text:note-body>' + bodyParas + '</text:note-body>'
          + '</text:note>';
      continue;
    }
    if (tag === 'b' || tag === 'strong') next.bold = true;
    else if (tag === 'i' || tag === 'em') next.italic = true;
    else if (tag === 'u') next.underline = true;
    else if (tag === 's' || tag === 'strike' || tag === 'del') next.strike = true;
    else if (tag === 'sub') next.subscript = true;
    else if (tag === 'mark') next.highlight = next.highlight || '#ffff00';
    if (tag === 'span' || tag === 'font') {
      // V0.9 : pick colour + highlight out of inline style="…" /
      // legacy <font color=…>. Either may also appear nested under
      // semantic tags above (bold, italic, etc.) ; we set `next` to
      // accumulate.
      const inline = el.getAttribute('style') ?? '';
      const cm = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(inline);
      if (cm) next.color = cm[1].trim().toLowerCase();
      const bm = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(inline);
      if (bm) next.highlight = bm[1].trim().toLowerCase();
      const fm = /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(inline);
      if (fm) next.fontFamily = fm[1].trim();
      const sm = /(?:^|;)\s*font-size\s*:\s*([^;]+)/i.exec(inline);
      if (sm) next.fontSize = sm[1].trim();
      const legacy = el.getAttribute('color');
      if (!cm && legacy) next.color = legacy.toLowerCase();
      const legacyFace = el.getAttribute('face');
      if (!fm && legacyFace) next.fontFamily = legacyFace;
      const legacySize = el.getAttribute('size');
      if (!sm && legacySize) next.fontSize = legacySize + 'pt';
    }
    else if (tag === 'br') { out += '<text:line-break/>'; continue; }
    else if (tag === 'a') {
      const href = (el as HTMLAnchorElement).getAttribute('href') ?? '';
      out += '<text:a xlink:href="' + escapeAttr(href) + '">' + emitODTInline(el, fmt, ctx) + '</text:a>';
      continue;
    } else if (tag === 'img') {
      const src = (el as HTMLImageElement).getAttribute('src') ?? '';
      const alt = (el as HTMLImageElement).getAttribute('alt') ?? '';
      out += ctx.imageRefFor(src, alt);
      continue;
    } else if (tag === 'sup') {
      // Non-footnote <sup> = explicit superscript run.
      next.superscript = true;
    }
    out += emitODTInline(el, next, ctx);
  }
  return out;
}

function wrapInline(text: string, fmt: StyleHints, styleNameFor: (h: StyleHints) => string | null): string {
  if (!text) return '';
  // V0.12 : tabs + multi-space runs need ODF-specific elements
  // (<text:tab/> + <text:s c="N"/>) so Word + LibreOffice render
  // them. A literal '\t' or '   ' would otherwise survive the XML
  // round-trip but render collapsed to single spaces.
  const esc = encodeWhitespace(escapeHTML(text));
  const name = styleNameFor(fmt);
  if (!name) return esc;
  return '<text:span text:style-name="' + name + '">' + esc + '</text:span>';
}

function encodeWhitespace(text: string): string {
  // Replace \t with <text:tab/>, then runs of 2+ spaces with
  // <text:s c="N-1"/> (the first space stays as a literal space,
  // the rest are compressed).
  return text
    .replace(/\t/g, '<text:tab/>')
    .replace(/ {2,}/g, m => ' <text:s c="' + (m.length - 1) + '"/>');
}
