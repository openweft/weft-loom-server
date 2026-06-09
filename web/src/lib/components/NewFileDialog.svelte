<script lang="ts">
  // NewFileDialog — daisyUI 5 modal that lets the user create a new
  // file in the current project from a template. Picks the path
  // (with the template's suggested extension prefilled) and PUTs the
  // template content via /api/projects/{p}/files/{path}. The parent
  // FileExplorer refreshes its listing on success.
  import { TEMPLATES, findTemplate, type Template } from '../templates';
  import { writeFile } from '../api';

  interface Props {
    open: boolean;
    project: string;
    onClose: () => void;
    onCreated: (path: string, language: string) => void;
  }

  let { open = $bindable(), project, onClose, onCreated }: Props = $props();

  let templateId = $state<string>('markdown-plain');
  let path = $state('');
  let err = $state<string | null>(null);
  let creating = $state(false);

  const tpl = $derived<Template | undefined>(findTemplate(templateId));

  // When the template changes, suggest a path with the matching
  // extension if the user hasn't typed anything yet (so the field
  // doesn't fight the user mid-type but does sensibly seed on first
  // open).
  $effect(() => {
    if (!tpl) return;
    if (path === '' || path.match(/^untitled-\d*(\.\w+)?$/)) {
      path = 'untitled-' + Math.random().toString(36).slice(2, 6) + tpl.suggestedExtension;
    }
  });

  async function create() {
    if (!tpl) return;
    if (path.trim() === '') {
      err = 'path is required';
      return;
    }
    creating = true;
    err = null;
    try {
      await writeFile(project, path, tpl.content);
      onCreated(path, tpl.language);
      open = false;
      path = '';
      templateId = 'markdown-plain';
    } catch (e) {
      err = String(e);
    } finally {
      creating = false;
    }
  }
</script>

<dialog class="modal" class:modal-open={open}>
  <div class="modal-box max-w-xl">
    <h3 class="text-lg font-bold mb-3">New file</h3>

    <div class="form-control">
      <label class="label">
        <span class="label-text text-xs uppercase opacity-60">Template</span>
      </label>
      <select class="select select-bordered select-sm" bind:value={templateId}>
        {#each TEMPLATES as t}
          <option value={t.id}>{t.name} — {t.description}</option>
        {/each}
      </select>
    </div>

    <div class="form-control mt-3">
      <label class="label">
        <span class="label-text text-xs uppercase opacity-60">Path inside project</span>
      </label>
      <input
        type="text"
        class="input input-bordered input-sm font-mono"
        bind:value={path}
        placeholder="e.g. slides/intro.tex"
        onkeydown={(e) => {
          if (e.key === 'Enter') create();
          if (e.key === 'Escape') {
            open = false;
            onClose();
          }
        }}
      />
    </div>

    {#if tpl}
      <div class="mt-3 text-xs opacity-60">
        Language : <span class="font-mono">{tpl.language}</span>
        · {tpl.content.length} bytes of starter content
      </div>
    {/if}

    {#if err}
      <div class="alert alert-error alert-sm mt-3 text-xs">
        {err}
      </div>
    {/if}

    <div class="modal-action">
      <button class="btn btn-sm" onclick={() => { open = false; onClose(); }}>Cancel</button>
      <button class="btn btn-primary btn-sm" disabled={creating} onclick={create}>
        {#if creating}
          <span class="loading loading-spinner loading-xs"></span>
        {/if}
        Create
      </button>
    </div>
  </div>
  <button
    type="button"
    class="modal-backdrop"
    onclick={() => { open = false; onClose(); }}
    aria-label="Close"
  ></button>
</dialog>
