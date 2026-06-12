<script lang="ts">
  // CommandPalette — VSCode-style Cmd+Shift+P. Mirrors the QuickOpen
  // shell but pivots on a registered command list rather than the
  // project files. The command list is owned by App.svelte so each
  // command can capture the closures it needs (compile, toggle shell,
  // settings, etc.) ; this component is the input + ranked render
  // pipeline.
  //
  // Fuzzy scorer is the same hand-rolled one used in QuickOpen — see
  // QuickOpen.svelte for the rationale.

  export interface Command {
    id: string;
    label: string;
    detail?: string;
    shortcut?: string;
    action: () => void;
  }

  interface Props {
    open: boolean;
    commands: Command[];
    onClose: () => void;
  }
  let { open = $bindable(), commands, onClose }: Props = $props();

  let query = $state<string>('');
  let selectedIdx = $state<number>(0);
  let inputRef: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (open) {
      query = '';
      selectedIdx = 0;
      setTimeout(() => inputRef?.focus(), 0);
    }
  });

  function score(needle: string, hay: string): number {
    if (!needle) return 1;
    const n = needle.toLowerCase();
    const h = hay.toLowerCase();
    let score = 0;
    let hi = 0;
    let lastHit = -2;
    for (let ni = 0; ni < n.length; ni++) {
      const next = h.indexOf(n[ni], hi);
      if (next < 0) return -1;
      if (next === 0 || /[\s\-_]/.test(h[next - 1])) score += 4;
      if (next === lastHit + 1) score += 2;
      score += 1;
      lastHit = next;
      hi = next + 1;
    }
    return score - Math.log(hay.length + 1);
  }

  const ranked = $derived(() => {
    return commands
      .map((c) => ({ c, s: score(query, c.label + ' ' + (c.detail ?? '')) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.c);
  });

  $effect(() => {
    const r = ranked();
    if (selectedIdx >= r.length) selectedIdx = Math.max(0, r.length - 1);
  });

  function commit() {
    const c = ranked()[selectedIdx];
    if (!c) return;
    c.action();
    close();
  }
  function close() {
    open = false;
    onClose();
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') { close(); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); return; }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      selectedIdx = Math.min(ranked().length - 1, selectedIdx + 1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      selectedIdx = Math.max(0, selectedIdx - 1);
      return;
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-[1000] flex items-start justify-center pt-[10vh] bg-black/30"
    onclick={(e) => { if (e.target === e.currentTarget) close(); }}
    role="presentation"
  >
    <div class="bg-base-100 border border-base-300 rounded-md shadow-xl w-[640px] max-w-[90vw] overflow-hidden">
      <div class="px-3 py-2 border-b border-base-300 bg-base-200 flex items-center gap-2 text-xs">
        <span class="opacity-60">Command Palette</span>
        <span class="ml-auto opacity-50 font-mono">↑↓ Enter · Esc</span>
      </div>
      <input
        bind:this={inputRef}
        type="text"
        bind:value={query}
        onkeydown={onKey}
        placeholder="Type a command…"
        class="input input-sm w-full font-mono rounded-none border-0 focus:outline-none"
      />
      <ul class="max-h-[50vh] overflow-y-auto">
        {#if ranked().length === 0}
          <li class="px-3 py-4 text-xs opacity-50 italic">No matching command.</li>
        {/if}
        {#each ranked() as c, idx (c.id)}
          <li>
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200 text-left"
              class:bg-base-300={idx === selectedIdx}
              onclick={() => { selectedIdx = idx; commit(); }}
              onmouseenter={() => (selectedIdx = idx)}
            >
              <span class="flex-1">
                <span class="font-medium">{c.label}</span>
                {#if c.detail}
                  <span class="ml-2 text-xs opacity-50">{c.detail}</span>
                {/if}
              </span>
              {#if c.shortcut}
                <span class="text-[10px] opacity-60 font-mono">{c.shortcut}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/if}
