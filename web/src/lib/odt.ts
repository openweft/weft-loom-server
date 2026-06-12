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
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  meta:   'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  dc:     'http://purl.org/dc/elements/1.1/',
};

export interface ODTParsed {
  html: string;
  meta: { title?: string; author?: string; date?: string };
}

// parseODT : read an ODT file (Blob / ArrayBuffer / Uint8Array) and
// return its body as HTML plus the meta-data. Pure-browser ; no
// network call.
export async function parseODT(data: ArrayBuffer | Uint8Array | Blob): Promise<ODTParsed> {
  const zip = await JSZip.loadAsync(data);
  const contentEntry = zip.file('content.xml');
  if (!contentEntry) throw new Error('ODT : missing content.xml — is this actually an ODF file?');
  const contentText = await contentEntry.async('string');
  const metaEntry = zip.file('meta.xml');
  const metaText = metaEntry ? await metaEntry.async('string') : '';

  const meta = parseMeta(metaText);
  const html = parseContent(contentText);
  return { html, meta };
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

interface StyleHints { bold?: boolean; italic?: boolean; underline?: boolean; }

// parseContent : walk content.xml and emit a sanitised HTML body
// snippet. The automatic-styles table is consulted to resolve span
// formatting (bold / italic / underline).
function parseContent(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // Build a style-name → StyleHints map from <office:automatic-styles>.
  // Word / LibreOffice both emit one <style:style style:name="…">
  // per inline run, with text properties that map cleanly to HTML
  // tags.
  const styles = new Map<string, StyleHints>();
  const styleEls = doc.getElementsByTagNameNS(NS.style, 'style');
  for (const s of Array.from(styleEls)) {
    const name = s.getAttributeNS(NS.style, 'name');
    if (!name) continue;
    const tprops = s.getElementsByTagNameNS(NS.style, 'text-properties')[0];
    if (!tprops) continue;
    const h: StyleHints = {};
    const fw = tprops.getAttributeNS(NS.fo, 'font-weight');
    if (fw && fw !== 'normal') h.bold = true;
    const fs = tprops.getAttributeNS(NS.fo, 'font-style');
    if (fs && fs !== 'normal') h.italic = true;
    const us = tprops.getAttributeNS(NS.style, 'text-underline-style');
    if (us && us !== 'none') h.underline = true;
    if (h.bold || h.italic || h.underline) styles.set(name, h);
  }

  const body = doc.getElementsByTagNameNS(NS.office, 'body')[0];
  const textRoot = body?.getElementsByTagNameNS(NS.office, 'text')[0];
  if (!textRoot) return '';
  let out = '';
  for (const child of Array.from(textRoot.children)) {
    out += emitBlock(child, styles);
  }
  return out;
}

function emitBlock(node: Element, styles: Map<string, StyleHints>): string {
  const ln = node.localName;
  if (ln === 'p') {
    return '<p>' + emitInline(node, styles) + '</p>';
  }
  if (ln === 'h') {
    const lvl = Math.min(6, Math.max(1, Number(node.getAttributeNS(NS.text, 'outline-level') ?? '1')));
    return '<h' + lvl + '>' + emitInline(node, styles) + '</h' + lvl + '>';
  }
  if (ln === 'list') {
    let inner = '';
    for (const li of Array.from(node.children)) {
      if (li.localName === 'list-item') {
        // Each list-item contains one or more block children (typically
        // a single text:p). Emit them as <li>'s.
        let txt = '';
        for (const inner2 of Array.from(li.children)) txt += emitInline(inner2, styles);
        inner += '<li>' + txt + '</li>';
      }
    }
    return '<ul>' + inner + '</ul>';
  }
  if (ln === 'table') {
    // table:table contains table:table-column (column metadata,
    // ignored for V0.2) + table:table-row entries. Each row carries
    // table:table-cell elements ; each cell holds one or more block
    // children (typically text:p). The first row maps to <thead>
    // when the cell has the heading style class — but ODF doesn't
    // formally distinguish header rows, so we keep everything in
    // <tbody> for now.
    let html = '<table>';
    for (const row of Array.from(node.children)) {
      if (row.localName !== 'table-row') continue;
      html += '<tr>';
      for (const cell of Array.from(row.children)) {
        if (cell.localName !== 'table-cell') continue;
        // Read row/col span if specified ; default to 1.
        const cs = Number(cell.getAttributeNS(NS.table, 'number-columns-spanned') ?? '1');
        const rs = Number(cell.getAttributeNS(NS.table, 'number-rows-spanned') ?? '1');
        let cellInner = '';
        for (const child of Array.from(cell.children)) cellInner += emitBlock(child, styles);
        // Strip the wrapping <p>…</p> if the cell only contains a
        // single paragraph — keeps the HTML cell terser and Word /
        // LibreOffice render it the same.
        const stripped = /^<p>([\s\S]*)<\/p>$/.exec(cellInner.trim());
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
  return emitInline(node, styles);
}

function emitInline(node: Node, styles: Map<string, StyleHints>): string {
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
      let inner = emitInline(el, styles);
      if (hints?.underline) inner = '<u>' + inner + '</u>';
      if (hints?.italic)    inner = '<i>' + inner + '</i>';
      if (hints?.bold)      inner = '<b>' + inner + '</b>';
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
      const href = el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
      out += '<a href="' + escapeAttr(href) + '">' + emitInline(el, styles) + '</a>';
    } else {
      // Unknown inline tag → recurse.
      out += emitInline(el, styles);
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

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="${NS.manifest}" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>
`;

// writeODT : produce an ODT byte stream from a contenteditable HTML
// snippet. `now` is injected so tests can pin a deterministic
// dc:date.
export async function writeODT(html: string, now: string = new Date().toISOString()): Promise<Uint8Array> {
  const zip = new JSZip();
  // The mimetype entry must be first + uncompressed.
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.folder('META-INF')!.file('manifest.xml', MANIFEST);
  zip.file('meta.xml', META_TEMPLATE(now));
  zip.file('content.xml', htmlToContentXML(html));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// htmlToContentXML : the inverse of parseContent. Walks the DOM
// emitted by the WYSIWYG and produces an ODF content.xml with
// per-document automatic-styles for the bold/italic/underline runs
// we encounter.
function htmlToContentXML(html: string): string {
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
  // one <style:style> per combination.
  const usedStyles = new Set<string>();
  const styleNameFor = (h: StyleHints): string | null => {
    if (!h.bold && !h.italic && !h.underline) return null;
    const key = (h.bold ? 'b' : '') + (h.italic ? 'i' : '') + (h.underline ? 'u' : '');
    const name = 'T_' + key;
    usedStyles.add(key);
    return name;
  };
  // Walk + emit body.
  let body = '';
  for (const c of Array.from(root.childNodes)) {
    body += emitODTBlock(c, { }, styleNameFor);
  }
  // Build the automatic-styles header from the used set.
  let stylesXML = '';
  for (const k of usedStyles) {
    const bold = k.includes('b'), italic = k.includes('i'), underline = k.includes('u');
    stylesXML += `    <style:style style:name="T_${k}" style:family="text">`
              + '<style:text-properties'
              + (bold      ? ' fo:font-weight="bold"' : '')
              + (italic    ? ' fo:font-style="italic"' : '')
              + (underline ? ' style:text-underline-style="solid"' : '')
              + '/></style:style>\n';
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="${NS.office}"
  xmlns:text="${NS.text}"
  xmlns:style="${NS.style}"
  xmlns:fo="${NS.fo}"
  xmlns:table="${NS.table}"
  xmlns:xlink="http://www.w3.org/1999/xlink"
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

function emitODTBlock(node: Node, fmt: StyleHints, styleNameFor: (h: StyleHints) => string | null): string {
  if (node.nodeType === 3) {
    return wrapInline(node.textContent ?? '', fmt, styleNameFor) ;
  }
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'p' || tag === 'div') {
    return '      <text:p>' + emitODTInline(el, fmt, styleNameFor) + '</text:p>\n';
  }
  if (/^h[1-6]$/.test(tag)) {
    const lvl = Number(tag.slice(1));
    return '      <text:h text:outline-level="' + lvl + '">' + emitODTInline(el, fmt, styleNameFor) + '</text:h>\n';
  }
  if (tag === 'ul' || tag === 'ol') {
    let inner = '';
    for (const li of Array.from(el.children)) {
      if (li.tagName.toLowerCase() === 'li') {
        inner += '        <text:list-item><text:p>' + emitODTInline(li, fmt, styleNameFor) + '</text:p></text:list-item>\n';
      }
    }
    return '      <text:list>\n' + inner + '      </text:list>\n';
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
        out += '          <table:table-cell' + attrs + '>'
            + '<text:p>' + emitODTInline(tdEl, fmt, styleNameFor) + '</text:p>'
            + '</table:table-cell>\n';
      }
      out += '        </table:table-row>\n';
    }
    out += '      </table:table>\n';
    return out;
  }
  // Unknown : descend transparently as a paragraph wrapper.
  return '      <text:p>' + emitODTInline(el, fmt, styleNameFor) + '</text:p>\n';
}

function emitODTInline(node: Node, fmt: StyleHints, styleNameFor: (h: StyleHints) => string | null): string {
  let out = '';
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3) {
      out += wrapInline(c.textContent ?? '', fmt, styleNameFor);
      continue;
    }
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    const tag = el.tagName.toLowerCase();
    const next: StyleHints = { ...fmt };
    if (tag === 'b' || tag === 'strong') next.bold = true;
    else if (tag === 'i' || tag === 'em') next.italic = true;
    else if (tag === 'u') next.underline = true;
    else if (tag === 'br') { out += '<text:line-break/>'; continue; }
    else if (tag === 'a') {
      const href = (el as HTMLAnchorElement).getAttribute('href') ?? '';
      out += '<text:a xlink:href="' + escapeAttr(href) + '">' + emitODTInline(el, fmt, styleNameFor) + '</text:a>';
      continue;
    }
    out += emitODTInline(el, next, styleNameFor);
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
