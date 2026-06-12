<script module lang="ts">
  // Public types live in <script module> so consumers can do
  //   import type { ContextEntry } from './ContextMenu.svelte';
  // Svelte 5's instance <script> can't carry `export interface` /
  // `export type` — those modifiers belong to the module-scope
  // block, which compiles to a plain ES module the consumers can
  // pull type imports from.
  export interface ContextItem {
    kind: 'item';
    label: string;
    shortcut?: string;
    danger?: boolean;
    disabled?: boolean;
    action: () => void;
  }
  export interface ContextDivider {
    kind: 'divider';
  }
  export type ContextEntry = ContextItem | ContextDivider;
</script>

<script lang="ts">
  // ContextMenu — VSCode-style right-click popover. The host component
  // suppresses the browser's native context menu via `oncontextmenu` +
  // calls `open(x, y, items)` on this component to render our menu at
  // the cursor position.
  //
  // Items are flat (no nested submenus yet — V0.9 once we need them
  // for File Explorer's New > File/Folder/Project). Each item carries
  // a label, optional shortcut hint, and an action ; a `divider`
  // entry renders as a 1 px separator.

  import { onMount, onDestroy } from 'svelte';

  let visible = $state(false);
  let x = $state(0);
  let y = $state(0);
  let items = $state<ContextEntry[]>([]);

  // Expose imperative open/close so a host component can drive this
  // without props plumbing. Svelte 5 lets us $export functions via
  // `bind:this`.
  export function open(px: number, py: number, entries: ContextEntry[]) {
    items = entries;
    visible = true;
    // Pin to the cursor + clamp inside the viewport so the menu
    // doesn't spill off-screen on edge clicks.
    requestAnimationFrame(() => {
      const w = 240, h = entries.length * 28 + 8;
      const vw = window.innerWidth, vh = window.innerHeight;
      x = Math.min(px, vw - w - 8);
      y = Math.min(py, vh - h - 8);
    });
  }
  export function close() {
    visible = false;
  }

  function onGlobalClick(ev: MouseEvent) {
    if (!visible) return;
    const root = document.getElementById('weft-loom-context-menu');
    if (root && root.contains(ev.target as Node)) return;
    close();
  }
  function onEsc(ev: KeyboardEvent) {
    if (ev.key === 'Escape') close();
  }
  onMount(() => {
    document.addEventListener('mousedown', onGlobalClick);
    document.addEventListener('keydown', onEsc);
  });
  onDestroy(() => {
    document.removeEventListener('mousedown', onGlobalClick);
    document.removeEventListener('keydown', onEsc);
  });
</script>

{#if visible}
  <div
    id="weft-loom-context-menu"
    class="fixed z-[1000] min-w-56 bg-base-100 border border-base-300 rounded-md shadow-xl py-1 text-xs select-none"
    style="left: {x}px; top: {y}px"
    role="menu"
    aria-label="Context menu"
  >
    {#each items as it}
      {#if it.kind === 'divider'}
        <hr class="my-1 border-base-300" />
      {:else}
        <button
          type="button"
          class="w-full flex items-center justify-between px-3 py-1 hover:bg-base-200 text-left disabled:opacity-40 disabled:cursor-not-allowed"
          class:text-error={it.danger}
          disabled={it.disabled}
          onclick={() => { if (!it.disabled) { it.action(); close(); } }}
        >
          <span>{it.label}</span>
          {#if it.shortcut}
            <span class="text-[10px] opacity-60 font-mono ml-4">{it.shortcut}</span>
          {/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}
