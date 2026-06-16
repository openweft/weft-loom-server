<script lang="ts">
  // BibStylePicker — categorised dropdown that lists every BibTeX
  // style in BIB_STYLES. Click → onPick(name). The host (typically
  // BibliographyPanel) decides what to do with the picked style :
  // splice a `\bibliographystyle{...}` line into the active .tex,
  // copy it to the clipboard, etc.
  //
  // Layout mirrors LatexSymbolPalette : card + filter input + tabs
  // (one per family) + a vertical list of styles.

  import { BIB_STYLES, type BibStyle, type BibStyleFamily } from '../bibStyles';

  interface Props {
    value?: string;
    onPick: (name: string) => void;
    onClose?: () => void;
  }
  let { value, onPick, onClose }: Props = $props();

  // Families, in display order. We surface every family present in
  // BIB_STYLES so the picker still works if the catalogue grows.
  const FAMILIES: Array<{ id: BibStyleFamily; name: string }> = [
    { id: 'plain',   name: 'Standard' },
    { id: 'natbib',  name: 'natbib' },
    { id: 'ieee',    name: 'IEEE' },
    { id: 'acm',     name: 'ACM' },
    { id: 'chicago', name: 'Chicago / Harvard' },
    { id: 'other',   name: 'Other' },
  ];

  let filter = $state('');

  // Build the grouped list, filtered by the search box. Case-
  // insensitive match against name / label / description.
  const grouped = $derived(() => {
    const f = filter.trim().toLowerCase();
    const match = (s: BibStyle) => {
      if (!f) return true;
      return s.name.toLowerCase().includes(f)
        || s.label.toLowerCase().includes(f)
        || s.description.toLowerCase().includes(f);
    };
    return FAMILIES.map((fam) => ({
      ...fam,
      entries: BIB_STYLES.filter((s) => s.family === fam.id && match(s)),
    })).filter((g) => g.entries.length > 0);
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && onClose) {
      onClose();
      e.preventDefault();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="bib-style-picker card bg-base-200 shadow-xl border border-base-300" data-testid="bib-style-picker">
  <div class="card-body p-3">
    <div class="flex items-center justify-between mb-2">
      <div class="text-sm font-semibold">Bibliography style</div>
      {#if onClose}
        <button class="btn btn-ghost btn-xs" onclick={() => onClose && onClose()} aria-label="Close picker">×</button>
      {/if}
    </div>
    <input
      type="text"
      placeholder="filter by name / family / description…"
      class="input input-bordered input-xs mb-2 w-full"
      bind:value={filter}
      data-testid="bib-style-filter"
    />
    <div class="picker-list">
      {#each grouped() as g (g.id)}
        <div class="group" data-testid={'bib-style-group-' + g.id}>
          <div class="group-name">{g.name}</div>
          {#each g.entries as s (s.name)}
            <button
              type="button"
              class="entry"
              class:entry-active={s.name === value}
              onclick={() => onPick(s.name)}
              title={'\\bibliographystyle{' + s.name + '}'}
              data-testid="bib-style-entry"
              data-name={s.name}
            >
              <div class="entry-row">
                <span class="entry-name">{s.label}</span>
                {#if s.name === value}
                  <span class="badge badge-primary badge-xs">current</span>
                {/if}
              </div>
              <div class="entry-desc">{s.description}</div>
            </button>
          {/each}
        </div>
      {/each}
      {#if grouped().length === 0}
        <div class="opacity-50 text-xs p-2" data-testid="bib-style-empty">
          No styles match "{filter}".
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .bib-style-picker {
    width: 24rem;
    max-height: 30rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .bib-style-picker :global(.card-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .picker-list {
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .group-name {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    padding: 0 0.2rem;
  }
  .entry {
    display: block;
    text-align: left;
    padding: 0.4rem 0.55rem;
    border-radius: 0.4rem;
    background: rgba(0, 0, 0, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.08);
    cursor: pointer;
    transition: background 0.1s;
  }
  .entry:hover {
    background: rgba(0, 100, 200, 0.08);
    border-color: rgba(0, 100, 200, 0.4);
  }
  .entry-active {
    background: rgba(0, 100, 200, 0.16);
    border-color: rgba(0, 100, 200, 0.6);
  }
  .entry-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .entry-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .entry-desc {
    font-size: 0.7rem;
    opacity: 0.75;
    margin-top: 0.15rem;
  }
</style>
