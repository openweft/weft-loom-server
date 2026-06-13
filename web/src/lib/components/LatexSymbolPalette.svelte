<script lang="ts">
  // LatexSymbolPalette — floating-action button + popover that
  // surfaces the LaTeX symbol catalogue (Greek, operators, relations,
  // arrows, brackets, structures, environments). Click any glyph →
  // window.weftLoomInsertAtCursor splices the LaTeX command into the
  // currently-active CodeMirror view.
  //
  // The palette is visible only when the active file is .tex / .latex.

  import { CATEGORIES, type SymbolEntry } from '../latex_symbols';

  interface Props {
    visible: boolean;
  }
  let { visible }: Props = $props();

  let open = $state(false);
  let activeCat = $state(CATEGORIES[0].id);
  let filter = $state('');

  function insert(e: SymbolEntry) {
    const fn = (window as unknown as {
      weftLoomInsertAtCursor?: (s: string, cur?: number) => void;
    }).weftLoomInsertAtCursor;
    if (typeof fn !== 'function') return;
    fn(e.cmd, e.cursor);
  }

  const current = $derived(() => {
    const cat = CATEGORIES.find(c => c.id === activeCat) ?? CATEGORIES[0];
    if (!filter) return cat;
    const f = filter.toLowerCase();
    return {
      ...cat,
      entries: cat.entries.filter(e =>
        e.label.toLowerCase().includes(f)
        || e.cmd.toLowerCase().includes(f)
        || (e.tip ?? '').toLowerCase().includes(f),
      ),
    };
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      open = false;
      e.preventDefault();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if visible}
  <div class="latex-symbol-palette">
    <button
      type="button"
      class="palette-fab btn btn-circle btn-primary"
      title="LaTeX symbols (Σ)"
      onclick={() => (open = !open)}
      aria-label="Open LaTeX symbol palette"
      data-testid="latex-palette-toggle"
    >
      <span class="text-xl">∑</span>
    </button>
    {#if open}
      <div class="palette-panel card bg-base-200 shadow-xl border border-base-300" data-testid="latex-palette-panel">
        <div class="card-body p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-semibold">LaTeX symbols</div>
            <button class="btn btn-ghost btn-xs" onclick={() => (open = false)} aria-label="Close palette">×</button>
          </div>
          <div class="tabs tabs-boxed mb-2 flex-wrap">
            {#each CATEGORIES as c}
              <button
                class="tab tab-sm"
                class:tab-active={c.id === activeCat}
                onclick={() => (activeCat = c.id)}
                data-testid={'latex-palette-cat-' + c.id}
              >
                {c.name}
              </button>
            {/each}
          </div>
          <input
            type="text"
            placeholder="filter…"
            class="input input-bordered input-xs mb-2 w-full"
            bind:value={filter}
            data-testid="latex-palette-filter"
          />
          <div
            class="palette-grid"
            style="grid-template-columns: repeat({current().cols}, minmax(0, 1fr));"
            data-testid="latex-palette-grid"
          >
            {#each current().entries as e (e.cmd)}
              <button
                type="button"
                class="palette-cell btn btn-ghost btn-sm h-12 normal-case font-normal"
                title={e.tip ?? e.cmd}
                onclick={() => insert(e)}
                data-cmd={e.cmd}
                data-testid="latex-palette-cell"
              >
                <span class="palette-glyph">{e.label}</span>
              </button>
            {/each}
            {#if current().entries.length === 0}
              <div class="opacity-50 text-xs col-span-full">no symbols match</div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .latex-symbol-palette {
    position: absolute;
    right: 1.5rem;
    bottom: 1.5rem;
    z-index: 30;
  }
  .palette-fab {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  }
  .palette-panel {
    position: absolute;
    right: 0;
    bottom: 4.5rem;
    width: 22rem;
    max-height: 26rem;
    overflow-y: auto;
  }
  .palette-grid {
    display: grid;
    gap: 0.25rem;
  }
  .palette-glyph {
    font-size: 1.1rem;
    line-height: 1;
  }
</style>
