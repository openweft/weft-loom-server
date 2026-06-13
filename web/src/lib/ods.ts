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

const EMPTY_CELL: ODSCell = { display: '', value: '', type: 'string' };

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

function parseSheets(xml: string): ODSSheet[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // T9 V0.4 : pre-scan <style:style style:family="table-cell"> so
  // table:style-name references resolve to ODSCellStyle on the
  // way out of parseCellsInRow.
  const styles = parseCellStyles(doc);
  const tables = doc.getElementsByTagNameNS(NS.table, 'table');
  const sheets: ODSSheet[] = [];
  for (const table of Array.from(tables)) {
    const name = table.getAttributeNS(NS.table, 'name') ?? 'Sheet';
    const rows = table.getElementsByTagNameNS(NS.table, 'table-row');
    const cells: ODSCell[][] = [];
    for (const row of Array.from(rows)) {
      const rowRepeat = Number(row.getAttributeNS(NS.table, 'number-rows-repeated') ?? '1');
      // Skip blank rows at the end (some writers emit big rowRepeat
      // counts on trailing empties — capped at 100 in V0.1).
      const safeRowRepeat = Math.min(rowRepeat, 100);
      const baseRow = parseCellsInRow(row, styles);
      for (let i = 0; i < safeRowRepeat; i++) {
        cells.push(baseRow.map(c => ({ ...c })));
      }
    }
    sheets.push({ name, cells });
  }
  return sheets;
}

const NS_STYLE = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const NS_FO    = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';

function parseCellStyles(doc: Document): Map<string, ODSCellStyle> {
  const out = new Map<string, ODSCellStyle>();
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
    if (Object.keys(s).length) out.set(name, s);
  }
  return out;
}

function parseCellsInRow(row: Element, styles: Map<string, ODSCellStyle> = new Map()): ODSCell[] {
  const out: ODSCell[] = [];
  for (const child of Array.from(row.children)) {
    if (child.localName !== 'table-cell' && child.localName !== 'covered-table-cell') continue;
    const repeat = Math.min(Number(child.getAttributeNS(NS.table, 'number-columns-repeated') ?? '1'), 256);
    const colspan = Number(child.getAttributeNS(NS.table, 'number-columns-spanned') ?? '1');
    const rowspan = Number(child.getAttributeNS(NS.table, 'number-rows-spanned') ?? '1');
    const valueType = (child.getAttributeNS(NS.office, 'value-type') ?? 'string') as CellType;
    const formula = child.getAttributeNS(NS.table, 'formula') ?? undefined;
    let value: ODSCell['value'] = '';
    if (valueType === 'string') {
      value = child.textContent ?? '';
    } else if (valueType === 'boolean') {
      value = child.getAttributeNS(NS.office, 'boolean-value') === 'true';
    } else if (valueType === 'date' || valueType === 'time') {
      value = child.getAttributeNS(NS.office, 'date-value')
           ?? child.getAttributeNS(NS.office, 'time-value')
           ?? child.textContent ?? '';
    } else {
      // numeric / percentage / currency
      const v = child.getAttributeNS(NS.office, 'value');
      value = v != null ? Number(v) : 0;
    }
    const display = (child.textContent ?? '').trim();
    const styleName = child.getAttributeNS(NS.table, 'style-name') ?? '';
    const style = styleName ? styles.get(styleName) : undefined;
    const cell: ODSCell = {
      display,
      value,
      type: valueType,
      formula,
      ...(colspan > 1 ? { colspan } : {}),
      ...(rowspan > 1 ? { rowspan } : {}),
      ...(style ? { style: { ...style } } : {}),
    };
    for (let i = 0; i < repeat; i++) out.push({
      ...cell,
      style: cell.style ? { ...cell.style } : undefined,
    });
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

function emitCellStyles(seen: Map<string, ODSCellStyle>): string {
  if (seen.size === 0) return '';
  let out = '<office:automatic-styles>';
  let idx = 0;
  for (const [, s] of seen) {
    idx++;
    out += '<style:style style:name="ce' + idx + '" style:family="table-cell">';
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
  const attrs: string[] = [];
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
  if (c.formula) attrs.push('table:formula="' + escapeXML(c.formula) + '"');
  if (c.colspan && c.colspan > 1) attrs.push('table:number-columns-spanned="' + c.colspan + '"');
  if (c.rowspan && c.rowspan > 1) attrs.push('table:number-rows-spanned="' + c.rowspan + '"');
  if (styleName) attrs.push('table:style-name="' + styleName + '"');
  const body = c.display ? '<text:p>' + escapeXML(c.display) + '</text:p>' : '';
  return '<table:table-cell ' + attrs.join(' ') + '>' + body + '</table:table-cell>';
}

function emitContent(sheets: ODSSheet[]): string {
  // T9 V0.4 : collect every unique cell style across all sheets so
  // they share `ce<N>` names.
  const styleMap = new Map<string, ODSCellStyle>(); // fingerprint → style
  const fingerprintToIndex = new Map<string, number>(); // fingerprint → ce index (1-based)
  for (const sh of sheets) {
    for (const row of sh.cells) {
      for (const cell of row) {
        if (!cell.style) continue;
        const fp = styleFingerprint(cell.style);
        if (!styleMap.has(fp)) {
          styleMap.set(fp, cell.style);
          fingerprintToIndex.set(fp, styleMap.size);
        }
      }
    }
  }
  const stylesXML = emitCellStyles(styleMap);

  let body = '';
  for (const sh of sheets) {
    let rowXML = '';
    const maxCols = sh.cells.reduce((m, r) => Math.max(m, r.length), 0);
    for (const row of sh.cells) {
      let cells = '';
      for (const c of row) {
        const sn = c.style
          ? 'ce' + fingerprintToIndex.get(styleFingerprint(c.style))
          : undefined;
        cells += emitCell(c, sn);
      }
      for (let i = row.length; i < maxCols; i++) {
        cells += '<table:table-cell/>';
      }
      rowXML += '<table:table-row>' + cells + '</table:table-row>';
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
