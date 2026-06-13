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
  import { HyperFormula } from 'hyperformula';
  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import { onDestroy } from 'svelte';

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
  // T9 V0.2 : HyperFormula engine. One instance for the whole
  // workbook ; sheets are added/removed as the user toggles them.
  // `displayCache` mirrors HF's computed values so the grid can
  // render "=A1+B1" cells as their numeric result without calling
  // HF on every render.
  let hf: HyperFormula | undefined;
  let displayCache = $state<Map<string, string>>(new Map());
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
  // `applyingRemote` guards against the observer triggering its own
  // local change handler when we mutate the local sheets[] in
  // response to a remote update.
  let applyingRemote = false;

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
    if (!sheets[si]) return;
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
        hf.setCellContents({ sheet: si, row: r, col: c }, [[hfValue]]);
        recomputeDisplayCache();
      } catch { /* ignore */ }
    }
  }

  function attachProvider() {
    if (!file) return;
    if (provider) return;
    ydoc = new Y.Doc();
    provider = new WebsocketProvider(wsURL(project), 'ods:' + file, ydoc);
    cellsMap = ydoc.getMap('cells');
    // Seed the Y.Map with our locally-loaded cells the first time
    // the provider syncs ; if another peer already populated it,
    // their state wins via Yjs LWW-by-clock semantics.
    provider.once('sync', () => {
      if (!cellsMap || !ydoc) return;
      // If the map is empty, push all local cells. Otherwise, the
      // observer below will apply remote state when it fires.
      if (cellsMap.size === 0) {
        ydoc.transact(() => {
          sheets.forEach((sh, si) => {
            sh.cells.forEach((row, r) => {
              row.forEach((_cell, c) => {
                pushCellToYMap(si, r, c);
              });
            });
          });
        }, 'ods-seed');
      } else {
        // Pull every entry into local state.
        applyingRemote = true;
        try {
          for (const [k, v] of cellsMap.entries()) applyRemoteCell(k, v);
        } finally {
          applyingRemote = false;
        }
      }
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
  }

  function detachProvider() {
    if (provider) { try { provider.destroy(); } catch { /* ignore */ } provider = undefined; }
    if (ydoc) { try { ydoc.destroy(); } catch { /* ignore */ } ydoc = undefined; }
    cellsMap = undefined;
  }

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    detachProvider();
    if (hf) { try { hf.destroy(); } catch { /* ignore */ } hf = undefined; }
  });

  async function load() {
    status = 'loading';
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
      );
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      if (buf.byteLength === 0) {
        sheets = [blankSheet('Sheet1')];
      } else {
        const parsed = await parseODS(buf);
        sheets = parsed.sheets.length > 0 ? parsed.sheets : [blankSheet('Sheet1')];
      }
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
    recomputeDisplayCache();
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
  function recomputeDisplayCache() {
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
      const cols = sh.cells[0]?.length ?? 10;
      const row: ODSCell[] = [];
      for (let i = 0; i < cols; i++) row.push({ display: '', value: '', type: 'string' });
      sh.cells.push(row);
    }
    const row = sh.cells[r];
    while (row.length <= c) row.push({ display: '', value: '', type: 'string' });
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
          hf.setCellContents({ sheet: activeSheet, row: r, col: c }, [[value]]);
          recomputeDisplayCache();
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
        hf.setCellContents({ sheet: activeSheet, row: r, col: c }, [[hfValue]]);
        recomputeDisplayCache();
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

  function onCellKey(r: number, c: number, e: KeyboardEvent) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const next = e.shiftKey ? Math.max(0, c - 1) : c + 1;
      ensureCell(activeSheet, r, next);
      selectCell(r, next);
      focusCell(r, next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const next = r + 1;
      ensureCell(activeSheet, next, c);
      selectCell(next, c);
      focusCell(next, c);
    } else if (e.key === 'ArrowDown') {
      const next = r + 1;
      ensureCell(activeSheet, next, c);
      selectCell(next, c);
      focusCell(next, c);
      e.preventDefault();
    } else if (e.key === 'ArrowUp' && r > 0) {
      selectCell(r - 1, c);
      focusCell(r - 1, c);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && c > 0
      // Don't steal arrow-left when the caret is mid-text in the cell.
      && (window.getSelection()?.anchorOffset ?? 0) === 0) {
      selectCell(r, c - 1);
      focusCell(r, c - 1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      const len = (e.currentTarget as HTMLElement).textContent?.length ?? 0;
      if ((window.getSelection()?.anchorOffset ?? 0) === len) {
        selectCell(r, c + 1);
        ensureCell(activeSheet, r, c + 1);
        focusCell(r, c + 1);
        e.preventDefault();
      }
    }
  }

  function focusCell(r: number, c: number) {
    setTimeout(() => {
      const el = document.querySelector(
        '[data-cell="' + r + ',' + c + '"]',
      ) as HTMLElement | null;
      el?.focus();
      // Move caret to end so subsequent typing extends.
      const range = document.createRange();
      if (el) {
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }, 0);
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
    markDirty();
  }

  function addColumn() {
    const sh = sheets[activeSheet];
    for (const row of sh.cells) {
      row.push({ display: '', value: '', type: 'string' });
    }
    sheets = sheets;
    markDirty();
  }

  function addSheet() {
    const name = 'Sheet' + (sheets.length + 1);
    sheets = [...sheets, blankSheet(name)];
    activeSheet = sheets.length - 1;
    markDirty();
  }

  // savedLabel : how long ago the last save landed.
  $effect(() => {
    const id = setInterval(() => { nowTick = Date.now(); }, 30000);
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
    if (file) load();
  });
</script>

<div class="flex flex-col h-full bg-base-100">
  <!-- Toolbar : ribbon-style controls + sheet tabs + status. -->
  <div class="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200 text-sm">
    <button class="btn btn-ghost btn-xs" onclick={() => addRow()} title="Add a row at the bottom">+ Row</button>
    <button class="btn btn-ghost btn-xs" onclick={() => addColumn()} title="Add a column on the right">+ Col</button>
    <button class="btn btn-ghost btn-xs" onclick={() => addSheet()} title="Add a new sheet">+ Sheet</button>
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
    <div class="tabs tabs-boxed px-2 py-1 border-b border-base-300 bg-base-200">
      {#each sheets as sh, i (sh.name + i)}
        <button
          class="tab tab-xs"
          class:tab-active={i === activeSheet}
          onclick={() => { activeSheet = i; selectCell(0, 0); }}
          data-testid="ods-sheet-tab"
          data-sheet={sh.name}
        >{sh.name}</button>
      {/each}
    </div>
  {/if}

  <!-- Grid -->
  <div class="flex-1 overflow-auto" data-testid="ods-grid-wrap">
    {#if status === 'loading'}
      <div class="opacity-60 text-xs p-3">Chargement…</div>
    {:else if status === 'error'}
      <div class="text-error text-xs p-3">{errorMessage}</div>
    {:else if sheets[activeSheet]}
      <table class="ods-grid">
        <thead>
          <tr>
            <th class="ods-corner"></th>
            {#each Array.from({ length: sheets[activeSheet].cells[0]?.length ?? 0 }, (_, c) => c) as c (c)}
              <th class="ods-colheader">{columnLabel(c)}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each sheets[activeSheet].cells as row, r (r)}
            <tr>
              <th class="ods-rowheader">{r + 1}</th>
              {#each row as cell, c (r + ',' + c)}
                <td
                  contenteditable="true"
                  class="ods-cell"
                  class:ods-cell-selected={r === selRow && c === selCol}
                  class:ods-cell-formula={!!cell.formula}
                  data-cell="{r},{c}"
                  data-formula={cell.formula ? '1' : ''}
                  title={cell.formula ? (typeof cell.value === 'string' ? cell.value : '') : undefined}
                  onclick={() => selectCell(r, c)}
                  oninput={(e) => onCellInput(r, c, e)}
                  onkeydown={(e) => onCellKey(r, c, e)}
                >{displayValue(activeSheet, r, c, cell)}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .ods-grid {
    border-collapse: collapse;
    font-size: 0.85rem;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  .ods-grid th, .ods-grid td {
    border: 1px solid rgba(0,0,0,0.15);
    padding: 0 0.4em;
    min-width: 5em;
    height: 1.6em;
    text-align: left;
    vertical-align: middle;
  }
  .ods-colheader, .ods-rowheader, .ods-corner {
    background: rgba(0,0,0,0.05);
    text-align: center;
    font-weight: 600;
    user-select: none;
    color: rgba(0,0,0,0.6);
    font-size: 0.75em;
    min-width: 2.5em;
  }
  .ods-cell {
    outline: none;
  }
  .ods-cell:focus { background: rgba(0, 130, 220, 0.06); }
  .ods-cell-selected { box-shadow: inset 0 0 0 2px rgba(0, 100, 200, 0.5); }
  /* Formula cells get a subtle marker so the user can tell at a
     glance which cells are computed vs literal. */
  .ods-cell-formula { background: rgba(0, 200, 100, 0.04); }
  .ods-cell-formula::after {
    content: '∑';
    position: absolute;
    margin-left: -1.1em;
    margin-top: -0.3em;
    font-size: 0.55em;
    color: rgba(0, 130, 60, 0.6);
    pointer-events: none;
  }
  .ods-cell { position: relative; }
</style>
