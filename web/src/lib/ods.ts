// ods.ts — minimal OpenDocument Spreadsheet reader / writer.
//
// ODS files are ZIP archives with the same outer shape as ODT :
//
//   mimetype          first entry, "application/vnd.oasis.opendocument.spreadsheet"
//   content.xml       <office:spreadsheet><table:table>+ payload
//   META-INF/manifest.xml
//   meta.xml          title / author / date metadata (same schema as ODT)
//   styles.xml        document-wide styles (optional)
//
// V0.1 scope :
//
//   READ
//     - all sheets (table:table style:name="…")
//     - cells : office:value-type ∈ {string, float, int, percentage,
//                                    date, time, boolean}
//                + office:value / office:date-value / office:boolean-value
//                + the visible text from the contained <text:p>
//     - colspan / rowspan via table:number-columns-spanned /
//                            table:number-rows-spanned
//     - blank cells with table:number-columns-repeated unrolled
//
//   WRITE
//     - same surface back into a fresh ODS zip
//
// V0.2 (follow-up) : formulas (table:formula="of:=A1+B1"), styles
// pass-through, charts, pivot tables.

import JSZip from 'jszip';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table:  'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text:   'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  meta:   'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  dc:     'http://purl.org/dc/elements/1.1/',
};

export type CellType = 'string' | 'float' | 'int' | 'percentage' | 'date' | 'time' | 'boolean';

export interface ODSCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  // Text colour + cell background — both hex strings ("#rrggbb").
  color?: string;
  background?: string;
  // Paragraph alignment within the cell.
  align?: 'left' | 'center' | 'right' | 'justify';
  // Per-cell font face + size (size in pt).
  fontFamily?: string;
  fontSize?: string;
  // Borders : single colour string per side ; missing = no border.
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
  // Number format hint (V0.2 — formatter not wired yet).
  numberFormat?: string;
}

export interface ODSCell {
  // Visible text in the cell (what `office:value` resolves to OR the
  // <text:p> content for string cells).
  display: string;
  // Underlying typed value. For string cells this duplicates
  // `display` ; for numeric cells it carries the parsed number.
  value: string | number | boolean;
  type: CellType;
  // Optional formula carried as `table:formula="of:=A1+B1"`. V0.1
  // surfaces it for round-trip but doesn't evaluate ; that's V0.2
  // via HyperFormula.
  formula?: string;
  colspan?: number;
  rowspan?: number;
  // T9 V0.4 : per-cell formatting (bold/italic/underline, colours,
  // alignment, font, borders). Round-tripped to a synthetic
  // <style:style style:family="table-cell"> in the saved ODS.
  style?: ODSCellStyle;
  // <table:covered-table-cell/> marker. Cells covered by a colspan/
  // rowspan above/left keep their slot in the dense grid but emit
  // back as <table:covered-table-cell/> rather than <table:table-cell/>.
  covered?: boolean;
  // Column-repeat spacer : an empty cell that originally carried
  // `table:number-columns-repeated="N"`. We keep ONE cell entry to
  // avoid materialising thousands of phantom slots, and re-emit it
  // as a single repeated cell on write.
  repeat?: number;
  // Row-repeat marker on the FIRST cell of a row that was originally
  // emitted as `<table:table-row table:number-rows-repeated="N">`.
  // The row appears once in `cells[]`; on write we restore the
  // number-rows-repeated attribute.
  rowRepeat?: number;
}

export interface ODSSheet {
  name: string;
  // 2D array of cells indexed as cells[row][col]. Blank cells get
  // an empty-string Cell entry rather than `undefined` so callers
  // can iterate safely.
  cells: ODSCell[][];
}

export interface ODSParsed {
  sheets: ODSSheet[];
  meta: { title?: string; author?: string; date?: string };
}

export async function parseODS(data: ArrayBuffer | Uint8Array | Blob): Promise<ODSParsed> {
  const zip = await JSZip.loadAsync(data);
  const contentEntry = zip.file('content.xml');
  if (!contentEntry) throw new Error('ODS : missing content.xml');
  const xml = await contentEntry.async('string');
  const metaEntry = zip.file('meta.xml');
  const metaText = metaEntry ? await metaEntry.async('string') : '';

  const meta = parseMeta(metaText);
  const sheets = parseSheets(xml);
  return { sheets, meta };
}

