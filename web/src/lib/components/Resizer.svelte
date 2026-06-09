<script lang="ts">
  // Resizer — a 6px-wide draggable column-separator. Drags update a
  // `splitPct` two-way binding (0-100) that the parent uses to set
  // flex-basis on the editor + preview panes. Persisted to localStorage
  // so the layout sticks across reloads.
  import { onDestroy } from 'svelte';

  interface Props {
    splitPct: number;
    storageKey?: string;
    minPct?: number;
    maxPct?: number;
  }

  let {
    splitPct = $bindable(),
    storageKey,
    minPct = 15,
    maxPct = 85,
  }: Props = $props();

  let dragging = $state(false);

  function start(ev: MouseEvent) {
    ev.preventDefault();
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', end);
  }

  function move(ev: MouseEvent) {
    if (!dragging) return;
    // Compute the new split as a percent of the viewport. We assume
    // the split runs across the full window width ; the parent's
    // main is flex-1 horizontal so this is true to within a sidebar
    // width — close enough for a UX-driven resize.
    const pct = (ev.clientX / window.innerWidth) * 100;
    const clamped = Math.max(minPct, Math.min(maxPct, pct));
    splitPct = clamped;
  }

  function end() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', end);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, String(splitPct));
      } catch {
        /* localStorage full or denied — silently ignore */
      }
    }
  }

  onDestroy(end);
</script>

<div
  role="separator"
  aria-orientation="vertical"
  tabindex="0"
  class="w-1.5 cursor-col-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
  class:bg-primary={dragging}
  onmousedown={start}
></div>
