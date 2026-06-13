<script lang="ts">
  // BibliographyPanel — second floating-action button in the
  // LaTeX-editor cluster (alongside the Σ symbol palette). Browses
  // every .bib entry discovered by bibStore, filters live, and
  // inserts `\cite{key}` at the cursor on click.
  //
  // Beats Overleaf : Overleaf shows .bib files as raw source ; this
  // surfaces the same data as a structured, searchable list with
  // one-click insertion of the citation.

  import { bib } from '../bibStore.svelte';

  interface Props {
    visible: boolean;
  }
  let { visible }: Props = $props();

  let open = $state(false);
  let filter = $state('');

  // Force-refresh the bib cache whenever the user opens the panel
  // so newly-added .bib files appear without waiting on the 5s poll.
  $effect(() => {
    if (open) bib.refresh();
  });

  const filtered = $derived(() => {
    if (!filter) return bib.entries;
    const f = filter.toLowerCase();
    return bib.entries.filter(e =>
      e.key.toLowerCase().includes(f)
      || (e.fields.title ?? '').toLowerCase().includes(f)
      || (e.fields.author ?? '').toLowerCase().includes(f)
      || (e.fields.year ?? '').toLowerCase().includes(f),
    );
  });

  function insertCite(key: string) {
    const fn = (window as unknown as {
      weftLoomInsertAtCursor?: (s: string, cur?: number) => void;
    }).weftLoomInsertAtCursor;
    if (typeof fn !== 'function') return;
    fn('\\cite{' + key + '}');
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      open = false;
      e.preventDefault();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if visible}
  <div class="bib-panel">
    <button
      type="button"
      class="bib-fab btn btn-circle btn-secondary"
      title="Bibliography ({bib.entries.length})"
      onclick={() => (open = !open)}
      aria-label="Open bibliography browser"
      data-testid="bib-toggle"
    >
      <span class="text-xl">📚</span>
    </button>
    {#if open}
      <div class="bib-popover card bg-base-200 shadow-xl border border-base-300" data-testid="bib-panel">
        <div class="card-body p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-semibold">
              Bibliography
              <span class="opacity-50 text-xs">({bib.entries.length} entries)</span>
            </div>
            <button class="btn btn-ghost btn-xs" onclick={() => (open = false)} aria-label="Close">×</button>
          </div>
          <input
            type="text"
            placeholder="filter by key / title / author / year…"
            class="input input-bordered input-xs mb-2 w-full"
            bind:value={filter}
            data-testid="bib-filter"
          />
          <div class="bib-list">
            {#each filtered() as e (e.key)}
              <button
                type="button"
                class="bib-entry"
                onclick={() => insertCite(e.key)}
                title={'Insert \\cite{' + e.key + '}'}
                data-testid="bib-entry"
                data-key={e.key}
              >
                <div class="bib-key">{e.key}</div>
                <div class="bib-meta">
                  <span class="opacity-60">{e.type}</span>
                  {#if e.fields.year}<span class="opacity-60">· {e.fields.year}</span>{/if}
                  {#if e.fields.author}
                    <span class="opacity-80 truncate">{e.fields.author}</span>
                  {/if}
                </div>
                {#if e.fields.title}
                  <div class="bib-title">{e.fields.title}</div>
                {/if}
              </button>
            {/each}
            {#if filtered().length === 0}
              <div class="opacity-50 text-xs p-2">
                {#if bib.entries.length === 0}
                  No .bib files in this project. Drop a <code>.bib</code> file in the file
                  explorer and entries will appear here automatically.
                {:else}
                  No entries match "{filter}".
                {/if}
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .bib-panel {
    position: absolute;
    right: 1.5rem;
    bottom: 5.5rem;
    z-index: 30;
  }
  .bib-fab {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  }
  .bib-popover {
    position: absolute;
    right: 0;
    bottom: 4rem;
    width: 26rem;
    max-height: 32rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .bib-popover :global(.card-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .bib-list {
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .bib-entry {
    display: block;
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: rgba(0, 0, 0, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.08);
    cursor: pointer;
    transition: background 0.1s;
  }
  .bib-entry:hover {
    background: rgba(0, 100, 200, 0.08);
    border-color: rgba(0, 100, 200, 0.4);
  }
  .bib-key {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .bib-meta {
    font-size: 0.7rem;
    display: flex;
    gap: 0.4rem;
    margin-top: 0.1rem;
  }
  .bib-title {
    font-size: 0.75rem;
    margin-top: 0.15rem;
    font-style: italic;
  }
</style>