function parseMeta(xml: string): ODSParsed['meta'] {
  const out: ODSParsed['meta'] = {};
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

// numberFormatsRegistry : populated during parse, drained during write
// so emitContent can re-emit the captured number-format XML once per
// unique data-style-name.
let lastParsedNumberFormats: Map<string, string> = new Map();

function parseSheets(xml: string): ODSSheet[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // T9 V0.4 : pre-scan <style:style style:family="table-cell"> so
  // table:style-name references resolve to ODSCellStyle on the
  // way out of parseCellsInRow.
  const scan = parseCellStyles(doc);
  lastParsedNumberFormats = scan.numberFormats;
  const tables = doc.getElementsByTagNameNS(NS.table, 'table');
  const sheets: ODSSheet[] = [];
  for (const table of Array.from(tables)) {
    const name = table.getAttributeNS(NS.table, 'name') ?? 'Sheet';
    const rows = table.getElementsByTagNameNS(NS.table, 'table-row');
    const cells: ODSCell[][] = [];
    for (const row of Array.from(rows)) {
      const rowRepeat = Number(row.getAttributeNS(NS.table, 'number-rows-repeated') ?? '1');
      const baseRow = parseCellsInRow(row, scan.styles);
      const empty = isEmptyRow(baseRow);
      if (empty && rowRepeat > 1) {
        // Collapse N empty rows into one with rowRepeat — avoids
        // materialising the 1024-empty-row trailers some writers emit.
        const cloned = baseRow.map(c => ({ ...c, style: c.style ? { ...c.style } : undefined }));
        if (cloned.length > 0) cloned[0].rowRepeat = rowRepeat;
        cells.push(cloned);
      } else {
        for (let i = 0; i < rowRepeat; i++) {
          cells.push(baseRow.map(c => ({ ...c, style: c.style ? { ...c.style } : undefined })));
        }
      }
    }
    sheets.push({ name, cells });
  }
  return sheets;
}

function isEmptyCell(c: ODSCell): boolean {
  if (c.formula) return false;
  if (c.style) return false;
  if (c.covered) return false;
  if (c.type === 'string') return c.display === '' && c.value === '';
  if (c.type === 'boolean') return c.value === false;
  return c.value === '' || c.value === 0;
}

function isEmptyRow(cells: ODSCell[]): boolean {
  for (const c of cells) if (!isEmptyCell(c)) return false;
  return true;
}

const NS_STYLE  = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const NS_FO     = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';
const NS_NUMBER = 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0';

const NUMBER_FORMAT_TAGS = [
  'date-style', 'currency-style', 'number-style',
  'percentage-style', 'time-style', 'text-style', 'boolean-style',
];

interface CellStylesScan {
  styles: Map<string, ODSCellStyle>;
  // styleName → raw XML of a number:*-style element, for round-trip.
  numberFormats: Map<string, string>;
  // table-cell style name → data-style-name (the linked number format).
  dataStyleByCellStyle: Map<string, string>;
}

function parseCellStyles(doc: Document): CellStylesScan {
  const out = new Map<string, ODSCellStyle>();
  const numberFormats = new Map<string, string>();
  const dataStyleByCellStyle = new Map<string, string>();
  // First pass : collect every number:*-style block in both
  // <office:automatic-styles> and <office:styles> by their style:name.
  for (const tag of NUMBER_FORMAT_TAGS) {
    const els = doc.getElementsByTagNameNS(NS_NUMBER, tag);
    for (const el of Array.from(els)) {
      const name = el.getAttributeNS(NS_STYLE, 'name');
      if (!name) continue;
      numberFormats.set(name, serializeElement(el));
    }
  }
  const els = doc.getElementsByTagNameNS(NS_STYLE, 'style');
  for (const el of Array.from(els)) {
    if (el.getAttributeNS(NS_STYLE, 'family') !== 'table-cell') continue;
    const name = el.getAttributeNS(NS_STYLE, 'name');
    if (!name) continue;
    const s: ODSCellStyle = {};
    const tprops = el.getElementsByTagNameNS(NS_STYLE, 'text-properties')[0];
    if (tprops) {
      if (tprops.getAttributeNS(NS_FO, 'font-weight') === 'bold') s.bold = true;
      if (tprops.getAttributeNS(NS_FO, 'font-style') === 'italic') s.italic = true;
      const us = tprops.getAttributeNS(NS_STYLE, 'text-underline-style');
      if (us && us !== 'none') s.underline = true;
      const col = tprops.getAttributeNS(NS_FO, 'color');
      if (col) s.color = col.toLowerCase();
      const ff = tprops.getAttributeNS(NS_FO, 'font-family');
      if (ff) s.fontFamily = ff;
      const fz = tprops.getAttributeNS(NS_FO, 'font-size');
      if (fz) s.fontSize = fz;
    }
    const cprops = el.getElementsByTagNameNS(NS_STYLE, 'table-cell-properties')[0];
    if (cprops) {
      const bg = cprops.getAttributeNS(NS_FO, 'background-color');
      if (bg && bg !== 'transparent') s.background = bg.toLowerCase();
      const bt = cprops.getAttributeNS(NS_FO, 'border-top');
      if (bt) s.borderTop = bt;
      const br = cprops.getAttributeNS(NS_FO, 'border-right');
      if (br) s.borderRight = br;
      const bb = cprops.getAttributeNS(NS_FO, 'border-bottom');
      if (bb) s.borderBottom = bb;
      const bl = cprops.getAttributeNS(NS_FO, 'border-left');
      if (bl) s.borderLeft = bl;
    }
    const pprops = el.getElementsByTagNameNS(NS_STYLE, 'paragraph-properties')[0];
    if (pprops) {
      const ta = pprops.getAttributeNS(NS_FO, 'text-align');
      if (ta === 'left' || ta === 'center' || ta === 'right' || ta === 'justify') {
        s.align = ta;
      } else if (ta === 'start') s.align = 'left';
      else if (ta === 'end') s.align = 'right';
    }
    const dataStyle = el.getAttributeNS(NS_STYLE, 'data-style-name');
    if (dataStyle) {
      dataStyleByCellStyle.set(name, dataStyle);
      if (numberFormats.has(dataStyle)) s.numberFormat = dataStyle;
    }
    if (Object.keys(s).length) out.set(name, s);
  }
  return { styles: out, numberFormats, dataStyleByCellStyle };
}

function serializeElement(el: Element): string {
  try {
    return new XMLSerializer().serializeToString(el);
  } catch {
    return el.outerHTML ?? '';
  }
}

function parseCellsInRow(row: Element, styles: Map<string, ODSCellStyle> = new Map()): ODSCell[] {
  const out: ODSCell[] = [];
  for (const child of Array.from(row.children)) {
    if (child.localName !== 'table-cell' && child.localName !== 'covered-table-cell') continue;
    const covered = child.localName === 'covered-table-cell';
    const repeat = Number(child.getAttributeNS(NS.table, 'number-columns-repeated') ?? '1');
    const colspan = Number(child.getAttributeNS(NS.table, 'number-columns-spanned') ?? '1');
    const rowspan = Number(child.getAttributeNS(NS.table, 'number-rows-spanned') ?? '1');
    const valueType = (child.getAttributeNS(NS.office, 'value-type') ?? 'string') as CellType;
    const formula = child.getAttributeNS(NS.table, 'formula') ?? undefined;
    // Pull the visible text out of <text:p> children honoring
    // <text:line-break/> (\n inside a paragraph) and joining
    // separate paragraphs with \n.
    const display = readCellText(child);
    let value: ODSCell['value'] = '';
    if (valueType === 'string') {
      value = display;
    } else if (valueType === 'boolean') {
      value = child.getAttributeNS(NS.office, 'boolean-value') === 'true';
    } else if (valueType === 'date' || valueType === 'time') {
      value = child.getAttributeNS(NS.office, 'date-value')
           ?? child.getAttributeNS(NS.office, 'time-value')
           ?? display;
    } else {
      // numeric / percentage / currency
      const v = child.getAttributeNS(NS.office, 'value');
      value = v != null ? Number(v) : 0;
    }
    const styleName = child.getAttributeNS(NS.table, 'style-name') ?? '';
    const style = styleName ? styles.get(styleName) : undefined;
    const cell: ODSCell = {
      display,
      value,
      type: valueType,
      formula,
      ...(covered ? { covered: true } : {}),
      ...(colspan > 1 ? { colspan } : {}),
      ...(rowspan > 1 ? { rowspan } : {}),
      ...(style ? { style: { ...style } } : {}),
    };
    if (repeat > 1) {
      // Collapse runs of empty cells into a single spacer so a
      // `number-columns-repeated="1024"` trailer doesn't blow up
      // memory. Non-empty cells still expand.
      if (isEmptyCell(cell) && !formula) {
        const spacer: ODSCell = { ...cell, repeat };
        out.push(spacer);
      } else {
        for (let i = 0; i < repeat; i++) out.push({
          ...cell,
          style: cell.style ? { ...cell.style } : undefined,
        });
      }
    } else {
      out.push(cell);
    }
  }
  return out;
}

function readCellText(cell: Element): string {
  // Join the <text:p> children with '\n', and convert
  // <text:line-break/> inside a paragraph to '\n'. If no <text:p>
  // children exist (some writers stuff bare text), fall back to
  // textContent verbatim.
  const paras = Array.from(cell.children).filter(c =>
    c.namespaceURI === NS.text && c.localName === 'p');
  if (paras.length === 0) return cell.textContent ?? '';
  const parts: string[] = [];
  for (const p of paras) parts.push(readParagraphText(p));
  return parts.join('\n');
}

function readParagraphText(p: Element): string {
  let out = '';
  for (const node of Array.from(p.childNodes)) {
    if (node.nodeType === 3 /* text */) {
      out += node.nodeValue ?? '';
    } else if (node.nodeType === 1 /* element */) {
      const el = node as Element;
      if (el.namespaceURI === NS.text && el.localName === 'line-break') {
        out += '\n';
      } else if (el.namespaceURI === NS.text && el.localName === 'tab') {
        out += '\t';
      } else if (el.namespaceURI === NS.text && el.localName === 's') {
        const cnt = Number(el.getAttributeNS(NS.text, 'c') ?? '1');
        out += ' '.repeat(cnt > 0 ? cnt : 1);
      } else {
        // Spans + other text containers : recurse so nested
        // line-breaks still surface as \n.
        out += readParagraphText(el);
      }
    }
  }
  return out;
}

const MANIFEST_TEMPLATE =
`<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="${NS.manifest}" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>
`;

const META_TEMPLATE = (now: string) => `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta
  xmlns:office="${NS.office}"
  xmlns:meta="${NS.meta}"
  xmlns:dc="${NS.dc}"
  office:version="1.2">
  <office:meta>
    <meta:generator>weft-loom-spreadsheet</meta:generator>
    <dc:date>${now}</dc:date>
  </office:meta>
</office:document-meta>
`;

function escapeXML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// styleFingerprint : stable string representation of an
// ODSCellStyle so identical styles map to the same `ce<N>` name.
function styleFingerprint(s: ODSCellStyle): string {
  const keys = Object.keys(s).sort() as Array<keyof ODSCellStyle>;
  return keys.map(k => k + '=' + String(s[k])).join('|');
}

function emitCellStyles(seen: Map<string, ODSCellStyle>, numberFormats: Map<string, string>): string {
  if (seen.size === 0 && numberFormats.size === 0) return '';
  let out = '<office:automatic-styles>';
  // Re-emit captured number-format blocks (date/currency/number/...)
  // once each. Their inner XML already carries the style:name so
  // table-cell styles can reference them via style:data-style-name.
  for (const raw of numberFormats.values()) out += raw;
  let idx = 0;
  for (const [, s] of seen) {
    idx++;
    out += '<style:style style:name="ce' + idx + '" style:family="table-cell"';
    if (s.numberFormat) {
      out += ' style:data-style-name="' + escapeXML(s.numberFormat) + '"';
    }
    out += '>';
    const tprops: string[] = [];
    if (s.bold)       tprops.push('fo:font-weight="bold"');
    if (s.italic)     tprops.push('fo:font-style="italic"');
    if (s.underline)  tprops.push('style:text-underline-style="solid"');
    if (s.color)      tprops.push('fo:color="' + escapeXML(s.color) + '"');
    if (s.fontFamily) tprops.push('fo:font-family="' + escapeXML(s.fontFamily) + '"');
    if (s.fontSize)   tprops.push('fo:font-size="' + escapeXML(s.fontSize) + '"');
    if (tprops.length) out += '<style:text-properties ' + tprops.join(' ') + '/>';
    const cprops: string[] = [];
    if (s.background)   cprops.push('fo:background-color="' + escapeXML(s.background) + '"');
    if (s.borderTop)    cprops.push('fo:border-top="' + escapeXML(s.borderTop) + '"');
    if (s.borderRight)  cprops.push('fo:border-right="' + escapeXML(s.borderRight) + '"');
    if (s.borderBottom) cprops.push('fo:border-bottom="' + escapeXML(s.borderBottom) + '"');
    if (s.borderLeft)   cprops.push('fo:border-left="' + escapeXML(s.borderLeft) + '"');
    if (cprops.length) out += '<style:table-cell-properties ' + cprops.join(' ') + '/>';
    const pprops: string[] = [];
    if (s.align) pprops.push('fo:text-align="' + s.align + '"');
    if (pprops.length) out += '<style:paragraph-properties ' + pprops.join(' ') + '/>';
    out += '</style:style>';
  }
  out += '</office:automatic-styles>';
  return out;
}

function emitCell(c: ODSCell, styleName: string | undefined): string {
  const tag = c.covered ? 'table:covered-table-cell' : 'table:table-cell';
  const attrs: string[] = [];
  // Spacer cells (empty + repeat>1) skip the typed value attrs and
  // emit a bare repeated cell.
  const isSpacer = c.repeat && c.repeat > 1 && isEmptyCell(c);
  if (!isSpacer) {
    attrs.push('office:value-type="' + escapeXML(c.type) + '"');
    if (c.type === 'string') {
      // No office:value attribute for strings — the <text:p> body
      // carries the value.
    } else if (c.type === 'boolean') {
      attrs.push('office:boolean-value="' + (c.value ? 'true' : 'false') + '"');
    } else if (c.type === 'date') {
      attrs.push('office:date-value="' + escapeXML(String(c.value)) + '"');
    } else if (c.type === 'time') {
      attrs.push('office:time-value="' + escapeXML(String(c.value)) + '"');
    } else {
      attrs.push('office:value="' + escapeXML(String(c.value)) + '"');
    }
  }
  if (c.formula) attrs.push('table:formula="' + escapeXML(c.formula) + '"');
  if (c.repeat && c.repeat > 1) attrs.push('table:number-columns-repeated="' + c.repeat + '"');
  if (c.colspan && c.colspan > 1) attrs.push('table:number-columns-spanned="' + c.colspan + '"');
  if (c.rowspan && c.rowspan > 1) attrs.push('table:number-rows-spanned="' + c.rowspan + '"');
  if (styleName) attrs.push('table:style-name="' + styleName + '"');
  const body = isSpacer ? '' : emitCellBody(c.display);
  if (!body) return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '/>';
  return '<' + tag + ' ' + attrs.join(' ') + '>' + body + '</' + tag + '>';
}

function emitCellBody(display: string): string {
  if (!display) return '';
  // Multi-paragraph : split on '\n' and emit one <text:p> per chunk.
  if (display.includes('\n')) {
    return display.split('\n').map(p => '<text:p>' + escapeXML(p) + '</text:p>').join('');
  }
  return '<text:p>' + escapeXML(display) + '</text:p>';
}

function emitContent(sheets: ODSSheet[]): string {
  // T9 V0.4 : collect every unique cell style across all sheets so
  // they share `ce<N>` names. Also collect the data-style-names
  // referenced by those cell styles so we can re-emit the captured
  // number-format blocks once each.
  const styleMap = new Map<string, ODSCellStyle>(); // fingerprint → style
  const fingerprintToIndex = new Map<string, number>(); // fingerprint → ce index (1-based)
  const referencedFormats = new Map<string, string>(); // data-style-name → raw XML
  for (const sh of sheets) {
    for (const row of sh.cells) {
      for (const cell of row) {
        if (!cell.style) continue;
        const fp = styleFingerprint(cell.style);
        if (!styleMap.has(fp)) {
          styleMap.set(fp, cell.style);
          fingerprintToIndex.set(fp, styleMap.size);
        }
        const nf = cell.style.numberFormat;
        if (nf && !referencedFormats.has(nf)) {
          const raw = lastParsedNumberFormats.get(nf);
          if (raw) referencedFormats.set(nf, raw);
        }
      }
    }
  }
  const stylesXML = emitCellStyles(styleMap, referencedFormats);

  let body = '';
  for (const sh of sheets) {
    let rowXML = '';
    const maxCols = sh.cells.reduce((m, r) => Math.max(m, rowWidth(r)), 0);
    for (const row of sh.cells) {
      let cells = '';
      let used = 0;
      for (const c of row) {
        const sn = c.style
          ? 'ce' + fingerprintToIndex.get(styleFingerprint(c.style))
          : undefined;
        cells += emitCell(c, sn);
        used += (c.repeat && c.repeat > 1) ? c.repeat : 1;
      }
      // Pad trailing empties with a single repeated cell — never K
      // separate <table:table-cell/> elements (that's what caused
      // the 256-phantom-cell explosion).
      const pad = maxCols - used;
      if (pad === 1) {
        cells += '<table:table-cell/>';
      } else if (pad > 1) {
        cells += '<table:table-cell table:number-columns-repeated="' + pad + '"/>';
      }
      // Restore the original number-rows-repeated annotation when set
      // on the first cell of an empty-row group.
      const rr = row[0]?.rowRepeat;
      const rowAttr = rr && rr > 1 ? ' table:number-rows-repeated="' + rr + '"' : '';
      rowXML += '<table:table-row' + rowAttr + '>' + cells + '</table:table-row>';
    }
    body += '<table:table table:name="' + escapeXML(sh.name) + '">'
         + (maxCols > 0 ? '<table:table-column table:number-columns-repeated="' + maxCols + '"/>' : '')
         + rowXML
         + '</table:table>';
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="${NS.office}"
  xmlns:table="${NS.table}"
  xmlns:text="${NS.text}"
  xmlns:style="${NS_STYLE}"
  xmlns:fo="${NS_FO}"
  xmlns:number="${NS_NUMBER}"
  office:version="1.2">
  ${stylesXML}
  <office:body>
    <office:spreadsheet>
      ${body}
    </office:spreadsheet>
  </office:body>
</office:document-content>
`;
}

function rowWidth(row: ODSCell[]): number {
  let n = 0;
  for (const c of row) n += (c.repeat && c.repeat > 1) ? c.repeat : 1;
  return n;
}

export async function writeODS(sheets: ODSSheet[], now: string = new Date().toISOString()): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.folder('META-INF')!.file('manifest.xml', MANIFEST_TEMPLATE);
  zip.file('meta.xml', META_TEMPLATE(now));
  zip.file('content.xml', emitContent(sheets));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// blankSheet : convenience for the toolbar's "New sheet" button.
export function blankSheet(name: string, rows = 20, cols = 10): ODSSheet {
  const cells: ODSCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: ODSCell[] = [];
    for (let c = 0; c < cols; c++) row.push({ display: '', value: '', type: 'string' });
    cells.push(row);
  }
  return { name, cells };
}

// columnLabel : "A", "B", ..., "Z", "AA", "AB", ... for the header row.
export function columnLabel(n: number): string {
  let s = '';
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}
