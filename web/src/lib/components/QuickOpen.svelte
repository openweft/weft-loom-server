<script lang="ts">
  // QuickOpen — VSCode-style Cmd+P file picker. Lists every file
  // in the current project, fuzzy-matches against the query, lets
  // the user navigate the result list with ↑ ↓ + Enter to open.
  //
  // The fuzzy scorer is hand-rolled (substring + char-order +
  // proximity bonuses) — good enough for project sizes we target
  // without pulling fuse.js or vscode-fuzzy.

  import { listFiles, type File } from '../api';
  import { iconForPath } from '../theme';

  interface Props {
    open: boolean;
    project: string;
    onClose: () => void;
    onOpen: (path: string) => void;
  }
  let { open = $bindable(), project, onClose, onOpen }: Props = $props();

  let files = $state<File[]>([]);
  let query = $state<string>('');
  let selectedIdx = $state<number>(0);
  let inputRef: HTMLInputElement | undefined = $state();

  async function refresh() {
    try {
      files = await listFiles(project);
    } catch { files = []; }
  }

  $effect(() => {
    if (open) {
      query = '';
      selectedIdx = 0;
      void refresh();
      setTimeout(() => inputRef?.focus(), 0);
    }
  });

  // Fuzzy scorer : returns -1 when no match, else a positive
  // score. Higher = better. Bonuses for : query chars appearing
  // in order, contiguous runs, matches on path-segment starts
  // (e.g. typing "mt" matches "main.tex" because m + t both hit
  // word starts).
  function score(needle: string, hay: string): number {
    if (!needle) return 1;
    const n = needle.toLowerCase();
    const h = hay.toLowerCase();
    let score = 0;
    let hi = 0;
    let lastHit = -2;
    for (let ni = 0; ni < n.length; ni++) {
      const c = n[ni];
      const next = h.indexOf(c, hi);
      if (next < 0) return -1;
      // Bonus for matching just after a separator (path component start).
      if (next === 0 || /[\/\-_. ]/.test(h[next - 1])) score += 4;
      // Bonus for contiguous match.
      if (next === lastHit + 1) score += 2;
      score += 1;
      lastHit = next;
      hi = next + 1;
    }
    // Penalise length so shorter paths float to the top.
    score -= Math.log(hay.length + 1);
    return score;
  }

  const ranked = $derived(() => {
    const cs = files
      .filter((f) => !f.dir && !f.path.startsWith('.weft-loom/') && !f.path.startsWith('.git/'))
      .map((f) => ({ f, s: score(query, f.path) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.f);
    return cs;
  });

  $effect(() => {
    // Re-clamp selectedIdx when the result list shrinks.
    const r = ranked();
    if (selectedIdx >= r.length) selectedIdx = Math.max(0, r.length - 1);
  });

  function commit() {
    const r = ranked();
    if (!r[selectedIdx]) return;
    onOpen(r[selectedIdx].path);
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
    <div class="bg-base-100 border border-base-300 rounded-md shadow-xl w-[560px] max-w-[90vw] overflow-hidden">
      <div class="px-3 py-2 border-b border-base-300 bg-base-200 flex items-center gap-2 text-xs">
        <span class="opacity-60">Quick open</span>
        <span class="ml-auto opacity-50 font-mono">↑↓ Enter · Esc</span>
      </div>
      <input
        bind:this={inputRef}
        type="text"
        bind:value={query}
        onkeydown={onKey}
        placeholder="Go to file…  (fuzzy match)"
        class="input input-sm w-full font-mono rounded-none border-0 focus:outline-none"
      />
      <ul class="max-h-[50vh] overflow-y-auto">
        {#if ranked().length === 0}
          <li class="px-3 py-4 text-xs opacity-50 italic">No matching file.</li>
        {/if}
        {#each ranked() as f, idx (f.path)}
          <li>
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-1 text-sm hover:bg-base-200 text-left"
              class:bg-base-300={idx === selectedIdx}
              onclick={() => { selectedIdx = idx; commit(); }}
              onmouseenter={() => (selectedIdx = idx)}
            >
              <span class="font-mono">{iconForPath(f.path)}</span>
              <span class="font-mono truncate">{f.path}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/if}
