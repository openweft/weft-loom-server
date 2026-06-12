// notebook.ts — typed parser + serialiser for Jupyter `.ipynb` files.
//
// Spec : nbformat v4 — https://nbformat.readthedocs.io/en/latest/
// We support the subset weft-loom needs : markdown + code cells with
// stored outputs (text/plain, text/html, image/png, application/json).
// Raw cells round-trip but render as a plain `<pre>`.
//
// Source fields are stored as either a string OR a string[] in
// nbformat ; we normalise to string on parse and split-on-newline on
// serialise so diffs against on-disk notebooks stay clean.

export type CellType = 'markdown' | 'code' | 'raw';

export interface OutputStream {
  output_type: 'stream';
  name: 'stdout' | 'stderr';
  text: string;
}

export interface OutputData {
  output_type: 'display_data' | 'execute_result';
  data: Record<string, string | unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number;
}

export interface OutputError {
  output_type: 'error';
  ename: string;
  evalue: string;
  traceback: string[];
}

export type Output = OutputStream | OutputData | OutputError;

export interface Cell {
  cell_type: CellType;
  source: string;
  metadata?: Record<string, unknown>;
  outputs?: Output[];
  execution_count?: number | null;
}

export interface Notebook {
  cells: Cell[];
  metadata: {
    kernelspec?: {
      name: string;
      display_name: string;
      language: string;
    };
    language_info?: {
      name: string;
      version?: string;
    };
    [k: string]: unknown;
  };
  nbformat: number;
  nbformat_minor: number;
}

function joinSource(s: string | string[] | undefined): string {
  if (s === undefined) return '';
  return Array.isArray(s) ? s.join('') : s;
}

function joinOutputData(d: Record<string, string | string[] | unknown>): Record<string, string | unknown> {
  const out: Record<string, string | unknown> = {};
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = (v as string[]).join('');
    else out[k] = v;
  }
  return out;
}

export function parseNotebook(raw: string): Notebook {
  const j = JSON.parse(raw);
  const cells: Cell[] = (j.cells ?? []).map((c: Record<string, unknown>) => ({
    cell_type: (c.cell_type as CellType) ?? 'raw',
    source: joinSource(c.source as string | string[] | undefined),
    metadata: (c.metadata as Record<string, unknown>) ?? {},
    outputs: ((c.outputs as Output[]) ?? []).map((o) => {
      if (o.output_type === 'stream') {
        return { ...o, text: joinSource((o as unknown as { text: string | string[] }).text) };
      }
      if (o.output_type === 'display_data' || o.output_type === 'execute_result') {
        return { ...o, data: joinOutputData((o.data ?? {}) as Record<string, unknown>) };
      }
      return o;
    }),
    execution_count: (c.execution_count as number | null) ?? null,
  }));
  return {
    cells,
    metadata: j.metadata ?? {},
    nbformat: j.nbformat ?? 4,
    nbformat_minor: j.nbformat_minor ?? 5,
  };
}

export function serialiseNotebook(nb: Notebook): string {
  // Split source on \n so the on-disk shape matches what `jupyter`
  // produces ; that keeps git diffs minimal.
  const splitN = (s: string): string[] => {
    const lines = s.split('\n');
    return lines.map((line, i) => (i === lines.length - 1 ? line : line + '\n')).filter((l) => l.length > 0);
  };
  const out = {
    cells: nb.cells.map((c) => ({
      cell_type: c.cell_type,
      source: splitN(c.source),
      metadata: c.metadata ?? {},
      ...(c.cell_type === 'code'
        ? {
            outputs: c.outputs ?? [],
            execution_count: c.execution_count ?? null,
          }
        : {}),
    })),
    metadata: nb.metadata,
    nbformat: nb.nbformat,
    nbformat_minor: nb.nbformat_minor,
  };
  return JSON.stringify(out, null, 1);
}

// Detect notebook language from the kernelspec / language_info ; falls
// back to "python" since that's what 99 % of public notebooks ship.
export function notebookLanguage(nb: Notebook): string {
  return (
    nb.metadata.language_info?.name ??
    nb.metadata.kernelspec?.language ??
    'python'
  );
}
