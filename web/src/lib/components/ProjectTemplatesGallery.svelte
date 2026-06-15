<script lang="ts">
  // ProjectTemplatesGallery — daisyUI 5 modal that lets the user
  // start a NEW project from a curated multi-file template. Each
  // card represents one ProjectTemplate (see lib/projectTemplates.ts) ;
  // clicking a card flips the modal into "name + confirm" mode,
  // then PUTs every file via the writeFile() helper. The backend
  // auto-creates the project on first PUT, so we don't need a
  // dedicated create-project endpoint.
  //
  // Two-step flow :
  //   1. Pick a template card (grid view).
  //   2. Enter a project name + confirm (detail view).
  //
  // After confirm, the SPA redirects to /?project=<name>&file=<entry>
  // — App.svelte already honours those query params on bootstrap
  // (search-params block circa line 156 + 889), so we don't need to
  // wire anything into App.svelte to make the landing work.
  //
  // Naming policy : the name input is trimmed, lower-cased, and
  // non-[a-z0-9-_] runs collapse to '-'. Keeps the user out of
  // trouble when the backend's path encoding gets strict. Empty
  // name → blocked. Duplicate names are NOT detected here ; the
  // backend will happily merge files into an existing project,
  // which is sometimes what the user wants.
  //
  // Modal pattern follows NewFileDialog.svelte : native <dialog>
  // driven by an effect on `open`, ::backdrop click closes,
  // Escape closes (browser default cancel handler).
  import { writeFile } from '../api';
  import { PROJECT_TEMPLATES, type ProjectTemplate } from '../projectTemplates';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open = $bindable(), onClose }: Props = $props();

  // Selected template — null = grid view ; non-null = detail view
  // with the name input. Resets when the modal closes so reopening
  // lands back on the grid.
  let selected = $state<ProjectTemplate | null>(null);
  let projectName = $state('');
  let err = $state<string | null>(null);
  let busy = $state(false);
  let progress = $state<{ done: number; total: number } | null>(null);

  let dialogEl = $state<HTMLDialogElement | null>(null);
  let cancelBound = false;
  let previousFocus: HTMLElement | null = null;

  $effect(() => {
    if (!dialogEl) return;
    if (!cancelBound) {
      dialogEl.addEventListener('cancel', (e) => {
        e.preventDefault();
        close();
      });
      cancelBound = true;
    }
    if (open && !dialogEl.open) {
      previousFocus = (document.activeElement as HTMLElement | null) ?? null;
      dialogEl.showModal();
      queueMicrotask(() => {
        const target = dialogEl?.querySelector<HTMLElement>('[data-autofocus]');
        target?.focus();
      });
    } else if (!open && dialogEl.open) {
      dialogEl.close();
      previousFocus?.focus?.();
    }
  });

  function close() {
    open = false;
    selected = null;
    projectName = '';
    err = null;
    progress = null;
    busy = false;
    onClose();
  }

  function pickTemplate(t: ProjectTemplate) {
    selected = t;
    err = null;
    // Suggest a name based on the template id so the user can hit
    // Enter immediately if they're prototyping.
    if (!projectName) projectName = t.id + '-' + Math.random().toString(36).slice(2, 6);
  }

  function sanitise(raw: string): string {
    return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  async function create() {
    if (!selected) return;
    const name = sanitise(projectName);
    if (!name) {
      err = 'project name is required';
      return;
    }
    busy = true;
    err = null;
    progress = { done: 0, total: selected.files.length };
    try {
      for (const f of selected.files) {
        await writeFile(name, f.path, f.content);
        progress = { done: progress.done + 1, total: selected.files.length };
      }
      // First file = entry point ; deep-link the SPA to it.
      const entry = selected.files[0]?.path ?? '';
      const url = '/?project=' + encodeURIComponent(name)
        + (entry ? '&file=' + encodeURIComponent(entry) : '');
      window.location.assign(url);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      busy = false;
      progress = null;
    }
  }
</script>

<dialog class="modal" class:modal-open={open} bind:this={dialogEl}>
  <div class="modal-box max-w-3xl">
    <h3 class="text-lg font-bold mb-3">
      {#if selected}
        New project from "{selected.name}"
      {:else}
        New project from template
      {/if}
    </h3>

    {#if !selected}
      <p class="text-xs opacity-60 mb-3">
        Pick a starter. Files are seeded into a fresh project — you
        rename + edit them after the editor opens.
      </p>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        {#each PROJECT_TEMPLATES as t (t.id)}
          <button
            type="button"
            class="card bg-base-200 hover:bg-base-300 border border-base-300 text-left transition-colors"
            onclick={() => pickTemplate(t)}
            data-template-id={t.id}
          >
            <div class="card-body p-3">
              <div class="flex items-center gap-2">
                <span class="text-xl font-bold opacity-80">{t.emoji}</span>
                <h4 class="card-title text-sm">{t.name}</h4>
              </div>
              <p class="text-xs opacity-60 line-clamp-3">{t.description}</p>
              <div class="text-[10px] opacity-40 mt-1">
                {t.files.length} file{t.files.length === 1 ? '' : 's'}
              </div>
            </div>
          </button>
        {/each}
      </div>
    {:else}
      <div class="text-xs opacity-60 italic mb-3">{selected.description}</div>

      <div class="form-control">
        <label class="label" for="pt-name">
          <span class="label-text text-xs uppercase opacity-60">Project name</span>
        </label>
        <input
          id="pt-name"
          type="text"
          class="input input-bordered input-sm font-mono"
          bind:value={projectName}
          placeholder="my-project"
          data-autofocus
          onkeydown={(e) => {
            if (e.key === 'Enter') create();
            if (e.key === 'Escape') close();
          }}
        />
        {#if projectName && sanitise(projectName) !== projectName.trim().toLowerCase()}
          <p class="text-[10px] opacity-50 mt-1">
            will be saved as <span class="font-mono">{sanitise(projectName)}</span>
          </p>
        {/if}
      </div>

      <div class="mt-3">
        <p class="text-xs uppercase opacity-60 mb-1">Files</p>
        <ul class="text-xs font-mono opacity-70 space-y-0.5">
          {#each selected.files as f}
            <li>· {f.path}</li>
          {/each}
        </ul>
      </div>

      {#if progress}
        <div class="mt-3">
          <progress
            class="progress progress-primary w-full"
            value={progress.done}
            max={progress.total}
          ></progress>
          <p class="text-[10px] opacity-60 mt-1">
            wrote {progress.done} / {progress.total} files…
          </p>
        </div>
      {/if}

      {#if err}
        <div class="alert alert-error alert-sm mt-3 text-xs">{err}</div>
      {/if}
    {/if}

    <div class="modal-action">
      {#if selected && !busy}
        <button class="btn btn-sm btn-ghost" onclick={() => { selected = null; err = null; }}>
          Back
        </button>
      {/if}
      <button class="btn btn-sm" onclick={close} disabled={busy}>Cancel</button>
      {#if selected}
        <button class="btn btn-primary btn-sm" disabled={busy} onclick={create}>
          {#if busy}
            <span class="loading loading-spinner loading-xs"></span>
          {/if}
          Create project
        </button>
      {/if}
    </div>
  </div>
  <button
    type="button"
    class="modal-backdrop"
    onclick={close}
    aria-label="Close"
    aria-hidden="true"
    tabindex="-1"
  ></button>
</dialog>
