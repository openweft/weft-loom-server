<script lang="ts">
  // SnippetsPanel — per-project Snippets manager (Overleaf "Tags &
  // Snippets" parity). Lists user-defined snippets persisted under
  // .weft-loom/snippets.json + the curated default table from
  // snippets.ts. Click → inserts `body` at the cursor via the same
  // `weft-loom:insert-line` event the editor listens to (mirrors
  // BibliographyPanel's pickStyle path).
  //
  // Toggle from outside via window event `weft-loom:toggle-snippets`
  // (the Editor toolbar dispatches it ; matches toggle-bib).
  //
  // Layout follows BibStylePicker + BibliographyPanel : floating
  // popover, header + filter + categorised list, with a "+ New
  // snippet" form folding out on demand. User entries get edit +
  // delete buttons ; curated entries are read-only.
  //
  // Empty / error states are kept loud but inert : failed loads show a
  // banner, the panel still renders the shipped defaults so the user
  // can keep working.

  import { listSnippets, upsertSnippet, deleteSnippet, type UserSnippet } from '../api';
  import { logError } from '../logbus';
  import { shippedSnippets, type SnippetDef } from '../snippets';

  interface Props {
    visible: boolean;
    project: string;
  }
  let { visible, project }: Props = $props();

  let open = $state(false);
  let filter = $state('');
  let userSnippets = $state<UserSnippet[]>([]);
  let loadError = $state<string | undefined>();
  let busy = $state(false);

  // "+ New snippet" form state. Editing an existing entry reuses the
  // same form ; `editingId` distinguishes create vs replace.
  let formOpen = $state(false);
  let editingId = $state<string | undefined>();
  let formLabel = $state('');
  let formBody = $state('');
  let formHotkey = $state('');
  let formScope = $state('');
  let formError = $state<string | undefined>();

  async function reload() {
    try {
      userSnippets = await listSnippets(project);
      loadError = undefined;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      logError('snippets', 'list-failed', e);
    }
  }

  // Refresh whenever the panel opens — picks up changes from other
  // tabs / collaborators without polling.
  $effect(() => {
    if (open) void reload();
  });

  // External toggle : Editor toolbar dispatches
  // `weft-loom:toggle-snippets` — flips `open` so the popover behaves
  // like the bibliography one.
  $effect(() => {
    const handler = () => { open = !open; };
    window.addEventListener('weft-loom:toggle-snippets', handler);
    return () => window.removeEventListener('weft-loom:toggle-snippets', handler);
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      open = false;
      e.preventDefault();
    }
  }

  // Insert via the global event listener installed in App.svelte —
  // same plumbing BibStylePicker uses. Falls back to clipboard if the
  // editor isn't mounted (e.g. user opened the panel on the file
  // tree).
  function insertSnippet(body: string) {
    window.dispatchEvent(new CustomEvent('weft-loom:insert-line', { detail: { text: body } }));
  }

  function resetForm() {
    editingId = undefined;
    formLabel = '';
    formBody = '';
    formHotkey = '';
    formScope = '';
    formError = undefined;
  }

  function openNewForm() {
    resetForm();
    formOpen = true;
  }

  function openEditForm(u: UserSnippet) {
    editingId = u.id;
    formLabel = u.label;
    formBody = u.body;
    formHotkey = u.hotkey ?? '';
    formScope = u.scope ?? '';
    formError = undefined;
    formOpen = true;
  }

  async function saveForm() {
    const label = formLabel.trim();
    const body = formBody;
    if (!label) { formError = 'Label is required'; return; }
    if (!body.trim()) { formError = 'Body is required'; return; }
    busy = true;
    formError = undefined;
    try {
      await upsertSnippet(project, {
        id: editingId,
        label,
        body,
        hotkey: formHotkey.trim() || undefined,
        scope: formScope.trim() || undefined,
      });
      await reload();
      formOpen = false;
      resetForm();
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e);
      logError('snippets', 'upsert-failed', e);
    } finally {
      busy = false;
    }
  }

  async function removeSnippet(u: UserSnippet) {
    if (busy) return;
    busy = true;
    try {
      await deleteSnippet(project, u.id);
      await reload();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      logError('snippets', 'delete-failed', e);
    } finally {
      busy = false;
    }
  }

  // Filtered views — keyed off `filter` so the user can scope by label
  // / body / hotkey across both groups at once.
  const matchesFilter = (text: string) => {
    if (!filter.trim()) return true;
    return text.toLowerCase().includes(filter.trim().toLowerCase());
  };

  const filteredUser = $derived(() =>
    userSnippets.filter((u) =>
      matchesFilter(u.label) || matchesFilter(u.body) || matchesFilter(u.hotkey ?? '') || matchesFilter(u.scope ?? ''),
    ),
  );

  const filteredShipped = $derived(() => {
    const all: SnippetDef[] = [...shippedSnippets()];
    return all.filter((s) =>
      matchesFilter(s.label) || matchesFilter(s.template) || matchesFilter(s.detail ?? '') || matchesFilter(s.langs ?? ''),
    );
  });
