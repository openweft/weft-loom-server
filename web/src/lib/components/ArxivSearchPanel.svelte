<script lang="ts">
  // ArxivSearchPanel — floating popover that queries the arXiv.org
  // Atom-XML API (via /api/arxiv/search server-side proxy ; CORS
  // would block a direct browser fetch) + appends a generated
  // BibTeX entry to refs.bib on click.
  //
  // Beats Overleaf : Overleaf has no arXiv integration. Here, search
  // → one-click → entry in your bibliography → \cite picker refresh.
  //
  // The owner mounts this with `visible={true}` ; the popover itself
  // is toggled by a `weft-loom:toggle-arxiv` window event (mirrors
  // the BibliographyPanel pattern).

  import { readFile, writeFile, arxivSearch, type ArxivEntry } from '../api';
  import { bib } from '../bibStore.svelte';
  import { logError } from '../logbus';

  interface Props {
    visible: boolean;
    project: string;
    onClose?: () => void;
  }
  let { visible, project, onClose }: Props = $props();

  let open = $state(false);
  let query = $state('');
  let busy = $state(false);
  let error = $state<string | undefined>();
  let entries = $state<ArxivEntry[]>([]);
  let added = $state<Record<string, string>>({}); // arxiv id → bib key

  async function runSearch() {
    if (!query.trim() || busy) return;
    busy = true;
    error = undefined;
    entries = [];
    try {
      entries = await arxivSearch(query.trim(), 20);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      logError('arxiv', 'search-failed', e);
    } finally {
      busy = false;
    }
  }

  // Build a BibTeX key from the first-author surname + year. Strips
  // diacritics + non-ASCII + lowercases ; collisions get a "b", "c"…
  // suffix once we see the existing keys in bib.byKey.
  function buildKey(e: ArxivEntry): string {
    const first = e.authors[0] ?? 'anon';
    const parts = first.trim().split(/\s+/);
    const surname = parts[parts.length - 1] ?? 'anon';
    const ascii = surname
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining marks
      .replace(/[^a-zA-Z]/g, '')
      .toLowerCase() || 'anon';
    const base = ascii + (e.year || '');
    if (!bib.byKey.has(base)) return base;
    for (let i = 1; i < 26; i++) {
      const candidate = base + String.fromCharCode('a'.charCodeAt(0) + i);
      if (!bib.byKey.has(candidate)) return candidate;
    }
    return base + '_' + e.id.replace(/[^a-z0-9]/gi, '');
  }

  function buildBibtex(e: ArxivEntry, key: string): string {
    const authors = e.authors.join(' and ');
    // arXiv pre-prints are conventionally @article with archivePrefix.
    // primaryClass mirrors the arXiv category (e.g. cs.LG).
    return [
      '@article{' + key + ',',
      '  author        = {' + authors + '},',
      '  title         = {' + e.title + '},',
      '  year          = {' + e.year + '},',
      '  eprint        = {' + e.id + '},',
      '  archivePrefix = {arXiv},',
      '  primaryClass  = {' + e.primaryCategory + '},',
      '}',
      '',
    ].join('\n');
  }

  async function addEntry(e: ArxivEntry) {
    if (added[e.id]) return;
    const key = buildKey(e);
    const entry = buildBibtex(e, key);
    try {
      let existing = '';
      try {
        existing = await readFile(project, 'refs.bib');
      } catch {
        // No refs.bib yet : writeFile creates it.
        existing = '';
      }
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      await writeFile(project, 'refs.bib', existing + sep + entry, 'application/x-bibtex');
      added = { ...added, [e.id]: key };
      // Prime the bib cache so the new entry surfaces in the
      // \cite picker without waiting on the 30 s poll.
      void bib.refresh();
      // The BibliographyPanel listens for this ; firing it makes
      // the cite picker pop with our freshly-added key already
      // visible.
      window.dispatchEvent(new CustomEvent('weft-loom:toggle-bib'));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logError('arxiv', 'add-entry-failed', err);
    }
  }

  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape' && open) {
      open = false;
      onClose?.();
      ev.preventDefault();
    }
  }

  // External toggle : mirror BibliographyPanel's pattern.
  // A toolbar button dispatches `weft-loom:toggle-arxiv`.
  $effect(() => {
    const handler = () => { open = !open; };
    window.addEventListener('weft-loom:toggle-arxiv', handler);
    return () => window.removeEventListener('weft-loom:toggle-arxiv', handler);
  });
