<script lang="ts">
  // ScaffoldDialog — picker for the V0.11 multi-file project
  // templates surfaced via GET /api/project-templates. Models on
  // the established floating-dialog pattern (NewFileDialog +
  // SettingsPanel) — fixed-position modal with a backdrop.

  interface ScaffoldFile {
    path: string;
    size: number;
  }
  interface Template {
    id: string;
    name: string;
    description: string;
    language: string;
    files: ScaffoldFile[];
  }
  interface Props {
    open: boolean;
    project: string;
    onClose: () => void;
    onApplied?: (entry: string) => void;
  }
  let { open = $bindable(), project, onClose, onApplied }: Props = $props();

  let items = $state<Template[]>([]);
  let selectedId = $state<string | undefined>();
  let loading = $state(false);
  let applyError = $state<string | undefined>();
  let applyBusy = $state(false);
  let forceOverwrite = $state(false);
  let clashes = $state<string[] | undefined>();

  async function refresh() {
    loading = true;
    try {
      const r = await fetch('/api/project-templates');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      items = Array.isArray(data?.items) ? data.items : [];
      if (!selectedId && items.length > 0) selectedId = items[0].id;
    } catch {
      items = [];
    } finally {
      loading = false;
    }
  }

  async function apply() {
    if (!selectedId) return;
    applyBusy = true;
    applyError = undefined;
    clashes = undefined;
    try {
      const r = await fetch('/api/projects/' + encodeURIComponent(project) + '/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: selectedId, force: forceOverwrite }),
      });
      if (r.status === 409) {
        const d = await r.json();
        clashes = Array.isArray(d?.clashes) ? d.clashes : [];
        applyError = 'These files already exist : ' + (clashes ?? []).join(', ');
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error ?? ('HTTP ' + r.status));
      }
      const d = await r.json();
      onApplied?.(d.entry ?? d.written?.[0] ?? '');
      open = false;
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
    } finally {
      applyBusy = false;
    }
  }

  $effect(() => {
    if (open) {
      forceOverwrite = false;
      clashes = undefined;
      applyError = undefined;
      void refresh();
    }
  });

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  const selectedTemplate = $derived(items.find((t) => t.id === selectedId));
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="scaffold-backdrop" role="button" tabindex="-1" aria-label="Close" onclick={onClose} onkeydown={(e) => { if (e.key === 'Enter') onClose(); }}></div>
  <div
    class="scaffold-modal card bg-base-100 shadow-2xl border border-base-300"
    role="dialog"
    aria-modal="true"
    aria-labelledby="scaffold-title"
    data-testid="scaffold-dialog"
  >
    <div class="card-body p-4">
      <div class="flex items-center justify-between mb-3">
        <h2 id="scaffold-title" class="text-base font-semibold">Scaffold from template</h2>
        <button type="button" class="btn btn-ghost btn-xs" onclick={onClose} aria-label="Close">×</button>
      </div>
      {#if loading}
        <div class="opacity-60 text-sm">Loading templates…</div>
      {:else if items.length === 0}
        <div class="opacity-60 text-sm">No templates available.</div>
      {:else}
        <div class="scaffold-body">
          <ul class="scaffold-list" role="listbox">
            {#each items as t (t.id)}
              <li>
                <button
                  type="button"
                  class="scaffold-item"
                  class:scaffold-selected={selectedId === t.id}
                  onclick={() => (selectedId = t.id)}
                  role="option"
                  aria-selected={selectedId === t.id}
                  data-testid="scaffold-item"
                  data-id={t.id}
                >
                  <div class="font-semibold">{t.name}</div>
                  <div class="text-xs opacity-70">{t.language} · {t.files.length} files</div>
                </button>
              </li>
            {/each}
          </ul>
          <div class="scaffold-detail">
            {#if selectedTemplate}
              <div class="text-sm mb-2">{selectedTemplate.description}</div>
              <div class="text-xs opacity-60 mb-1">Files :</div>
              <ul class="scaffold-files">
                {#each selectedTemplate.files as f (f.path)}
                  <li><code>{f.path}</code> <span class="opacity-50">({f.size} B)</span></li>
                {/each}
              </ul>
              {#if clashes && clashes.length > 0}
                <label class="cursor-pointer label gap-2 mt-2 text-xs">
                  <input
                    type="checkbox"
                    class="checkbox checkbox-xs"
                    bind:checked={forceOverwrite}
                    data-testid="scaffold-force"
                  />
                  <span>Overwrite existing files ({clashes.length})</span>
                </label>
              {/if}
              {#if applyError}
                <div class="text-error text-xs mt-2" data-testid="scaffold-error">{applyError}</div>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
      <div class="flex justify-end gap-1 mt-3">
        <button type="button" class="btn btn-ghost btn-sm" onclick={onClose}>Cancel</button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          disabled={!selectedId || applyBusy}
          onclick={apply}
          data-testid="scaffold-apply"
        >{applyBusy ? 'Applying…' : 'Apply'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scaffold-backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
    z-index: 80; cursor: pointer;
  }
  .scaffold-modal {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: min(90vw, 44rem);
    max-height: 80vh;
    z-index: 81;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  .scaffold-modal :global(.card-body) {
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  .scaffold-body {
    display: grid; grid-template-columns: 14rem 1fr;
    gap: 0.6rem;
    flex: 1;
    overflow: hidden;
  }
  .scaffold-list {
    list-style: none; padding: 0; margin: 0;
    overflow-y: auto;
    display: flex; flex-direction: column;
    gap: 0.2rem;
    border-right: 1px solid rgba(0, 0, 0, 0.08);
    padding-right: 0.4rem;
  }
  .scaffold-item {
    width: 100%; text-align: left;
    padding: 0.4rem 0.5rem;
    border-radius: 0.3rem;
    background: rgba(0, 0, 0, 0.02);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .scaffold-item:hover {
    background: rgba(0, 100, 200, 0.06);
  }
  .scaffold-selected {
    background: rgba(0, 100, 200, 0.12);
    border-color: rgba(0, 100, 200, 0.4);
  }
  .scaffold-detail {
    overflow-y: auto;
    padding: 0.3rem 0.4rem;
  }
  .scaffold-files {
    list-style: none; padding: 0; margin: 0;
    font-size: 0.75rem;
  }
  .scaffold-files li {
    padding: 0.1rem 0;
  }
</style>