</script>

<svelte:window onkeydown={onKey} />

{#if visible}
  <div class="snip-panel">
    {#if open}
      <div class="snip-popover card bg-base-200 shadow-xl border border-base-300" data-testid="snippets-panel">
        <div class="card-body p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-semibold">
              Snippets
              <span class="opacity-50 text-xs">({userSnippets.length} user · {shippedSnippets().length} built-in)</span>
            </div>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="btn btn-primary btn-xs"
                onclick={openNewForm}
                title="Define a new snippet"
                aria-label="New snippet"
                data-testid="snippets-new"
              >+ New</button>
              <button class="btn btn-ghost btn-xs" onclick={() => (open = false)} aria-label="Close">×</button>
            </div>
          </div>
          {#if loadError}
            <div class="text-error text-xs mb-2" data-testid="snippets-load-error">{loadError}</div>
          {/if}
          {#if formOpen}
            <div class="snip-form border border-base-300 rounded p-2 mb-2 bg-base-100" data-testid="snippets-form">
              <div class="text-[10px] opacity-60 mb-1">
                {editingId ? 'Edit existing snippet' : 'New snippet'} ;
                stored in <code>.weft-loom/snippets.json</code>.
              </div>
              <input
                type="text"
                placeholder="Label (e.g. My preamble)"
                class="input input-bordered input-xs w-full mb-1"
                bind:value={formLabel}
                disabled={busy}
                data-testid="snippets-form-label"
              />
              <textarea
                placeholder="Body — verbatim text inserted at the cursor"
                class="textarea textarea-bordered textarea-xs w-full mb-1 font-mono"
                rows="4"
                bind:value={formBody}
                disabled={busy}
                data-testid="snippets-form-body"
              ></textarea>
              <div class="flex gap-1 mb-1">
                <input
                  type="text"
                  placeholder="Hotkey hint (display-only)"
                  class="input input-bordered input-xs flex-1"
                  bind:value={formHotkey}
                  disabled={busy}
                  data-testid="snippets-form-hotkey"
                />
                <input
                  type="text"
                  placeholder="Scope (e.g. latex)"
                  class="input input-bordered input-xs flex-1"
                  bind:value={formScope}
                  disabled={busy}
                  data-testid="snippets-form-scope"
                />
              </div>
              <div class="flex gap-1">
                <button
                  class="btn btn-primary btn-xs"
                  onclick={() => void saveForm()}
                  disabled={busy || !formLabel.trim() || !formBody.trim()}
                  data-testid="snippets-form-save"
                >{busy ? 'Saving…' : (editingId ? 'Save' : 'Create')}</button>
                <button
                  class="btn btn-ghost btn-xs"
                  onclick={() => { formOpen = false; resetForm(); }}
                  disabled={busy}
                >Cancel</button>
              </div>
              {#if formError}
                <div class="text-error text-xs mt-1" data-testid="snippets-form-error">{formError}</div>
              {/if}
            </div>
          {/if}
          <input
            type="text"
            placeholder="filter by label / body / hotkey / scope…"
            class="input input-bordered input-xs mb-2 w-full"
            bind:value={filter}
            data-testid="snippets-filter"
          />
          <div class="snip-list">
            <div class="group" data-testid="snippets-group-user">
              <div class="group-name">Your snippets</div>
              {#each filteredUser() as u (u.id)}
                <div class="entry">
                  <button
                    type="button"
                    class="entry-click"
                    onclick={() => insertSnippet(u.body)}
                    title="Insert this snippet at the cursor"
                    data-testid="snippets-user-entry"
                    data-id={u.id}
                  >
                    <div class="entry-row">
                      <span class="entry-name">{u.label}</span>
                      {#if u.hotkey}<span class="badge badge-ghost badge-xs">{u.hotkey}</span>{/if}
                      {#if u.scope}<span class="badge badge-ghost badge-xs">{u.scope}</span>{/if}
                    </div>
                    <pre class="entry-body">{u.body}</pre>
                  </button>
                  <div class="entry-actions">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs"
                      onclick={() => openEditForm(u)}
                      disabled={busy}
                      aria-label="Edit snippet"
                      data-testid="snippets-edit"
                    >✎</button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs text-error"
                      onclick={() => void removeSnippet(u)}
                      disabled={busy}
                      aria-label="Delete snippet"
                      data-testid="snippets-delete"
                    >🗑</button>
                  </div>
                </div>
              {/each}
              {#if filteredUser().length === 0}
                <div class="opacity-50 text-xs p-2" data-testid="snippets-user-empty">
                  {#if userSnippets.length === 0}
                    No user snippets yet. Click <span class="kbd kbd-xs">+ New</span> to save a reusable piece of text.
                  {:else}
                    No user snippets match "{filter}".
                  {/if}
                </div>
              {/if}
            </div>
            <div class="group" data-testid="snippets-group-shipped">
              <div class="group-name">Built-in</div>
              {#each filteredShipped() as s (s.label + (s.langs ?? '*'))}
                <button
                  type="button"
                  class="entry-click entry-shipped"
                  onclick={() => insertSnippet(s.template)}
                  title={'Insert ' + s.label}
                  data-testid="snippets-shipped-entry"
                  data-label={s.label}
                >
                  <div class="entry-row">
                    <span class="entry-name">{s.label}</span>
                    {#if s.langs}<span class="badge badge-ghost badge-xs">{s.langs}</span>{/if}
                  </div>
                  {#if s.detail}<div class="entry-desc">{s.detail}</div>{/if}
                </button>
              {/each}
              {#if filteredShipped().length === 0}
                <div class="opacity-50 text-xs p-2" data-testid="snippets-shipped-empty">
                  No built-in snippets match "{filter}".
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .snip-panel {
    position: absolute;
    right: 1rem;
    top: 3rem;
    z-index: 30;
  }
  .snip-popover {
    position: absolute;
    right: 0;
    top: 0;
    width: 28rem;
    max-height: 34rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .snip-popover :global(.card-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .snip-list {
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .group-name {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    padding: 0 0.2rem;
  }
  .entry {
    display: flex;
    align-items: stretch;
    gap: 0.25rem;
    border-radius: 0.4rem;
    background: rgba(0, 0, 0, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.08);
    transition: background 0.1s;
  }
  .entry:hover {
    background: rgba(0, 100, 200, 0.08);
    border-color: rgba(0, 100, 200, 0.4);
  }
  .entry-click {
    flex: 1;
    display: block;
    text-align: left;
    padding: 0.4rem 0.55rem;
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .entry-shipped {
    display: block;
    padding: 0.4rem 0.55rem;
    border-radius: 0.4rem;
    background: rgba(0, 0, 0, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.08);
    cursor: pointer;
    transition: background 0.1s;
    text-align: left;
  }
  .entry-shipped:hover {
    background: rgba(0, 100, 200, 0.08);
    border-color: rgba(0, 100, 200, 0.4);
  }
  .entry-actions {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.2rem 0.3rem 0.2rem 0;
  }
  .entry-row {
    display: flex;
    align-items: center;
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
  .entry-body {
    font-size: 0.7rem;
    opacity: 0.75;
    margin-top: 0.2rem;
    max-height: 4rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre-wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
</style>
