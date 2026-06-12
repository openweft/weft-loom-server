<script lang="ts">
  // MetadataPanel — parses the document's preamble / front-matter
  // and surfaces title / author / date / class. Lives in the left
  // side-bar (under Outline) as an accordion section.
  //
  // LaTeX preamble : `\title{...}` `\author{...}` `\date{...}`
  // `\documentclass[opts]{class}`.
  //
  // Markdown front-matter (YAML between leading `---` markers) :
  // `title:` `author:` `date:` `theme:` (Marp).
  //
  // Poll every 1.5 s + ETag short-circuit, same cadence as
  // OutlinePanel so the two never fight for the same file twice.

  import { onMount, onDestroy } from 'svelte';

  interface Props {
    project: string;
    file: string;
    collapsed?: boolean;
    onToggle?: () => void;
  }
  let { project, file, collapsed = $bindable(true), onToggle }: Props = $props();

  interface Meta {
    key: string;
    label: string;
    value: string;
  }
  let entries = $state<Meta[]>([]);
  let lang = $state<'latex' | 'markdown' | null>(null);
  let lastSig = '';
  let poll: ReturnType<typeof setInterval> | undefined;

  function pickGroup(src: string, name: string): string | null {
    const m = new RegExp('\\\\' + name + '\\{([^{}]*)\\}').exec(src);
    return m ? m[1].trim() : null;
  }
  function parseLatex(src: string): Meta[] {
    const out: Meta[] = [];
    const dclass = /\\documentclass(?:\[[^\]]*\])?\{([^{}]+)\}/.exec(src);
    if (dclass) out.push({ key: 'class', label: 'Class', value: dclass[1] });
    const title = pickGroup(src, 'title');
    if (title) out.push({ key: 'title', label: 'Title', value: title });
    const author = pickGroup(src, 'author');
    if (author) out.push({ key: 'author', label: 'Author', value: author });
    const date = pickGroup(src, 'date');
    if (date) out.push({ key: 'date', label: 'Date', value: date });
    // Packages — collapsed display ; first 3 listed inline, rest
    // hidden behind a "+N more".
    const pkgs: string[] = [];
    const pkgRe = /\\usepackage(?:\[[^\]]*\])?\{([^{}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = pkgRe.exec(src))) pkgs.push(...m[1].split(',').map((s) => s.trim()));
    if (pkgs.length) out.push({ key: 'packages', label: 'Packages', value: pkgs.length <= 4 ? pkgs.join(', ') : pkgs.slice(0, 3).join(', ') + ' +' + (pkgs.length - 3) + ' more' });
    return out;
  }
  function parseMarkdown(src: string): Meta[] {
    const out: Meta[] = [];
    // YAML front-matter : `---\n...\n---` at the very top.
    const fm = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(src);
    if (!fm) return out;
    for (const line of fm[1].split('\n')) {
      const kv = /^(\w+)\s*:\s*(.+?)\s*$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      let value = kv[2];
      // Unquote.
      value = value.replace(/^['"]/, '').replace(/['"]$/, '');
      if (['title', 'author', 'date', 'theme', 'marp', 'class', 'size', 'paginate', 'header', 'footer'].includes(key)) {
        out.push({ key, label: key[0].toUpperCase() + key.slice(1), value });
      }
    }
    return out;
  }

  async function refresh() {
    const ext = file && file.toLowerCase();
    const nextLang: typeof lang =
      ext && ext.endsWith('.tex') ? 'latex' :
      ext && (ext.endsWith('.md') || ext.endsWith('.markdown') || ext.endsWith('.mdown')) ? 'markdown' :
      null;
    lang = nextLang;
    if (!file || !nextLang) { entries = []; return; }
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
        { headers: lastSig ? { 'If-None-Match': lastSig } : undefined },
      );
      if (r.status === 304) return;
      if (!r.ok) return;
      const tag = r.headers.get('etag') ?? '';
      if (tag) lastSig = tag;
      const text = await r.text();
      entries = nextLang === 'latex' ? parseLatex(text) : parseMarkdown(text);
    } catch {}
  }

  onMount(() => {
    refresh();
    poll = setInterval(refresh, 1500);
  });
  onDestroy(() => { if (poll) clearInterval(poll); });
  $effect(() => { file; lastSig = ''; refresh(); });

  function toggleCollapsed() { onToggle?.(); }
</script>

<aside class="flex flex-col bg-base-100 text-xs h-full w-full">
  <button
    type="button"
    class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200 select-none gap-1 w-full text-left hover:bg-base-300"
    onclick={toggleCollapsed}
    title={collapsed ? 'Expand metadata' : 'Collapse metadata'}
    aria-expanded={!collapsed}
  >
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      class="transition-transform shrink-0"
      class:rotate-90={!collapsed}
    >
      <path d="M5.7 13.7L4.3 12.3 8.6 8 4.3 3.7 5.7 2.3l5.7 5.7-5.7 5.7z"/>
    </svg>
    <!-- codicon `info` glyph — same 14×14 metric as the other panel
         headers. -->
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm9-3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 7v5h2V7H7z"/>
    </svg>
    <span class="font-semibold text-sm">Metadata</span>
    {#if entries.length > 0}
      <span class="ml-2 badge badge-ghost badge-xs">{entries.length}</span>
    {/if}
  </button>

  {#if collapsed}
    <!-- accordion closed -->
  {:else if !file || !lang}
    <p class="px-3 py-2 opacity-50 italic">Open a .tex or .md file to see metadata.</p>
  {:else if entries.length === 0}
    <p class="px-3 py-2 opacity-50 italic">No metadata found in the preamble.</p>
  {:else}
    <!-- `content-start` pins grid rows to the top so they don't
         space out vertically when the panel is resized taller. -->
    <dl class="overflow-auto flex-1 py-1 px-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 content-start items-baseline">
      {#each entries as e (e.key)}
        <dt class="font-mono text-[10px] uppercase opacity-60">{e.label}</dt>
        <dd class="font-mono text-xs truncate" title={e.value}>{e.value}</dd>
      {/each}
    </dl>
  {/if}
</aside>