</script>

<svelte:window onkeydown={onKey} />

{#if visible}
  <div class="arxiv-panel">
    {#if open}
      <div class="arxiv-popover card bg-base-200 shadow-xl border border-base-300" data-testid="arxiv-panel">
        <div class="card-body p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-semibold">
              arXiv search
              {#if entries.length > 0}
                <span class="opacity-50 text-xs">({entries.length} results)</span>
              {/if}
            </div>
            <button
              class="btn btn-ghost btn-xs"
              onclick={() => { open = false; onClose?.(); }}
              aria-label="Close"
            >×</button>
          </div>
          <div class="flex gap-1 mb-2">
            <input
              type="text"
              placeholder="search arXiv (title, author, abstract)…"
              class="input input-bordered input-xs flex-1"
              bind:value={query}
              disabled={busy}
              data-testid="arxiv-input"
              autofocus
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(); } }}
            />
            <button
              class="btn btn-primary btn-xs"
              onclick={() => void runSearch()}
              disabled={busy || !query.trim()}
              data-testid="arxiv-search-btn"
            >{busy ? 'Searching…' : 'Search'}</button>
          </div>
          {#if error}
            <div class="text-error text-xs mb-2" data-testid="arxiv-error">{error}</div>
          {/if}
          <div class="arxiv-list">
            {#each entries as e (e.id)}
              <button
                type="button"
                class="arxiv-entry"
                onclick={() => void addEntry(e)}
                disabled={!!added[e.id]}
                title={added[e.id]
                  ? 'Added as ' + added[e.id]
                  : 'Add to refs.bib + open cite picker'}
                data-testid="arxiv-entry"
                data-id={e.id}
              >
                <div class="arxiv-meta">
                  <span class="arxiv-id">{e.id}</span>
                  {#if e.year}<span class="opacity-60">· {e.year}</span>{/if}
                  {#if e.primaryCategory}
                    <span class="opacity-60">· {e.primaryCategory}</span>
                  {/if}
                  {#if added[e.id]}
                    <span class="text-success">✓ {added[e.id]}</span>
                  {/if}
                </div>
                <div class="arxiv-title">{e.title}</div>
                {#if e.authors.length > 0}
                  <div class="arxiv-authors opacity-80 truncate">
                    {e.authors.join(', ')}
                  </div>
                {/if}
              </button>
            {/each}
            {#if entries.length === 0 && !busy && !error}
              <div class="opacity-50 text-xs p-2">
                Type a query above ; results from arXiv.org appear here.
                Click a row to add a BibTeX entry to <code>refs.bib</code>.
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .arxiv-panel {
    position: absolute;
    right: 1rem;
    top: 1rem;
    z-index: 30;
  }
  .arxiv-popover {
    position: absolute;
    right: 0;
    top: 0;
    width: 28rem;
    max-height: 36rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .arxiv-popover :global(.card-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .arxiv-list {
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .arxiv-entry {
    display: block;
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: rgba(0, 0, 0, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.08);
    cursor: pointer;
    transition: background 0.1s;
  }
  .arxiv-entry:hover:not(:disabled) {
    background: rgba(0, 100, 200, 0.08);
    border-color: rgba(0, 100, 200, 0.4);
  }
  .arxiv-entry:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .arxiv-id {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .arxiv-meta {
    font-size: 0.7rem;
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.15rem;
  }
  .arxiv-title {
    font-size: 0.8rem;
    font-weight: 600;
  }
  .arxiv-authors {
    font-size: 0.7rem;
    margin-top: 0.15rem;
    font-style: italic;
  }
</style>
