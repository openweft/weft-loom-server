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
  import { logError } from '../logbus';
  import { settings } from '../settings.svelte';
  import BibStylePicker from './BibStylePicker.svelte';
  import { formatBibliographystyleLine } from '../bibStyles';
  import { bibFromDoi, zoteroSync, readFile, writeFile } from '../api';

  interface Props {
    visible: boolean;
    project: string;
  }
  let { visible, project }: Props = $props();

  let open = $state(false);
  let filter = $state('');
  // DOI import sub-modal state. V0.11 : paste a DOI URL, click
  // Fetch, the server resolves via doi.org content-negotiation +
  // appends to refs.bib.
  let doiOpen = $state(false);
  let doiInput = $state('');
  let doiBusy = $state(false);
  let doiError = $state<string | undefined>();
  let doiResult = $state<{ entry: string; target: string } | undefined>();

  // Zotero sync state. The credentials live in the SettingsPanel ;
  // this button is enabled when both are non-empty. On click we POST
  // to /api/projects/<p>/zotero/sync, receive raw BibTeX, append it
  // to refs.bib via the file API.
  let zoteroBusy = $state(false);
  let zoteroError = $state<string | undefined>();
  let zoteroResult = $state<{ count: number; bytes: number } | undefined>();

  // V0.14 : .bst style picker. Insert via window event the editor
  // can listen to (or fallback to clipboard).
  let stylePickerOpen = $state(false);
  let currentStyle = $state<string | undefined>(undefined);
  function pickStyle(name: string) {
    currentStyle = name;
    stylePickerOpen = false;
    const line = formatBibliographystyleLine(name);
    window.dispatchEvent(new CustomEvent('weft-loom:insert-line', { detail: { text: line } }));
  }

  // Rough entry counter : count "@<type>{" occurrences in BibTeX.
  // Good enough for a status banner — the user just needs the order
  // of magnitude, not a bibtex-parser-quality number.
  function countBibEntries(text: string): number {
    const m = text.match(/^@[a-zA-Z]+\s*\{/gm);
    return m ? m.length : 0;
  }

  async function syncZotero() {
    const userId = settings.current.zoteroUserId.trim();
    const apiKey = settings.current.zoteroApiKey.trim();
    if (!userId || !apiKey || zoteroBusy) return;
    zoteroBusy = true;
    zoteroError = undefined;
    zoteroResult = undefined;
    try {
      // 1. Pull the BibTeX bytes from the server-side relay.
      const incoming = await zoteroSync(project, userId, apiKey);
      // 2. Read the existing refs.bib (404 = file doesn't exist yet,
      //    we'll create it on write).
      let existing = '';
      try {
        existing = await readFile(project, 'refs.bib');
      } catch {
        // No refs.bib yet — writeFile will create it.
      }
      // 3. Concatenate + ensure a separating newline so we don't
      //    fuse the last existing entry with the first incoming one.
      let combined = existing;
      if (combined.length > 0 && !combined.endsWith('\n')) combined += '\n';
      combined += incoming;
      // 4. Write the combined file back.
      await writeFile(project, 'refs.bib', combined, 'application/octet-stream');
      zoteroResult = { count: countBibEntries(incoming), bytes: incoming.length };
      void bib.refresh();
    } catch (e) {
      zoteroError = e instanceof Error ? e.message : String(e);
      logError('bib', 'zotero-sync-failed', e);
    } finally {
      zoteroBusy = false;
    }
  }

  async function importDOI() {
    if (!doiInput.trim() || doiBusy) return;
    doiBusy = true;
    doiError = undefined;
    doiResult = undefined;
    try {
      doiResult = await bibFromDoi(project, doiInput.trim());
      // Refresh the bib cache so the new entry surfaces in the list
      // without waiting on the next poll tick.
      void bib.refresh();
    } catch (e) {
      doiError = e instanceof Error ? e.message : String(e);
      logError('bib', 'doi-import-failed', e);
    } finally {
      doiBusy = false;
    }
  }

  function resetDOI() {
    doiInput = '';
    doiResult = undefined;
    doiError = undefined;
    doiBusy = false;
  }

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

  // External toggle : the Editor toolbar dispatches
  // `weft-loom:toggle-bib` to flip the popover without needing a
  // FAB. Internal FAB is now hidden ; this listener is the only
  // open-trigger.
  $effect(() => {
    const handler = () => { open = !open; };
    window.addEventListener('weft-loom:toggle-bib', handler);
    return () => window.removeEventListener('weft-loom:toggle-bib', handler);
  });
</script>

<svelte:window onkeydown={onKey} />

{#if visible}
  <div class="bib-panel">
    {#if open}
      <div class="bib-popover card bg-base-200 shadow-xl border border-base-300" data-testid="bib-panel">
        <div class="card-body p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-semibold">
              Bibliography
              <span class="opacity-50 text-xs">({bib.entries.length} entries)</span>
            </div>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="btn btn-primary btn-xs"
                onclick={() => { doiOpen = true; resetDOI(); }}
                title="Import a citation from a DOI URL"
                aria-label="Import from DOI"
                data-testid="bib-doi-open"
              >+ DOI</button>
              <button
                type="button"
                class="btn btn-secondary btn-xs"
                onclick={() => void syncZotero()}
                disabled={zoteroBusy || !settings.current.zoteroUserId.trim() || !settings.current.zoteroApiKey.trim()}
                title={!settings.current.zoteroUserId.trim() || !settings.current.zoteroApiKey.trim()
                  ? 'Set your Zotero userID + API key in Settings → Integrations first'
                  : 'Fetch all items from your Zotero library + append to refs.bib'}
                aria-label="Sync from Zotero"
                data-testid="bib-zotero-sync"
              >{zoteroBusy ? 'Syncing…' : '↻ Zotero'}</button>
              <button class="btn btn-ghost btn-xs" onclick={() => (open = false)} aria-label="Close">×</button>
            </div>
          </div>
          {#if doiOpen}
            <div class="doi-import border border-base-300 rounded p-2 mb-2 bg-base-100" data-testid="bib-doi-panel">
              <div class="text-[10px] opacity-60 mb-1">
                Paste a DOI URL (or bare DOI) ; the server fetches the BibTeX
                entry from doi.org + appends it to your refs.bib.
              </div>
              <input
                type="text"
                placeholder="10.1145/3676146 or https://doi.org/10.1145/3676146"
                class="input input-bordered input-xs w-full"
                bind:value={doiInput}
                disabled={doiBusy}
                data-testid="bib-doi-input"
                onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void importDOI(); } }}
              />
              <div class="flex gap-1 mt-1">
                <button
                  class="btn btn-primary btn-xs"
                  onclick={() => void importDOI()}
                  disabled={doiBusy || !doiInput.trim()}
                  data-testid="bib-doi-fetch"
                >{doiBusy ? 'Fetching…' : 'Fetch + add'}</button>
                <button
                  class="btn btn-ghost btn-xs"
                  onclick={() => { doiOpen = false; resetDOI(); }}
                >Cancel</button>
              </div>
              {#if doiError}
                <div class="text-error text-xs mt-1" data-testid="bib-doi-error">{doiError}</div>
              {/if}
              {#if doiResult}
                <div class="text-success text-xs mt-1" data-testid="bib-doi-success">
                  Added to <code>{doiResult.target}</code>
                </div>
                <pre class="text-[10px] mt-1 max-h-32 overflow-auto bg-base-200 p-1 rounded">{doiResult.entry}</pre>
              {/if}
            </div>
          {/if}
          {#if zoteroError}
            <div class="text-error text-xs mb-2" data-testid="bib-zotero-error">
              Zotero sync : {zoteroError}
            </div>
          {/if}
          {#if zoteroResult}
            <div class="text-success text-xs mb-2" data-testid="bib-zotero-success">
              Imported {zoteroResult.count} entr{zoteroResult.count === 1 ? 'y' : 'ies'}
              from Zotero ({zoteroResult.bytes} bytes appended to <code>refs.bib</code>).
            </div>
          {/if}
          <div class="flex items-center gap-2 mb-2 text-xs">
            <span class="opacity-70">Style:</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs font-mono"
              onclick={() => (stylePickerOpen = !stylePickerOpen)}
              data-testid="bib-style-open"
            >{currentStyle ?? 'choose…'}</button>
          </div>
          {#if stylePickerOpen}
            <BibStylePicker value={currentStyle} onPick={pickStyle} onClose={() => (stylePickerOpen = false)} />
          {/if}
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
    right: 1rem;
    top: 3rem;
    z-index: 30;
  }
  .bib-popover {
    position: absolute;
    right: 0;
    top: 0;
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
