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
  meta: { title?: string; author?: string; date?: string };
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
// of meta.xml. All three are optional ; the result object only
// carries the keys that actually appeared.
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
}

// Paragraph-level hints surface as inline-style values on the HTML
// <p>/<h1-6> so the contenteditable preserves them visually + the
// writer can pull them back off on save.
interface ParaHints { align?: 'left' | 'center' | 'right' | 'justify'; }

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
      if (h.bold || h.italic || h.underline || h.strike || h.subscript || h.superscript || h.color || h.highlight) {
        styles.set(name, h);
      }
    }
    const pprops = s.getElementsByTagNameNS(NS.style, 'paragraph-properties')[0];
    if (pprops) {
      const ta = pprops.getAttributeNS(NS.fo, 'text-align');
      if (ta === 'start' || ta === 'left') paraStyles.set(name, { align: 'left' });
      else if (ta === 'center') paraStyles.set(name, { align: 'center' });
      else if (ta === 'end' || ta === 'right') paraStyles.set(name, { align: 'right' });
      else if (ta === 'justify') paraStyles.set(name, { align: 'justify' });
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
  if (ph?.align) attrs += ' style="text-align: ' + ph.align + ';"';
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
  if (ln === 'p') {
    return '<p' + attrs + '>' + emitInline(node, ctx.styles, ctx.pictures) + '</p>';
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
        // Each list-item contains one or more block children (typically
        // a single text:p). Emit them as <li>'s.
        let txt = '';
        for (const inner2 of Array.from(li.children)) txt += emitInline(inner2, ctx.styles, ctx.pictures);
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
      // V0.9 : colour + highlight wrap the whole inline subtree as a
      // single styled span so contenteditable can edit through it
      // without splintering the formatting.
      if (hints?.color || hints?.highlight) {
        const parts: string[] = [];
        if (hints.color)     parts.push('color: ' + hints.color);
        if (hints.highlight) parts.push('background-color: ' + hints.highlight);
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

const META_TEMPLATE = (now: string) => `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta
  xmlns:office="${NS.office}"
  xmlns:meta="${NS.meta}"
  xmlns:dc="${NS.dc}"
  office:version="1.2">
  <office:meta>
    <meta:generator>weft-loom-wysiwyg</meta:generator>
    <dc:date>${now}</dc:date>
  </office:meta>
</office:document-meta>
`;

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
): Promise<Uint8Array> {
  const collected: CollectedImage[] = [];
  const contentXML = htmlToContentXML(html, collected, preservedAutoStyles);

  const zip = new JSZip();
  // The mimetype entry must be first + uncompressed.
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.folder('META-INF')!.file('manifest.xml', buildManifest(collected));
  zip.file('meta.xml', META_TEMPLATE(now));
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
    if (!flags && !colorKey && !highlightKey) return null;
    const name = 'T_' + (flags || 'span') + colorKey + highlightKey;
    usedStyles.set(name, h);
    return name;
  };
  // Paragraph alignment : emit one <style:style style:family=
  // "paragraph"> per (alignment, source-style) combo we encounter.
  // The style ref attaches to <text:p text:style-name="…">. To keep
  // things simple : `P_align_<dir>` for naked alignments without a
  // source style name ; `<src>_align_<dir>` when chained on top.
  const usedAlignStyles = new Set<string>();
  const paraStyleNameFor = (existingStyle: string, align: string | null): string | null => {
    if (!align) return existingStyle || null;
    const base = existingStyle || 'P';
    const name = base + '_align_' + align;
    usedAlignStyles.add(name + '|' + align + '|' + existingStyle);
    return name;
  };
  // Ordered-list style : ODF wants <text:list-style> in automatic-
  // styles + <text:list text:style-name="L_ol">. We always emit
  // both L_ol + L_ul ; the unused one is harmless.
  let usedOL = false;
  let usedUL = false;
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
              + '/></style:style>\n';
  }
  for (const triple of usedAlignStyles) {
    const [name, align /*, base*/] = triple.split('|');
    if (preservedNames.has(name)) continue;
    stylesXML += `    <style:style style:name="${name}" style:family="paragraph">`
              + '<style:paragraph-properties fo:text-align="' + align + '"/>'
              + '</style:style>\n';
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
  paraStyleNameFor: (existingStyle: string, align: string | null) => string | null;
  imageRefFor: ImageRef;
  noteIdFor: NoteIdFor;
  markListKind: (k: ListKind) => void;
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
    const align = pickAlign(el);
    const name = ctx.paraStyleNameFor(odtStyle, align);
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
      if (li.tagName.toLowerCase() === 'li') {
        inner += '        <text:list-item><text:p>' + emitODTInline(li, fmt, ctx) + '</text:p></text:list-item>\n';
      }
    }
    return '      <text:list text:style-name="' + listStyleName + '">\n' + inner + '      </text:list>\n';
  }
  if (tag === 'br') {
    return '      <text:p/>\n';
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
    const next: StyleHints = { ...fmt };
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
      const legacy = el.getAttribute('color');
      if (!cm && legacy) next.color = legacy.toLowerCase();
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
    } else if (tag === 'sup' && (el.getAttribute('class') ?? '').includes('footnote')) {
      const id = el.getAttribute('data-id') || ctx.noteIdFor();
      const cls = ((el.getAttribute('class') ?? '').split(/\s+/).find(c => c !== 'footnote') ?? 'footnote');
      const cite = el.textContent ?? '';
      const body = el.getAttribute('data-body') ?? '';
      // data-body is HTML (V0.6 widened from plain text). Each line
      // is a paragraph ; parse with DOMParser + recurse through
      // emitODTInline so inline bold/italic/underline/links survive.
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
  const esc = escapeHTML(text);
  const name = styleNameFor(fmt);
  if (!name) return esc;
  return '<text:span text:style-name="' + name + '">' + esc + '</text:span>';
}
