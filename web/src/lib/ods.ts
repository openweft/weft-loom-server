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
      const baseRow = parseCellsInRow(row);
      for (let i = 0; i < safeRowRepeat; i++) {
        cells.push(baseRow.map(c => ({ ...c })));
      }
    }
    sheets.push({ name, cells });
  }
  return sheets;
}

function parseCellsInRow(row: Element): ODSCell[] {
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
    const cell: ODSCell = {
      display,
      value,
      type: valueType,
      formula,
      ...(colspan > 1 ? { colspan } : {}),
      ...(rowspan > 1 ? { rowspan } : {}),
    };
    for (let i = 0; i < repeat; i++) out.push({ ...cell });
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

function emitCell(c: ODSCell): string {
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
  const body = c.display ? '<text:p>' + escapeXML(c.display) + '</text:p>' : '';
  return '<table:table-cell ' + attrs.join(' ') + '>' + body + '</table:table-cell>';
}

function emitContent(sheets: ODSSheet[]): string {
  let body = '';
  for (const sh of sheets) {
    let rowXML = '';
    // Pre-compute the max column count so each row carries a stable
    // shape ; LibreOffice tolerates ragged rows but Excel doesn't.
    const maxCols = sh.cells.reduce((m, r) => Math.max(m, r.length), 0);
    for (const row of sh.cells) {
      let cells = '';
      for (const c of row) cells += emitCell(c);
      // Pad with empty cells to maxCols.
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
  office:version="1.2">
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
