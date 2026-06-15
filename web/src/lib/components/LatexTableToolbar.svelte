<script lang="ts">
  // LatexTableToolbar — tiny floating toolbar anchored to a clicked
  // <td> inside a .latex-tabular table inside the WYSIWYG surface.
  // Lets the user insert/delete rows + columns without leaving the
  // contenteditable. Each mutation calls onChange so the parent fires
  // its onInput debounce + saves the round-tripped LaTeX.
  //
  // Anchored fixed at the bottom-right of the cell's bounding rect ;
  // re-positions every 200ms so it tracks scroll + resize without
  // wiring listeners on every ancestor.

  import { onMount, onDestroy } from 'svelte';

  interface Props {
    table: HTMLTableElement;
    cell: HTMLTableCellElement;
    onChange: () => void;
    onClose: () => void;
  }
  let { table, cell, onChange, onClose }: Props = $props();

  let toolbarEl: HTMLDivElement | undefined = $state();
  let top = $state(0);
  let left = $state(0);
  let tracker: ReturnType<typeof setInterval> | undefined;

  // Resolve the cell's (row, col) inside the table. Walks the rows
  // collection so we don't trust a stale index — the user might have
  // already mutated the table since the cell was captured.
  function locate(): { row: number; col: number } | null {
    const tr = cell.parentElement as HTMLTableRowElement | null;
    if (!tr) return null;
    const rows = table.rows;
    let rowIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] === tr) { rowIdx = i; break; }
    }
    if (rowIdx < 0) return null;
    let colIdx = -1;
    for (let i = 0; i < tr.cells.length; i++) {
      if (tr.cells[i] === cell) { colIdx = i; break; }
    }
    if (colIdx < 0) return null;
    return { row: rowIdx, col: colIdx };
  }

  // Each newly-inserted cell needs *something* inside it so the
  // contenteditable browser actually places a caret + paints the
  // border. A bare &nbsp; is the cheapest visible filler.
  function fillCell(td: HTMLTableCellElement) {
    td.innerHTML = '&nbsp;';
  }

  function reposition() {
    // Cell may have been detached by an external edit — close + bail.
    if (!cell.isConnected || !table.isConnected || !table.contains(cell)) {
      onClose();
      return;
    }
    const r = cell.getBoundingClientRect();
    top = r.bottom + 4;
    left = r.right + 4;
  }

  function insertRowAt(index: number) {
    const colCount = (cell.parentElement as HTMLTableRowElement | null)?.cells.length ?? 1;
    const tr = table.insertRow(index);
    for (let i = 0; i < colCount; i++) {
      const td = tr.insertCell(i);
      fillCell(td);
    }
    onChange();
  }

  function rowAbove() {
    const loc = locate();
    if (!loc) return;
    insertRowAt(loc.row);
  }

  function rowBelow() {
    const loc = locate();
    if (!loc) return;
    insertRowAt(loc.row + 1);
  }

  function colLeft() {
    const loc = locate();
    if (!loc) return;
    for (let i = 0; i < table.rows.length; i++) {
      const td = table.rows[i].insertCell(loc.col);
      fillCell(td);
    }
    onChange();
  }

  function colRight() {
    const loc = locate();
    if (!loc) return;
    for (let i = 0; i < table.rows.length; i++) {
      const td = table.rows[i].insertCell(loc.col + 1);
      fillCell(td);
    }
    onChange();
  }

  function delRow() {
    const loc = locate();
    if (!loc) return;
    if (table.rows.length <= 1) return; // refuse to wipe the table
    table.deleteRow(loc.row);
    onChange();
    onClose();
  }

  function delCol() {
    const loc = locate();
    if (!loc) return;
    const firstRow = table.rows[0];
    if (!firstRow || firstRow.cells.length <= 1) return;
    for (let i = 0; i < table.rows.length; i++) {
      const row = table.rows[i];
      if (loc.col < row.cells.length) {
        row.deleteCell(loc.col);
      }
    }
    onChange();
    onClose();
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function onWindowClick(e: MouseEvent) {
    const target = e.target as Node | null;
    if (!toolbarEl || !target) return;
    if (!toolbarEl.contains(target)) {
      onClose();
    }
  }

  onMount(() => {
    reposition();
    tracker = setInterval(reposition, 200);
  });

  onDestroy(() => {
    if (tracker) clearInterval(tracker);
  });
</script>

<svelte:window onkeydown={onWindowKey} onclick={onWindowClick} />

<div
  bind:this={toolbarEl}
  class="latex-table-toolbar card bg-base-200 border border-base-300 shadow-xl"
  style="top: {top}px; left: {left}px;"
  role="toolbar"
  aria-label="Table cell actions"
  data-testid="latex-table-toolbar"
>
  <div class="card-body p-2 gap-2 flex-row items-center">
    <div class="join">
      <button class="join-item btn btn-xs" onclick={rowAbove} title="Insert row above" aria-label="Insert row above">Row ↑</button>
      <button class="join-item btn btn-xs" onclick={rowBelow} title="Insert row below" aria-label="Insert row below">Row ↓</button>
      <button class="join-item btn btn-xs" onclick={colLeft} title="Insert column left" aria-label="Insert column left">Col ←</button>
      <button class="join-item btn btn-xs" onclick={colRight} title="Insert column right" aria-label="Insert column right">Col →</button>
    </div>
    <div class="join">
      <button class="join-item btn btn-xs" onclick={delRow} title="Delete row" aria-label="Delete row">Del row</button>
      <button class="join-item btn btn-xs" onclick={delCol} title="Delete column" aria-label="Delete column">Del col</button>
    </div>
    <button class="btn btn-ghost btn-xs" onclick={onClose} title="Close" aria-label="Close">×</button>
  </div>
</div>

<style>
  .latex-table-toolbar {
    position: fixed;
    z-index: 50;
  }
</style>
