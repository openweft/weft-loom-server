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
  import { untrack } from 'svelte';
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
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    svelte: 'Svelte',
    html: 'HTML',
    css: 'CSS',
    json: 'JSON',
    yaml: 'YAML',
    toml: 'TOML',
    hcl: 'HCL / Terraform',
    ruby: 'Ruby',
    perl: 'Perl',
    shell: 'Shell',
    zig: 'Zig',
  };

  // Filter text — typed into a search input above the language
  // dropdown. With ~20 langs the dropdown becomes unwieldy without
  // a filter ; matches against both the language id (`hcl`) and the
  // display label (`HCL / Terraform`). When the filter changes we
  // auto-pick the first matching entry so the rest of the dialog
  // (template list, path autosuggest) stays in sync.
  let langFilter = $state<string>('');
  let tplFilter = $state<string>('');
  function matches(needle: string, hay: string): boolean {
    if (!needle) return true;
    return hay.toLowerCase().includes(needle.toLowerCase());
  }

  const langOptions = $derived(() => {
    const all = LANGS.map((l) => ({ id: l, label: LANG_LABELS[l] ?? l }));
    all.push({ id: 'blank', label: 'Other / blank' });
    return all.filter((o) => matches(langFilter, o.id + ' ' + o.label));
  });
  const tplOptions = $derived(() =>
    visibleTemplates.filter((t) => matches(tplFilter, t.name + ' ' + t.description)),
  );

  // Auto-jump the active selection to the first match whenever the
  // filter narrows out the current pick. Keeps the template combo
  // + path autosuggest tied to whatever the user is filtering
  // toward.
  $effect(() => {
    const opts = langOptions();
    if (!opts.length) return;
    if (!opts.some((o) => o.id === lang)) {
      lang = opts[0].id;
    }
  });
  $effect(() => {
    const opts = tplOptions();
    if (!opts.length) return;
    if (!opts.some((o) => o.id === templateId)) {
      templateId = opts[0].id;
    }
  });

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
    // never points at a hidden entry. untrack the templateId read so
    // the effect's only dep is `visibleTemplates` — otherwise the
    // write below re-fires the effect.
    const id = untrack(() => templateId);
    if (!visibleTemplates.some((t) => t.id === id)) {
      templateId = visibleTemplates[0]?.id ?? 'blank';
    }
  });

  const tpl = $derived<Template | undefined>(findTemplate(templateId));

  // Path autosuggest : only seed (or re-seed) when the field looks
  // unedited — empty or one of our previous "untitled-…" hints. Any
  // explicit edit by the user wins.
  //
  // CRITICAL : read `path` via untrack so the write below doesn't
  // re-fire this effect with the *new* path, which matches the
  // 'untitled-…' regex again → infinite loop saturating the event
  // loop and blocking unrelated fetches (this was the cause of the
  // FileExplorer "loading…" hang earlier in development).
  $effect(() => {
    if (!tpl) return;
    const ext = tpl.suggestedExtension;
    untrack(() => {
      if (path === '' || path.match(/^untitled-[a-z0-9]+(\.\w+)?$/)) {
        path = 'untitled-' + Math.random().toString(36).slice(2, 6) + ext;
      }
    });
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
        <!-- Filter input above the combo : type to narrow. With ~20
             languages a free-typing filter is faster than scrolling
             the dropdown. The combo below auto-collapses to the
             matched entries. -->
        <input
          type="text"
          bind:value={langFilter}
          placeholder="Filter languages…"
          class="input input-bordered input-xs mb-1 font-mono"
        />
        <!-- Drop the `size` attribute : with size>1 a <select>
             becomes a listbox where `bind:value` stops re-syncing
             on filter narrows. Plain dropdown + auto-jump effect
             above keeps the active pick valid. -->
        <select class="select select-bordered select-sm w-full" bind:value={lang}>
          {#each langOptions() as o}
            <option value={o.id}>{o.label}</option>
          {/each}
        </select>
        {#if langOptions().length === 0}
          <p class="text-[10px] opacity-50 italic mt-1">No language matches "{langFilter}".</p>
        {/if}
      </div>

      <div class="form-control">
        <label class="label">
          <span class="label-text text-xs uppercase opacity-60">Template</span>
        </label>
        <input
          type="text"
          bind:value={tplFilter}
          placeholder="Filter templates…"
          class="input input-bordered input-xs mb-1 font-mono"
        />
        <select class="select select-bordered select-sm w-full" bind:value={templateId}>
          {#each tplOptions() as t}
            <option value={t.id}>{t.name}</option>
          {/each}
        </select>
        {#if tplOptions().length === 0}
          <p class="text-[10px] opacity-50 italic mt-1">No template matches "{tplFilter}".</p>
        {/if}
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
