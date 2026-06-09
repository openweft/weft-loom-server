<script lang="ts">
  // NewFileDialog — daisyUI 5 modal that lets the user create a new
  // file in the current project from a template. The picker is
  // **two-step cascading** :
  //
  //   1. Language  (markdown, latex, go, python, rust, cpp, javascript)
  //   2. Template  (filtered to the language chosen in step 1)
  //
  // The blank template lives in its own pseudo-language so users
  // who just want an empty file don't have to scroll. Path autofills
  // with the suggested extension on every template change, but only
  // when the user hasn't typed in the path field yet (so we don't
  // fight them mid-type).
  import { TEMPLATES, findTemplate, type Template } from '../templates';
  import { writeFile } from '../api';

  interface Props {
    open: boolean;
    project: string;
    onClose: () => void;
    onCreated: (path: string, language: string) => void;
  }

  let { open = $bindable(), project, onClose, onCreated }: Props = $props();

  // Language picker : the unique set of template.language values,
  // sorted, with a friendly display label per language.
  const LANG_LABELS: Record<string, string> = {
    markdown: 'Markdown',
    latex: 'LaTeX',
    go: 'Go',
    cpp: 'C / C++',
    python: 'Python',
    rust: 'Rust',
    javascript: 'JS / TS',
  };

  // We treat the blank template as its own bucket so it doesn't
  // pollute the regular language lists.
  const LANGS = (() => {
    const set = new Set<string>();
    for (const t of TEMPLATES) {
      if (t.id === 'blank') continue;
      set.add(t.language);
    }
    return Array.from(set).sort();
  })();

  let lang = $state<string>('markdown');
  let templateId = $state<string>('markdown-plain');
  let path = $state('');
  let err = $state<string | null>(null);
  let creating = $state(false);

  // When the language changes, snap templateId to that language's
  // first entry. Special-case "blank" : show only the blank template.
  function langTemplates(l: string): Template[] {
    if (l === 'blank') return TEMPLATES.filter((t) => t.id === 'blank');
    return TEMPLATES.filter((t) => t.id !== 'blank' && t.language === l);
  }

  const visibleTemplates = $derived(langTemplates(lang));

  $effect(() => {
    // Reset templateId when the language changes so the second combo
    // never points at a hidden entry.
    if (!visibleTemplates.some((t) => t.id === templateId)) {
      templateId = visibleTemplates[0]?.id ?? 'blank';
    }
  });

  const tpl = $derived<Template | undefined>(findTemplate(templateId));

  // Path autosuggest : only seed (or re-seed) when the field looks
  // unedited — empty or one of our previous "untitled-…" hints. Any
  // explicit edit by the user wins.
  $effect(() => {
    if (!tpl) return;
    if (path === '' || path.match(/^untitled-[a-z0-9]+(\.\w+)?$/)) {
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
      lang = 'markdown';
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

    <div class="grid grid-cols-2 gap-3">
      <div class="form-control">
        <label class="label">
          <span class="label-text text-xs uppercase opacity-60">Language</span>
        </label>
        <select class="select select-bordered select-sm" bind:value={lang}>
          {#each LANGS as l}
            <option value={l}>{LANG_LABELS[l] ?? l}</option>
          {/each}
          <option value="blank">Other / blank</option>
        </select>
      </div>

      <div class="form-control">
        <label class="label">
          <span class="label-text text-xs uppercase opacity-60">Template</span>
        </label>
        <select class="select select-bordered select-sm" bind:value={templateId}>
          {#each visibleTemplates as t}
            <option value={t.id}>{t.name}</option>
          {/each}
        </select>
      </div>
    </div>

    {#if tpl}
      <div class="mt-2 text-xs opacity-60 italic">{tpl.description}</div>
    {/if}

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
      <div class="mt-2 text-xs opacity-50">
        {tpl.content.length} bytes of starter content
      </div>
    {/if}

    {#if err}
      <div class="alert alert-error alert-sm mt-3 text-xs">{err}</div>
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
