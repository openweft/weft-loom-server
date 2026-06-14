<script lang="ts">
  // SpreadsheetEditor — T9 V0.1 MVP : Word-style ribbon + grid that
  // reads + writes .ods files via the pure-browser parseODS/writeODS
  // (JSZip + DOMParser). One sheet at a time, no formulas yet ;
  // V0.2 adds HyperFormula + Y.Map collab + multi-sheet tabs.
  //
  // The grid is a plain <table> with contenteditable cells. The
  // user clicks a cell, types, tabs to move right, shift-tab to
  // move left, enter to move down. Saved on every change via the
  // existing debounced writer.

  import { parseODS, writeODS, columnLabel, blankSheet, type ODSSheet, type ODSCell } from '../ods';
  import { writeFile } from '../api';
  import { HyperFormula, type ExportedChange, ExportedCellChange } from 'hyperformula';
  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import { onDestroy, onMount } from 'svelte';

  interface Props {
    project: string;
    file: string;
  }
  let { project, file }: Props = $props();

  let sheets = $state<ODSSheet[]>([]);
  let activeSheet = $state(0);
  let status = $state<'loading' | 'ready' | 'saving' | 'error'>('loading');
  let errorMessage = $state('');
  let dirty = $state(false);
  let savedAt = $state<number | null>(null);
  let nowTick = $state(Date.now());
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  // Currently-selected cell. The grid renders an outline around it
  // + the formula bar shows + edits its value.
  let selRow = $state(0);
  let selCol = $state(0);
  let formulaBarValue = $state('');
  // Range selection : when the user clicks a row/column header
  // OR drags across cells, every cell in the rectangle gets
  // highlighted + becomes the target for formatting operations.
  // Single-cell selection = the rectangle (selRow..selRow, selCol..selCol).
  let rangeFromRow = $state(0);
  let rangeFromCol = $state(0);
  let rangeToRow   = $state(0);
  let rangeToCol   = $state(0);
  let rangeKind: 'cell' | 'row' | 'col' | 'all' = $state('cell');

  function inSelectionRange(r: number, c: number): boolean {
    const r1 = Math.min(rangeFromRow, rangeToRow);
    const r2 = Math.max(rangeFromRow, rangeToRow);
    const c1 = Math.min(rangeFromCol, rangeToCol);
    const c2 = Math.max(rangeFromCol, rangeToCol);
    return r >= r1 && r <= r2 && c >= c1 && c <= c2;
  }

  function selectRange(fromRow: number, fromCol: number, toRow: number, toCol: number, kind: 'cell' | 'row' | 'col' | 'all') {
    rangeFromRow = fromRow;
    rangeFromCol = fromCol;
    rangeToRow = toRow;
    rangeToCol = toCol;
    rangeKind = kind;
    selRow = fromRow;
    selCol = fromCol;
    const cell = sheets[activeSheet]?.cells[selRow]?.[selCol];
    formulaBarValue = cell?.formula
      ? (typeof cell.value === 'string' ? cell.value : String(cell.value))
      : (cell?.display ?? '');
  }

  function selectWholeColumn(c: number) {
    selectRange(0, c, MAX_ROWS - 1, c, 'col');
  }
  function selectWholeRow(r: number) {
    selectRange(r, 0, r, MAX_COLS - 1, 'row');
  }
  function selectWholeSheet() {
    selectRange(0, 0, MAX_ROWS - 1, MAX_COLS - 1, 'all');
  }

  // T9 V0.4 : apply a style mutation to every cell in the current
  // range. The mutator receives a draft ODSCellStyle and returns
  // the new one (or undefined to clear styling). For row / col /
  // all selections we clamp the row/col bounds to what's currently
  // dense so we don't materialise 1M rows × 16K cols of style.
  function applyStyleToRange(mutator: (cur: import('../ods').ODSCellStyle) => import('../ods').ODSCellStyle | undefined) {
    const sh = sheets[activeSheet];
    if (!sh) return;
    const r1 = Math.min(rangeFromRow, rangeToRow);
    const r2 = rangeKind === 'cell' ? r1 : Math.max(rangeFromRow, rangeToRow);
    const c1 = Math.min(rangeFromCol, rangeToCol);
    const c2 = rangeKind === 'cell' ? c1 : Math.max(rangeFromCol, rangeToCol);
    // Clamp to dense storage for row/col/all so we don't churn
    // millions of empty cells. The dense matrix already covers the
    // populated area ; styled-empty cells outside it are a V0.5
    // concern.
    const maxRow = Math.min(r2, sh.cells.length - 1);
    const maxCol = Math.min(c2, sh.cells.reduce((m, r) => Math.max(m, r.length), 0) - 1);
    for (let r = r1; r <= maxRow; r++) {
      const row = sh.cells[r];
      if (!row) continue;
      for (let c = c1; c <= maxCol; c++) {
        const cell = row[c];
        if (!cell) continue;
        const next = mutator(cell.style ? { ...cell.style } : {});
        if (next && Object.keys(next).length > 0) cell.style = next;
        else delete cell.style;
      }
    }
    sheets = sheets;
    markDirty();
  }
  function toggleBold()      { applyStyleToRange(s => { s.bold = !s.bold; return s; }); }
  function toggleItalic()    { applyStyleToRange(s => { s.italic = !s.italic; return s; }); }
  function toggleUnderline() { applyStyleToRange(s => { s.underline = !s.underline; return s; }); }
  function setAlign(a: 'left' | 'center' | 'right' | 'justify') {
    applyStyleToRange(s => { s.align = a; return s; });
  }
  function setTextColor(hex: string)  { applyStyleToRange(s => { s.color = hex; return s; }); }
  function setBackground(hex: string) { applyStyleToRange(s => { s.background = hex; return s; }); }
  function setFontFamily(name: string) {
    applyStyleToRange(s => { s.fontFamily = name; return s; });
  }
  function setFontSize(size: string) {
    applyStyleToRange(s => { s.fontSize = size; return s; });
  }
  function setAllBorders(hex: string) {
    const v = '1pt solid ' + hex;
    applyStyleToRange(s => {
      s.borderTop = v; s.borderRight = v; s.borderBottom = v; s.borderLeft = v;
      return s;
    });
  }
  function clearFormatting() {
    applyStyleToRange(() => undefined);
  }
  // Reflect the anchor cell's style so the ribbon toggles can
  // announce their pressed state to assistive tech.
  const anchorStyle = $derived(sheets[activeSheet]?.cells[selRow]?.[selCol]?.style);
  const isBold      = $derived(!!anchorStyle?.bold);
  const isItalic    = $derived(!!anchorStyle?.italic);
  const isUnderline = $derived(!!anchorStyle?.underline);

  // cellInlineStyle : translate ODSCellStyle → CSS declarations the
  // virtualized cell div can carry inline. Kept narrow : the
  // declarations don't conflict with the position/size already on
  // the same `style` attribute.
  function cellInlineStyle(c: import('../ods').ODSCell): string {
    const s = c.style;
    if (!s) return '';
    const parts: string[] = [];
    if (s.bold)      parts.push('font-weight: bold');
    if (s.italic)    parts.push('font-style: italic');
    if (s.underline) parts.push('text-decoration: underline');
    if (s.color)     parts.push('color: ' + s.color);
    if (s.background) parts.push('background-color: ' + s.background);
    if (s.align)     parts.push('text-align: ' + s.align);
    if (s.fontFamily) parts.push('font-family: ' + s.fontFamily);
    if (s.fontSize)  parts.push('font-size: ' + s.fontSize);
    // Borders : ODF border syntax is "1pt solid #rrggbb" — we pass
    // it through verbatim since CSS accepts the same shape.
    if (s.borderTop)    parts.push('border-top: ' + s.borderTop);
    if (s.borderRight)  parts.push('border-right: ' + s.borderRight);
    if (s.borderBottom) parts.push('border-bottom: ' + s.borderBottom);
    if (s.borderLeft)   parts.push('border-left: ' + s.borderLeft);
    return parts.join('; ');
  }
  // T9 V0.2 : HyperFormula engine. One instance for the whole
  // workbook ; sheets are added/removed as the user toggles them.
  // `displayCache` mirrors HF's computed values so the grid can
  // render "=A1+B1" cells as their numeric result without calling
  // HF on every render.
  let hf: HyperFormula | undefined;
  let displayCache = $state<Map<string, string>>(new Map());

  // T9 virtualization : Excel-like virtually infinite grid. Only
  // cells inside the visible viewport are rendered as DOM nodes ;
  // the rest is virtual scrollable space. MAX_ROWS / MAX_COLS
  // match Excel's 2016+ limits so the user effectively never hits
  // an edge.
  const MAX_ROWS = 1_048_576;
  const MAX_COLS = 16_384;
  const ROW_H = 24;   // px per row
  const COL_W = 96;   // px per column
  const HEADER_H = 22;
  const HEADER_W = 48;
  // Buffer one viewport's worth of cells off-screen so smooth scrolling
  // doesn't reveal blank cells before the new render lands.
  const BUFFER = 4;

  let scrollEl: HTMLDivElement;
  let viewportW = $state(800);
  let viewportH = $state(400);
  let scrollTop = $state(0);
  let scrollLeft = $state(0);

  function onGridScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement;
    scrollTop = el.scrollTop;
    scrollLeft = el.scrollLeft;
  }
  // ResizeObserver tracks the scroll container's clientWidth /
  // clientHeight so the visible-window math reacts to splitter
  // drags + window resizes. ResizeObserver is supported in every
  // browser loom targets ; no polyfill needed.
  let resizeObs: ResizeObserver | undefined;
  // Track the scrollEl identity the observer is currently bound to. The
  // $effect re-runs whenever any tracked state read inside it changes ;
  // if scrollEl identity is unchanged we keep the existing observer
  // instead of churning a disconnect + new ResizeObserver per re-run.
  let observedScrollEl: HTMLDivElement | undefined;
  $effect(() => {
    if (!scrollEl) return;
    viewportW = scrollEl.clientWidth;
    viewportH = scrollEl.clientHeight;
    if (resizeObs && observedScrollEl === scrollEl) {
      // Same scroll element : keep the existing observer. The final
      // disconnect happens in onDestroy.
      return;
    }
    resizeObs?.disconnect();
    observedScrollEl = scrollEl;
    resizeObs = new ResizeObserver(() => {
      viewportW = scrollEl.clientWidth;
      viewportH = scrollEl.clientHeight;
    });
    resizeObs.observe(scrollEl);
  });

  // Visible window in cell coordinates ; clamped to MAX_*.
  const firstVisRow = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER));
  const lastVisRow  = $derived(Math.min(MAX_ROWS - 1, Math.ceil((scrollTop + viewportH) / ROW_H) + BUFFER));
  const firstVisCol = $derived(Math.max(0, Math.floor(scrollLeft / COL_W) - BUFFER));
  const lastVisCol  = $derived(Math.min(MAX_COLS - 1, Math.ceil((scrollLeft + viewportW) / COL_W) + BUFFER));
  const visRows = $derived(Array.from({ length: lastVisRow - firstVisRow + 1 }, (_, i) => firstVisRow + i));
  const visCols = $derived(Array.from({ length: lastVisCol - firstVisCol + 1 }, (_, i) => firstVisCol + i));
  // T9 V0.3 : Y.Doc + provider for live multi-user collab. The
  // cells live in a Y.Map keyed by "<sheetIdx>:<row>:<col>" so
  // updates are atomic per-cell ; concurrent edits to different
  // cells don't collide. We use the same WS sync endpoint as the
  // text editors (`/api/projects/<p>/sync`) — the relay doesn't
  // care about payload semantics, just the doc id.
  let ydoc: Y.Doc | undefined;
  let provider: WebsocketProvider | undefined;
  let cellsMap: Y.Map<{
    display: string;
    value: string | number | boolean;
    type: string;
    formula?: string;
  }> | undefined;
  // Sheet-shape Y.Array : one entry per sheet describing its name +
  // dense row/col counts. Peers observe this to add/remove/resize
  // sheets in lockstep ; cell content keeps flowing through cellsMap.
  type SheetShape = { name: string; rows: number; cols: number };
  let shapeArr: Y.Array<SheetShape> | undefined;
  // `applyingRemote` guards against the observer triggering its own
  // local change handler when we mutate the local sheets[] in
  // response to a remote update.
  let applyingRemote = false;
  // Cells received before their sheet exists locally (sheet-shape
  // event hasn't landed yet). Replayed once the sheet materialises.
  const pendingCells = new Map<string, {
    display: string;
    value: string | number | boolean;
    type: string;
    formula?: string;
  } | undefined>();

  function wsURL(p: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + window.location.host + '/api/projects/' + encodeURIComponent(p) + '/sync';
  }

  function cellKey(sheetIdx: number, r: number, c: number): string {
    return sheetIdx + ':' + r + ':' + c;
  }

  function pushCellToYMap(sheetIdx: number, r: number, c: number) {
    if (!ydoc || !cellsMap) return;
    const cell = sheets[sheetIdx]?.cells[r]?.[c];
    if (!cell) return;
    ydoc.transact(() => {
      cellsMap!.set(cellKey(sheetIdx, r, c), {
        display: cell.display,
        value: cell.value,
        type: cell.type,
        formula: cell.formula,
      });
    }, 'ods-cell');
  }

  function applyRemoteCell(key: string, value: {
    display: string;
    value: string | number | boolean;
    type: string;
    formula?: string;
  } | undefined) {
    const parts = key.split(':');
    if (parts.length !== 3) return;
    const [si, r, c] = parts.map(Number);
    if (Number.isNaN(si) || Number.isNaN(r) || Number.isNaN(c)) return;
    if (!sheets[si]) {
      // Sheet hasn't materialised locally yet — buffer + replay
      // once the shape observer adds the missing sheet.
      pendingCells.set(key, value);
      return;
    }
    ensureCell(si, r, c);
    if (value === undefined) {
      // Remote delete — clear the cell locally.
      const cell = sheets[si].cells[r][c];
      cell.display = '';
      cell.value = '';
      cell.type = 'string';
      delete cell.formula;
    } else {
      const cell = sheets[si].cells[r][c];
      cell.display = value.display;
      cell.value = value.value;
      cell.type = value.type as ODSCell['type'];
      if (value.formula) cell.formula = value.formula;
      else delete cell.formula;
    }
    sheets = sheets; // trigger reactivity
    if (hf) {
      try {
        const cell = sheets[si].cells[r][c];
        const hfValue = cellToHF(cell);
        const changes = hf.setCellContents({ sheet: si, row: r, col: c }, [[hfValue]]);
        updateDisplayCache(changes);
      } catch { /* ignore */ }
    }
  }

  // replayRemoteCells : batched apply of the initial Y.Map snapshot.
  // Avoids the per-cell `sheets = sheets` reactivity churn + per-cell
  // updateDisplayCache that applyRemoteCell would trigger for each entry ;
  // does one HF batch + one reactivity trigger + one full-cache seed at
  // the end. Mirrors M3 of the perf audit (no nested transacts on seed).
  function replayRemoteCells(map: NonNullable<typeof cellsMap>) {
    let touched = false;
    const apply = (key: string, value: {
      display: string;
      value: string | number | boolean;
      type: string;
      formula?: string;
    } | undefined) => {
      const parts = key.split(':');
      if (parts.length !== 3) return;
      const [si, r, c] = parts.map(Number);
      if (Number.isNaN(si) || Number.isNaN(r) || Number.isNaN(c)) return;
      if (!sheets[si]) {
        pendingCells.set(key, value);
        return;
      }
      ensureCell(si, r, c);
      const cell = sheets[si].cells[r][c];
      if (value === undefined) {
        cell.display = '';
        cell.value = '';
        cell.type = 'string';
        delete cell.formula;
      } else {
        cell.display = value.display;
        cell.value = value.value;
        cell.type = value.type as ODSCell['type'];
        if (value.formula) cell.formula = value.formula;
        else delete cell.formula;
      }
      if (hf) {
        try {
          hf.setCellContents({ sheet: si, row: r, col: c }, [[cellToHF(cell)]]);
        } catch { /* ignore */ }
      }
      touched = true;
    };
    if (hf) {
      // HF batch() coalesces dependent recomputation into a single pass.
      try {
        hf.batch(() => {
          for (const [k, v] of map.entries()) apply(k, v);
        });
      } catch {
        for (const [k, v] of map.entries()) apply(k, v);
      }
    } else {
      for (const [k, v] of map.entries()) apply(k, v);
    }
    if (touched) {
      sheets = sheets; // single reactivity trigger after the full replay
      // Seed (not incremental update) once at the end : we touched many
      // cells and don't have a consolidated ExportedChange[] from HF.
      seedDisplayCache();
    }
  }

  function pushShape() {
    if (!ydoc || !shapeArr) return;
    ydoc.transact(() => {
      shapeArr!.delete(0, shapeArr!.length);
      shapeArr!.push(sheets.map((sh) => ({
        name: sh.name,
        rows: sh.cells.length,
        cols: sh.cells[0]?.length ?? 0,
      })));
    }, 'ods-shape');
  }

  function applyShape(shapes: SheetShape[]) {
    // Add or grow sheets to match the peer's shape ; preserve any
    // cell content already in place. We do not shrink (rows/cols
    // removal is a V0.5 concern) so concurrent inserts don't drop
    // data.
    let mutated = false;
    for (let i = 0; i < shapes.length; i++) {
      const want = shapes[i];
      if (!sheets[i]) {
        sheets[i] = blankSheet(want.name);
        mutated = true;
      } else if (sheets[i].name !== want.name) {
        sheets[i].name = want.name;
        mutated = true;
      }
      const sh = sheets[i];
      while (sh.cells.length < want.rows) {
        const cols = sh.cells[0]?.length ?? want.cols;
        const row: ODSCell[] = [];
        for (let k = 0; k < cols; k++) row.push({ display: '', value: '', type: 'string' });
        sh.cells.push(row);
        mutated = true;
      }
      const targetCols = Math.max(want.cols, sh.cells[0]?.length ?? 0);
      for (const row of sh.cells) {
        while (row.length < targetCols) {
          row.push({ display: '', value: '', type: 'string' });
          mutated = true;
        }
      }
    }
    if (mutated) sheets = sheets;
    // Replay buffered cells whose sheets just materialised.
    if (pendingCells.size > 0) {
      const replayKeys: string[] = [];
      for (const k of pendingCells.keys()) {
        const si = Number(k.split(':')[0]);
        if (!Number.isNaN(si) && sheets[si]) replayKeys.push(k);
      }
      for (const k of replayKeys) {
        const v = pendingCells.get(k);
        pendingCells.delete(k);
        applyRemoteCell(k, v);
      }
    }
  }

  // Designated-seeder protocol mirrored from Editor.svelte. Three
  // outcomes : 'won' (this peer should seed), 'lost' (server explicitly
  // refused — another peer is seeding, do NOT fall back), 'unknown'
  // (endpoint missing in dev — caller may fall back to clientID race).
  type SeedClaim = 'won' | 'lost' | 'unknown';
  async function claimSeed(): Promise<SeedClaim> {
    if (!file) return 'unknown';
    try {
      const url = '/api/projects/' + encodeURIComponent(project)
        + '/seed-claim/cells:' + file.split('/').map(encodeURIComponent).join('/');
      const resp = await fetch(url, { method: 'POST' });
      if (resp.status === 409) {
        await new Promise((r) => setTimeout(r, 3000));
        return 'lost';
      }
      if (resp.ok) return 'won';
      if (resp.status === 404 || resp.status === 501) return 'unknown';
      return 'lost';
    } catch {
      // Network failure or endpoint absent — treat as "no signal" and
      // let the caller decide. Crucially we do NOT return 'lost' here :
      // a missing endpoint in dev shouldn't deadlock the seed.
      return 'unknown';
    }
  }

  function isLowestClientID(): boolean {
    if (!provider) return false;
    const states = provider.awareness.getStates();
    const ids = Array.from(states.keys());
    if (ids.length === 0) return true;
    const self = provider.awareness.clientID;
    return ids.every((id) => self <= id);
  }

  function attachProvider() {
    if (!file) return;
    if (provider) return;
    ydoc = new Y.Doc();
    provider = new WebsocketProvider(wsURL(project), 'ods:' + file, ydoc);
    cellsMap = ydoc.getMap('cells');
    shapeArr = ydoc.getArray<SheetShape>('sheet-shape');
    // Seed the Y.Map + sheet-shape with our locally-loaded data the
    // first time the provider syncs ; if another peer already
    // populated either structure, their state wins.
    provider.once('sync', () => {
      if (!cellsMap || !ydoc || !shapeArr) return;
      // Pull any existing shape into local state before deciding to
      // seed cells — shape might be non-empty even if cells are
      // (peer mid-seed).
      if (shapeArr.length > 0) {
        applyingRemote = true;
        try { applyShape(shapeArr.toArray()); } finally { applyingRemote = false; }
      }
      // Resolve seeder election : prefer the server-side claim, fall
      // back to lowest clientID. Wait 500 ms for awareness to settle
      // so the comparison sees every peer.
      setTimeout(() => {
        void (async () => {
          if (!cellsMap || !ydoc || !shapeArr) return;
          const empty = cellsMap.size === 0 && shapeArr.length === 0;
          if (!empty) {
            // Some peer already seeded ; pull whatever's there. Batch
            // the HF updates so the cascade fires once per replay
            // instead of once per cell.
            applyingRemote = true;
            try {
              if (shapeArr.length > 0) applyShape(shapeArr.toArray());
              replayRemoteCells(cellsMap);
            } finally {
              applyingRemote = false;
            }
            return;
          }
          const claim = await claimSeed();
          // 'lost' = server explicitly refused — never seed.
          // 'won' = always seed. 'unknown' = endpoint missing, fall back
          // to lowest-clientID. The previous version conflated 'lost'
          // and 'unknown' and let a peer override the server refusal.
          if (claim === 'lost') return;
          const shouldSeed = claim === 'won' || (claim === 'unknown' && isLowestClientID());
          if (!shouldSeed) return;
          // Re-check emptiness in case a peer seeded while we waited.
          if (cellsMap.size > 0 || shapeArr.length > 0) {
            applyingRemote = true;
            try {
              if (shapeArr.length > 0) applyShape(shapeArr.toArray());
              replayRemoteCells(cellsMap);
            } finally {
              applyingRemote = false;
            }
            return;
          }
          pushShape();
          // Inline cellsMap.set directly inside the outer transact so
          // we don't open one nested ydoc.transact per cell (10k cells =
          // 10k transacts otherwise). The observer at line ~498 already
          // filters by origin === 'ods-seed' so semantics are preserved.
          ydoc.transact(() => {
            sheets.forEach((sh, si) => {
              sh.cells.forEach((row, r) => {
                row.forEach((cell, c) => {
                  cellsMap!.set(cellKey(si, r, c), {
                    display: cell.display,
                    value: cell.value,
                    type: cell.type,
                    formula: cell.formula,
                  });
                });
              });
            });
          }, 'ods-seed');
        })();
      }, 500);
    });
    cellsMap.observe((ev) => {
      // Apply only what changed, and only when the origin isn't
      // our own transaction (transact tags via ydoc.transact 2nd arg).
      if (ev.transaction.origin === 'ods-cell' || ev.transaction.origin === 'ods-seed') return;
      applyingRemote = true;
      try {
        for (const [key, change] of ev.keys) {
          if (change.action === 'delete') {
            applyRemoteCell(key, undefined);
          } else {
            applyRemoteCell(key, cellsMap!.get(key));
          }
        }
      } finally {
        applyingRemote = false;
      }
    });
    shapeArr.observe((ev) => {
      if (ev.transaction.origin === 'ods-shape') return;
      applyingRemote = true;
      try { applyShape(shapeArr!.toArray()); } finally { applyingRemote = false; }
    });
  }

  function detachProvider() {
    if (provider) { try { provider.destroy(); } catch { /* ignore */ } provider = undefined; }
    if (ydoc) { try { ydoc.destroy(); } catch { /* ignore */ } ydoc = undefined; }
    cellsMap = undefined;
    shapeArr = undefined;
    // Clear the cross-peer buffer so a stale cell from workbook A
    // doesn't replay into workbook B when we attach to a new file.
    pendingCells.clear();
  }

  function flushSaveSync() {
    // Best-effort synchronous flush from beforeunload. writeFile is
    // async ; we kick it off + rely on the browser keeping the
    // request in-flight (most browsers honour keepalive fetches up
    // to 64 KiB which covers a typical .ods).
    if (!dirty) return;
    try { void save(); } catch { /* ignore */ }
  }

  function onBeforeUnload() {
    flushSaveSync();
  }

  onMount(() => {
    window.addEventListener('beforeunload', onBeforeUnload);
  });

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    if (dirty) void save();
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', onBeforeUnload);
    }
    detachProvider();
    if (hf) { try { hf.destroy(); } catch { /* ignore */ } hf = undefined; }
    resizeObs?.disconnect();
    resizeObs = undefined;
    observedScrollEl = undefined;
  });

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    status = 'loading';
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
      );
      if (seq !== loadSeq) return;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      if (seq !== loadSeq) return;
      let parsedSheets: ODSSheet[];
      if (buf.byteLength === 0) {
        parsedSheets = [blankSheet('Sheet1')];
      } else {
        const parsed = await parseODS(buf);
        if (seq !== loadSeq) return;
        parsedSheets = parsed.sheets.length > 0 ? parsed.sheets : [blankSheet('Sheet1')];
      }
      sheets = parsedSheets;
      activeSheet = 0;
      selRow = 0;
      selCol = 0;
      formulaBarValue = sheets[0]?.cells[0]?.[0]?.display ?? '';
      // T9 V0.2 : seed HyperFormula. The sheet matrix uses the
      // formula (when present, stripped of the `of:` prefix) or
      // the typed value as the cell content. HF stores formulas
      // natively + computes the cascade of dependents.
      rebuildHF();
      // T9 V0.3 : attach Yjs provider AFTER the local sheets are
      // populated so seed-push has something to push.
      attachProvider();
      status = 'ready';
      dirty = false;
    } catch (e) {
      if (seq !== loadSeq) return;
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  async function save() {
    if (status === 'saving') return;
    status = 'saving';
    try {
      const bytes = await writeODS(sheets);
      await writeFile(project, file, bytes, 'application/vnd.oasis.opendocument.spreadsheet');
      status = 'ready';
      dirty = false;
      savedAt = Date.now();
    } catch (e) {
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  function markDirty() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }

  // T9 V0.2 HyperFormula bridge.
  // rebuildHF : tear down the existing instance + rebuild from the
  // current sheets array. Cheap for small workbooks ; for huge
  // ones we'd switch to incremental setSheetContent calls.
  function rebuildHF() {
    if (hf) {
      try { hf.destroy(); } catch { /* ignore */ }
      hf = undefined;
    }
    const sheetsData: Record<string, (string | number | boolean | null)[][]> = {};
    for (const sh of sheets) {
      sheetsData[sh.name] = sh.cells.map(row => row.map(cellToHF));
    }
    hf = HyperFormula.buildFromSheets(sheetsData, {
      licenseKey: 'gpl-v3', // HyperFormula is dual GPLv3 / commercial ; we use GPLv3
    });
    seedDisplayCache();
  }
  function cellToHF(c: ODSCell): string | number | boolean | null {
    if (c.formula) {
      // ODS stores formulas with the `of:` prefix ; HF expects bare
      // `=A1+B1`. Strip any prefix + ensure a leading `=`.
      let f = c.formula.replace(/^of:/, '');
      if (!f.startsWith('=')) f = '=' + f;
      return f;
    }
    if (c.type === 'float' || c.type === 'int' || c.type === 'percentage') return Number(c.value);
    if (c.type === 'boolean') return Boolean(c.value);
    return c.display || null;
  }
  // seedDisplayCache : full-scan rebuild of the formula-result cache.
  // Runs ONCE per workbook load, inside rebuildHF. On the keystroke
  // path use updateDisplayCache(changes) which only touches the cells
  // HyperFormula's setCellContents reported as changed.
  function seedDisplayCache() {
    if (!hf) return;
    const next = new Map<string, string>();
    sheets.forEach((sh, si) => {
      sh.cells.forEach((row, r) => {
        row.forEach((cell, c) => {
          if (!cell.formula) return;
          try {
            const v = hf!.getCellValue({ sheet: si, row: r, col: c });
            if (v != null) next.set(si + ':' + r + ':' + c, String(v));
          } catch { /* malformed formula : leave it visible as source */ }
        });
      });
    });
    displayCache = next;
  }
  // updateDisplayCache : incremental update from HF's setCellContents
  // changeset. Loops only the changed addresses (typically 1-10 per
  // keystroke even with chained dependents) instead of scanning every
  // cell of every sheet. Drops entries for cells that no longer have
  // a formula in the local model so stale formula-result strings don't
  // ghost the literal value that replaced them.
  function updateDisplayCache(changes: ExportedChange[]) {
    if (!hf) return;
    let mutated = false;
    const next = new Map(displayCache);
    for (const ch of changes) {
      if (!(ch instanceof ExportedCellChange)) continue;
      const { sheet, row, col } = ch.address;
      const key = sheet + ':' + row + ':' + col;
      const localCell = sheets[sheet]?.cells[row]?.[col];
      if (localCell?.formula) {
        if (ch.newValue != null) {
          next.set(key, String(ch.newValue));
        } else {
          next.delete(key);
        }
      } else if (next.has(key)) {
        // Cell no longer has a formula locally : drop the stale entry.
        next.delete(key);
      }
      mutated = true;
    }
    if (mutated) displayCache = next;
  }

  // displayValue : what the user sees in the grid cell. Formula
  // cells render as the computed result ; everything else is the
  // raw display string.
  function displayValue(si: number, r: number, c: number, cell: ODSCell): string {
    if (cell.formula) {
      const v = displayCache.get(si + ':' + r + ':' + c);
      if (v != null) return v;
    }
    return cell.display;
  }

  function ensureCell(sheetIdx: number, r: number, c: number) {
    const sh = sheets[sheetIdx];
    while (sh.cells.length <= r) {
      const cols = sh.cells[0]?.length ?? 1;
      const row: ODSCell[] = [];
      for (let i = 0; i < cols; i++) row.push({ display: '', value: '', type: 'string' });
      sh.cells.push(row);
    }
    const row = sh.cells[r];
    while (row.length <= c) row.push({ display: '', value: '', type: 'string' });
  }

  // getCell : safe accessor used by the virtualized render path.
  // Returns an empty cell when the coordinate is past the current
  // dense storage so the viewport can keep scrolling without
  // pre-allocating millions of empty rows.
  function getCell(sheetIdx: number, r: number, c: number): ODSCell {
    const sh = sheets[sheetIdx];
    return sh?.cells[r]?.[c] ?? { display: '', value: '', type: 'string' };
  }

  function setCell(r: number, c: number, value: string) {
    ensureCell(activeSheet, r, c);
    const cell = sheets[activeSheet].cells[r][c];
    cell.display = value;
    // Best-effort typing : numeric-looking input → float ; the rest
    // stays string. Formulas (=…) are V0.2 ; for V0.1 we surface
    // them as plain text so they survive round-trip but don't
    // evaluate.
    if (value.startsWith('=')) {
      cell.type = 'string';
      cell.formula = 'of:' + value;
      cell.value = value;
      // Push the new formula into HF so dependents recompute.
      if (hf) {
        try {
          const changes = hf.setCellContents({ sheet: activeSheet, row: r, col: c }, [[value]]);
          updateDisplayCache(changes);
        } catch { /* ignore — bad formula keeps showing source */ }
      }
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      cell.type = 'float';
      cell.value = Number(value);
    } else if (/^(true|false)$/i.test(value)) {
      cell.type = 'boolean';
      cell.value = value.toLowerCase() === 'true';
    } else {
      cell.type = 'string';
      cell.value = value;
      // Clear any prior formula : the user just overwrote it.
      delete cell.formula;
    }
    // Push the non-formula value to HF too so dependents see it.
    if (hf && !value.startsWith('=')) {
      try {
        const hfValue =
          cell.type === 'float' ? Number(value) :
          cell.type === 'boolean' ? value.toLowerCase() === 'true' :
          value;
        const changes = hf.setCellContents({ sheet: activeSheet, row: r, col: c }, [[hfValue]]);
        updateDisplayCache(changes);
      } catch { /* ignore */ }
    }
    sheets = sheets; // trigger reactivity
    // T9 V0.3 : push the cell to the Y.Map for collab peers. Skip
    // when we're applying a remote update (the observer already
    // mutated the local cell ; pushing back would echo the value
    // to every peer and create an update storm).
    if (!applyingRemote) pushCellToYMap(activeSheet, r, c);
    markDirty();
  }

  function selectCell(r: number, c: number) {
    selRow = r;
    selCol = c;
    // Reset the selection range to the single cell.
    rangeFromRow = r;
    rangeFromCol = c;
    rangeToRow = r;
    rangeToCol = c;
    rangeKind = 'cell';
    const cell = sheets[activeSheet]?.cells[r]?.[c];
    // Formula cells : show the source in the formula bar (so the
    // user can edit the expression) ; literal cells show their
    // display string.
    formulaBarValue = cell?.formula
      ? (typeof cell.value === 'string' ? cell.value : String(cell.value))
      : (cell?.display ?? '');
  }

  function onCellInput(r: number, c: number, e: Event) {
    const v = (e.currentTarget as HTMLElement).textContent ?? '';
    setCell(r, c, v);
    formulaBarValue = v;
  }

  // navigateTo : move the selection / focus to (r, c) and scroll
  // the target cell into the visible window. Used by every
  // keyboard navigation path. Excel-style : arrow keys always
  // navigate ; the caret-mid-text gating from before was the
  // reason "right / left don't work" once a cell had content.
  function navigateTo(r: number, c: number) {
    const nr = Math.max(0, Math.min(MAX_ROWS - 1, r));
    const nc = Math.max(0, Math.min(MAX_COLS - 1, c));
    ensureCell(activeSheet, nr, nc);
    selectCell(nr, nc);
    scrollCellIntoView(nr, nc);
    focusCell(nr, nc);
  }

  // scrollCellIntoView : adjust scrollEl.scrollTop / scrollLeft so
  // the (r, c) cell sits inside the visible body area. Padding by
  // one cell on each side keeps the target away from the sticky
  // header strip + the right / bottom edges.
  function scrollCellIntoView(r: number, c: number) {
    if (!scrollEl) return;
    const cellTop = r * ROW_H;
    const cellLeft = c * COL_W;
    const cellBottom = cellTop + ROW_H;
    const cellRight = cellLeft + COL_W;
    const viewTop = scrollEl.scrollTop + HEADER_H;
    const viewLeft = scrollEl.scrollLeft + HEADER_W;
    const viewBottom = scrollEl.scrollTop + scrollEl.clientHeight;
    const viewRight = scrollEl.scrollLeft + scrollEl.clientWidth;
    if (cellTop < viewTop) {
      scrollEl.scrollTop = Math.max(0, cellTop - HEADER_H);
    } else if (cellBottom > viewBottom) {
      scrollEl.scrollTop = cellBottom - scrollEl.clientHeight + ROW_H;
    }
    if (cellLeft < viewLeft) {
      scrollEl.scrollLeft = Math.max(0, cellLeft - HEADER_W);
    } else if (cellRight > viewRight) {
      scrollEl.scrollLeft = cellRight - scrollEl.clientWidth + COL_W;
    }
  }

  // Navigation keys we always intercept ; printable keys + others
  // flow through so contenteditable text input still works.
  const NAV_KEYS = new Set([
    'Tab', 'Enter', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown',
  ]);

  // onContainerKey : runs at the scroll container level so
  // navigation keeps working even when focus drifts off the cell
  // (e.g. after a row-changing nav, the browser sometimes parks
  // focus on document.body before the new cell's RAF lands).
  // When focus IS on a cell, the cell's own onkeydown already
  // ran + stopPropagation()-ed the event ; the container handler
  // only fires for unhandled bubbles.
  function onContainerKey(e: KeyboardEvent) {
    if (!NAV_KEYS.has(e.key)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    onCellKey(selRow, selCol, e);
  }

  function onCellKey(r: number, c: number, e: KeyboardEvent) {
    // Ctrl+Shift+Tab is a reserved escape hatch : always let the
    // browser handle it so power users can tab out of the grid
    // even from a deep interior cell.
    if (e.key === 'Tab' && e.ctrlKey && e.shiftKey) return;
    // Modifier-combos (Cmd/Ctrl + key) flow through so the user
    // can copy / paste / undo / etc. without us hijacking.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // If we're going to handle this nav key, stop propagation so
    // the container's fallback handler doesn't fire on the same
    // event.
    if (NAV_KEYS.has(e.key)) e.stopPropagation();
    switch (e.key) {
      case 'Tab': {
        // Let the browser tab out at the boundary so the user can
        // reach the next focusable widget instead of being trapped.
        const sh = sheets[activeSheet];
        const lastRow = Math.max(0, (sh?.cells.length ?? 1) - 1);
        const lastCol = Math.max(0, (sh?.cells[r]?.length ?? 1) - 1);
        if (!e.shiftKey && r === lastRow && c === lastCol) return;
        if (e.shiftKey && r === 0 && c === 0) return;
        e.preventDefault();
        navigateTo(r, e.shiftKey ? c - 1 : c + 1);
        return;
      }
      case 'Enter':
        e.preventDefault();
        navigateTo(r + 1, c);
        return;
      case 'ArrowDown':
        e.preventDefault();
        navigateTo(r + 1, c);
        return;
      case 'ArrowUp':
        e.preventDefault();
        navigateTo(r - 1, c);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        navigateTo(r, c - 1);
        return;
      case 'ArrowRight':
        e.preventDefault();
        navigateTo(r, c + 1);
        return;
      case 'Home':
        e.preventDefault();
        navigateTo(r, 0);
        return;
      case 'End':
        e.preventDefault();
        navigateTo(r, Math.max(0, (sheets[activeSheet]?.cells[r]?.length ?? 1) - 1));
        return;
      case 'PageDown':
        e.preventDefault();
        navigateTo(r + Math.max(1, Math.floor(viewportH / ROW_H) - 1), c);
        return;
      case 'PageUp':
        e.preventDefault();
        navigateTo(r - Math.max(1, Math.floor(viewportH / ROW_H) - 1), c);
        return;
      case 'Escape':
        // Blur out of the cell so the user is back in "selection
        // mode" (Excel's Esc cancels edit + keeps selection).
        (e.currentTarget as HTMLElement).blur();
        return;
    }
  }

  function focusCell(r: number, c: number) {
    // Keep focus inside scrollEl so the container's keydown
    // fallback always catches navigation keys. We FIRST focus the
    // scroll container ; then poll for the target cell + transfer
    // focus to it when it lands.
    if (scrollEl && document.activeElement !== scrollEl
     && !scrollEl.contains(document.activeElement)) {
      scrollEl.focus({ preventScroll: true });
    }
    let attempts = 0;
    const tryFocus = () => {
      const el = document.querySelector(
        '[data-cell="' + r + ',' + c + '"]',
      ) as HTMLElement | null;
      if (el) {
        el.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        return;
      }
      if (++attempts < 8) requestAnimationFrame(tryFocus);
      else if (scrollEl) {
        // Cell stayed out of DOM ; keep scrollEl focused so the
        // container fallback can keep handling navigation keys.
        scrollEl.focus({ preventScroll: true });
      }
    };
    requestAnimationFrame(tryFocus);
  }

  function onFormulaInput(v: string) {
    formulaBarValue = v;
    setCell(selRow, selCol, v);
  }

  function addRow() {
    const sh = sheets[activeSheet];
    const cols = sh.cells[0]?.length ?? 10;
    const row: ODSCell[] = [];
    for (let i = 0; i < cols; i++) row.push({ display: '', value: '', type: 'string' });
    sh.cells.push(row);
    sheets = sheets;
    if (!applyingRemote) pushShape();
    markDirty();
  }

  function addColumn() {
    const sh = sheets[activeSheet];
    for (const row of sh.cells) {
      row.push({ display: '', value: '', type: 'string' });
    }
    sheets = sheets;
    if (!applyingRemote) pushShape();
    markDirty();
  }

  function addSheet() {
    const name = 'Sheet' + (sheets.length + 1);
    sheets = [...sheets, blankSheet(name)];
    activeSheet = sheets.length - 1;
    if (!applyingRemote) pushShape();
    markDirty();
  }

  // savedLabel : how long ago the last save landed. Only tick while
  // `savedAt` is set AND the save is within the last hour ; beyond that
  // the label degrades to "à HH:MM" which is static, so the interval is
  // pure overhead (L3 of the 2026-06-14 perf audit). We re-evaluate the
  // gating inside the interval itself so the effect's deps stay limited
  // to `savedAt` (not `nowTick`, which the interval mutates).
  $effect(() => {
    if (!savedAt) return;
    const savedAtSnap = savedAt;
    if (Date.now() - savedAtSnap > 3600_000) return;
    nowTick = Date.now();
    const id = setInterval(() => {
      const delta = Date.now() - savedAtSnap;
      nowTick = Date.now();
      if (delta > 3600_000) {
        // Past the "il y a … min" window : the label is static
        // "à HH:MM" from here on. Stop ticking.
        clearInterval(id);
      }
    }, 30000);
    return () => clearInterval(id);
  });
  const savedLabel = $derived(() => {
    if (!savedAt) return '';
    const delta = Math.max(0, nowTick - savedAt);
    if (delta < 60_000) return 'il y a ' + Math.floor(delta / 1000) + 's';
    if (delta < 3600_000) return 'il y a ' + Math.floor(delta / 60_000) + ' min';
    const d = new Date(savedAt);
    return 'à ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  $effect(() => {
    project; file;
    if (file) void load();
  });
</script>

<div class="flex flex-col h-full bg-base-100">
  <!-- Toolbar : ribbon-style controls + sheet tabs + status. -->
  <div class="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200 text-sm">
    <button class="btn btn-ghost btn-xs" onclick={() => addRow()} title="Add a row at the bottom">+ Row</button>
    <button class="btn btn-ghost btn-xs" onclick={() => addColumn()} title="Add a column on the right">+ Col</button>
    <button class="btn btn-ghost btn-xs" onclick={() => addSheet()} title="Add a new sheet">+ Sheet</button>
    <span class="divider divider-horizontal mx-0"></span>
    <!-- T9 V0.4 : Excel-style formatting cluster. Each button
         applies to the current selection (cell, row, column, or
         whole sheet). -->
    <button type="button" title="Bold (Cmd/Ctrl+B)" aria-pressed={isBold} class="btn btn-ghost btn-xs font-bold" onclick={toggleBold} data-testid="ods-bold">B</button>
    <button type="button" title="Italic (Cmd/Ctrl+I)" aria-pressed={isItalic} class="btn btn-ghost btn-xs italic" onclick={toggleItalic} data-testid="ods-italic">I</button>
    <button type="button" title="Underline (Cmd/Ctrl+U)" aria-pressed={isUnderline} class="btn btn-ghost btn-xs underline" onclick={toggleUnderline} data-testid="ods-underline">U</button>
    <label class="btn btn-ghost btn-xs px-1 inline-flex items-center gap-1" title="Text colour">
      <span class="font-bold">A</span>
      <input type="color" value="#000000" class="w-4 h-4 p-0 border-0 bg-transparent cursor-pointer"
             oninput={(e) => setTextColor((e.currentTarget as HTMLInputElement).value)}
             data-testid="ods-text-color" />
    </label>
    <label class="btn btn-ghost btn-xs px-1 inline-flex items-center gap-1" title="Cell background">
      <span>▮</span>
      <input type="color" value="#ffff00" class="w-4 h-4 p-0 border-0 bg-transparent cursor-pointer"
             oninput={(e) => setBackground((e.currentTarget as HTMLInputElement).value)}
             data-testid="ods-bg-color" />
    </label>
    <label class="btn btn-ghost btn-xs px-1 inline-flex items-center gap-1" title="Border colour">
      <span>▦</span>
      <input type="color" value="#000000" class="w-4 h-4 p-0 border-0 bg-transparent cursor-pointer"
             oninput={(e) => setAllBorders((e.currentTarget as HTMLInputElement).value)}
             data-testid="ods-border-color" />
    </label>
    <span class="divider divider-horizontal mx-0"></span>
    <button type="button" title="Align left"   aria-label="Align left"   class="btn btn-ghost btn-xs" onclick={() => setAlign('left')}>⇤</button>
    <button type="button" title="Align centre" aria-label="Align centre" class="btn btn-ghost btn-xs" onclick={() => setAlign('center')}>≡</button>
    <button type="button" title="Align right"  aria-label="Align right"  class="btn btn-ghost btn-xs" onclick={() => setAlign('right')}>⇥</button>
    <button type="button" title="Justify"      aria-label="Justify"      class="btn btn-ghost btn-xs" onclick={() => setAlign('justify')}>☰</button>
    <select
      class="select select-bordered select-xs"
      title="Font family"
      onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) setFontFamily(v); (e.currentTarget as HTMLSelectElement).value = ''; }}
    >
      <option value="" disabled selected>Font…</option>
      <option>Arial</option>
      <option>Helvetica</option>
      <option>Times New Roman</option>
      <option>Georgia</option>
      <option>Courier New</option>
      <option>Verdana</option>
      <option>Calibri</option>
    </select>
    <select
      class="select select-bordered select-xs"
      title="Font size"
      onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) setFontSize(v); (e.currentTarget as HTMLSelectElement).value = ''; }}
    >
      <option value="" disabled selected>Size…</option>
      {#each ['8pt','9pt','10pt','11pt','12pt','14pt','16pt','18pt','24pt','36pt'] as s}
        <option value={s}>{s.replace('pt','')}</option>
      {/each}
    </select>
    <button type="button" title="Clear formatting" class="btn btn-ghost btn-xs" onclick={clearFormatting}>⌫</button>
    <span class="divider divider-horizontal mx-0"></span>
    <button
      type="button"
      class="btn btn-xs gap-1"
      class:btn-primary={dirty}
      class:btn-ghost={!dirty}
      onclick={() => void save()}
      disabled={status === 'saving'}
      data-testid="ods-save"
    >
      <span>💾</span>
      <span>{dirty ? 'Enregistrer' : 'Enregistré'}</span>
    </button>
    <div class="flex-1"></div>
    {#if status === 'saving'}
      <span class="text-xs"><span class="loading loading-spinner loading-xs"></span> enregistrement…</span>
    {:else if status === 'error'}
      <span class="text-error text-xs" title={errorMessage}>⚠ erreur</span>
    {:else if dirty}
      <span class="text-warning text-xs">● modifié</span>
    {:else if savedAt}
      <span class="opacity-50 text-xs">✓ {savedLabel()}</span>
    {:else}
      <span class="opacity-50 text-xs uppercase">ODS</span>
    {/if}
  </div>

  <!-- Formula bar : shows + edits the selected cell. V0.2 will
       parse `=…` as a HyperFormula expression. -->
  <div class="flex items-center gap-2 px-2 py-1 border-b border-base-300 bg-base-100 text-xs">
    <span class="font-mono opacity-60 px-1 select-none" data-testid="ods-cellref">
      {columnLabel(selCol)}{selRow + 1}
    </span>
    <input
      type="text"
      class="input input-bordered input-xs flex-1 font-mono"
      value={formulaBarValue}
      oninput={(e) => onFormulaInput((e.currentTarget as HTMLInputElement).value)}
      placeholder="Cell value or =formula"
      data-testid="ods-formula-bar"
    />
  </div>

  <!-- Sheet tabs -->
  {#if sheets.length > 1}
    <div
      class="tabs tabs-box px-2 py-1 border-b border-base-300 bg-base-200"
      role="tablist"
      aria-label="Sheets"
    >
      {#each sheets as sh, i (sh.name + i)}
        <button
          class="tab tab-xs"
          class:tab-active={i === activeSheet}
          role="tab"
          aria-selected={i === activeSheet}
          onclick={() => { activeSheet = i; selectCell(0, 0); }}
          data-testid="ods-sheet-tab"
          data-sheet={sh.name}
        >{sh.name}</button>
      {/each}
    </div>
  {/if}

  <!-- Virtualized grid : the outer div is the scroll container ;
       the inner canvas reserves the FULL virtual size (1M rows ×
       16K cols) so the scrollbar can roam anywhere. Visible cells
       are absolute-positioned div s, recomputed on scroll. -->
  <div
    bind:this={scrollEl}
    class="flex-1 overflow-auto ods-scroll"
    data-testid="ods-grid-wrap"
    tabindex="0"
    role="grid"
    aria-rowcount={MAX_ROWS}
    aria-colcount={MAX_COLS}
    onscroll={onGridScroll}
    onkeydown={onContainerKey}
  >
    {#if status === 'loading'}
      <div class="opacity-60 text-xs p-3">Chargement…</div>
    {:else if status === 'error'}
      <div class="text-error text-xs p-3">{errorMessage}</div>
    {:else if sheets[activeSheet]}
      <!-- Canvas : the virtual area. Total size = MAX_COLS·COL_W ×
           MAX_ROWS·ROW_H. The HEADER_W / HEADER_H offsets keep the
           sticky headers from overlapping the data. -->
      <div
        class="ods-canvas"
        style="width:{HEADER_W + MAX_COLS * COL_W}px; height:{HEADER_H + MAX_ROWS * ROW_H}px;"
        data-testid="ods-canvas"
      >
        <!-- Top-left corner stays pinned both ways. Click selects
             the entire sheet (Excel's "Select All" trick). -->
        <div
          class="ods-corner-sticky"
          role="button"
          tabindex="-1"
          title="Tout sélectionner"
          style="width:{HEADER_W}px; height:{HEADER_H}px;
                 transform: translate({scrollLeft}px, {scrollTop}px);"
          onclick={() => selectWholeSheet()}
        ></div>
        <!-- Column header strip : sticky to the top of the viewport. -->
        <div
          class="ods-colheader-row"
          style="left:{HEADER_W}px; height:{HEADER_H}px;
                 width:{MAX_COLS * COL_W}px;
                 transform: translateY({scrollTop}px);"
        >
          {#each visCols as c (c)}
            <div
              class="ods-colheader"
              class:ods-colheader-sel={(rangeKind === 'col' || rangeKind === 'all') && c >= Math.min(rangeFromCol, rangeToCol) && c <= Math.max(rangeFromCol, rangeToCol) || c === selCol}
              role="button"
              tabindex="-1"
              data-colheader={c}
              title="Sélectionner la colonne {columnLabel(c)}"
              style="left:{c * COL_W}px; width:{COL_W}px; height:{HEADER_H}px;"
              onclick={() => selectWholeColumn(c)}
            >{columnLabel(c)}</div>
          {/each}
        </div>
        <!-- Row header column : sticky to the left of the viewport. -->
        <div
          class="ods-rowheader-col"
          style="top:{HEADER_H}px; width:{HEADER_W}px;
                 height:{MAX_ROWS * ROW_H}px;
                 transform: translateX({scrollLeft}px);"
        >
          {#each visRows as r (r)}
            <div
              class="ods-rowheader"
              class:ods-rowheader-sel={(rangeKind === 'row' || rangeKind === 'all') && r >= Math.min(rangeFromRow, rangeToRow) && r <= Math.max(rangeFromRow, rangeToRow) || r === selRow}
              role="button"
              tabindex="-1"
              data-rowheader={r}
              title="Sélectionner la ligne {r + 1}"
              style="top:{r * ROW_H}px; height:{ROW_H}px; width:{HEADER_W}px;"
              onclick={() => selectWholeRow(r)}
            >{r + 1}</div>
          {/each}
        </div>
        <!-- Data cells : only the visible window is rendered. The
             rest of the canvas is empty space the user can scroll
             over without ever touching a DOM node. -->
        <div class="ods-cells" style="left:{HEADER_W}px; top:{HEADER_H}px;">
          {#each visRows as r (r)}
            {#each visCols as c (r + ':' + c)}
              {@const cell = getCell(activeSheet, r, c)}
              <div
                contenteditable="true"
                class="ods-cell"
                class:ods-cell-selected={r === selRow && c === selCol}
                class:ods-cell-range={rangeKind !== 'cell' && inSelectionRange(r, c) && !(r === selRow && c === selCol)}
                class:ods-cell-formula={!!cell.formula}
                data-cell="{r},{c}"
                data-formula={cell.formula ? '1' : ''}
                title={cell.formula ? (typeof cell.value === 'string' ? cell.value : '') : undefined}
                style="left:{c * COL_W}px; top:{r * ROW_H}px;
                       width:{COL_W}px; height:{ROW_H}px;
                       {cellInlineStyle(cell)}"
                onclick={() => selectCell(r, c)}
                oninput={(e) => onCellInput(r, c, e)}
                onkeydown={(e) => onCellKey(r, c, e)}
              >{displayValue(activeSheet, r, c, cell)}</div>
            {/each}
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Virtualized grid layout. Excel-like : sticky row + column
     headers, every cell absolutely-positioned inside an enormous
     "canvas" div whose size is the full virtual sheet. */
  .ods-scroll {
    position: relative;
    background: white;
    color: #1a1a1a;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 0.85rem;
    outline: none;
  }
  .ods-scroll:focus-visible {
    outline: 2px solid rgba(0, 100, 200, 0.4);
    outline-offset: -2px;
  }
  .ods-canvas {
    position: relative;
  }
  /* Headers are OPAQUE so the data canvas never shows through
     them when the user scrolls. Solid backgrounds + z-index above
     the cell layer (z-index: 2 when focused). */
  .ods-corner-sticky {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 5;
    background: #e9ecef;
    border-right: 1px solid rgba(0,0,0,0.18);
    border-bottom: 1px solid rgba(0,0,0,0.18);
  }
  .ods-colheader-row {
    position: absolute;
    top: 0;
    z-index: 4;
    background: #f1f3f5;
    border-bottom: 1px solid rgba(0,0,0,0.25);
  }
  .ods-rowheader-col {
    position: absolute;
    left: 0;
    z-index: 4;
    background: #f1f3f5;
    border-right: 1px solid rgba(0,0,0,0.25);
  }
  .ods-colheader, .ods-rowheader {
    position: absolute;
    box-sizing: border-box;
    text-align: center;
    font-weight: 600;
    color: rgba(0,0,0,0.6);
    font-size: 0.7em;
    user-select: none;
    border: 1px solid rgba(0,0,0,0.15);
    background: #f1f3f5;
    line-height: 22px;
  }
  .ods-rowheader { line-height: 22px; }
  .ods-colheader-sel, .ods-rowheader-sel {
    background: #cfe2ff;
    color: rgba(0, 70, 150, 1);
  }
  .ods-cells {
    position: absolute;
  }
  .ods-cell {
    position: absolute;
    box-sizing: border-box;
    border: 1px solid rgba(0,0,0,0.1);
    padding: 0 0.35em;
    line-height: 22px;
    outline: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    background: white;
  }
  .ods-cell:focus {
    background: rgba(0, 130, 220, 0.06);
    overflow: visible;
    z-index: 2;
  }
  .ods-cell-selected { box-shadow: inset 0 0 0 2px rgba(0, 100, 200, 0.5); }
  /* Cells inside a row/column/all-sheet selection get a light
     blue overlay so the user sees the range at a glance. Uses
     inset box-shadow (not background-color) so it stacks ABOVE
     any user-applied cell background without clobbering it. */
  .ods-cell-range { box-shadow: inset 0 0 0 9999px rgba(0, 100, 200, 0.08); }
  /* Formula cells get a subtle marker so the user can tell at a
     glance which cells are computed vs literal. */
  .ods-cell-formula { background: rgba(0, 200, 100, 0.04); }
  /* ∑ marker for formula cells. The cell itself is already
     position:absolute (above), so the ::after pseudo-element
     anchors to the cell's box. */
  .ods-cell-formula::after {
    content: '∑';
    position: absolute;
    top: 1px;
    right: 2px;
    font-size: 0.55em;
    color: rgba(0, 130, 60, 0.6);
    pointer-events: none;
  }
</style>
