<script lang="ts">
  // NotebookPreview — read-only rendered view of a Jupyter notebook,
  // mounted in the PreviewPane when the active file ends in .ipynb.
  // Cells render WITHOUT the edit textareas + per-cell action bar :
  //
  //   - markdown : marked + KaTeX (sanitised HTML)
  //   - code     : monospace block + optional syntax tinting + outputs
  //   - raw      : <pre>
  //
  // Polls the .ipynb file every 1.5 s so edits from the source pane
  // show up here without inter-component plumbing. A future Yjs-on-
  // notebook integration would make the poll obsolete.

  import { onMount, onDestroy } from 'svelte';
  import { marked } from 'marked';
  import markedKatex from 'marked-katex-extension';
  import DOMPurify from 'dompurify';
  import 'katex/dist/katex.css';
  import {
    parseNotebook,
    notebookLanguage,
    type Notebook,
  } from '../notebook';

  marked.use(markedKatex({ throwOnError: false, output: 'html' }));

  interface Props {
    project: string;
    file: string;
  }
  let { project, file }: Props = $props();

  let nb = $state<Notebook | null>(null);
  let err = $state<string | null>(null);
  let lastEtag = '';
  let poll: ReturnType<typeof setInterval> | undefined;

  async function load() {
    if (!file) return;
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
        { headers: lastEtag ? { 'If-None-Match': lastEtag } : undefined },
      );
      if (r.status === 304) return;
      if (!r.ok) {
        err = 'HTTP ' + r.status;
        return;
      }
      err = null;
      const tag = r.headers.get('etag') ?? '';
      if (tag) lastEtag = tag;
      const raw = await r.text();
      // Avoid a re-parse + flicker if the byte content hasn't changed.
      // The crude length check is a good-enough cache key for
      // dev-mode notebooks.
      nb = parseNotebook(raw);
    } catch (e) {
      err = String(e);
    }
  }

  onMount(() => {
    load();
    poll = setInterval(load, 1500);
  });
  onDestroy(() => {
    if (poll) clearInterval(poll);
  });
  $effect(() => {
    file;
    lastEtag = '';
    load();
  });

  function renderMarkdown(s: string): string {
    return DOMPurify.sanitize(marked.parse(s) as string);
  }
</script>

<div class="h-full w-full flex flex-col bg-base-100 overflow-hidden">
  <header class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200 gap-1">
    <span class="font-semibold text-sm flex items-center gap-1">
      <!-- codicon `notebook` matches NotebookEditor + the rest of
           the panel headers (14×14, currentColor). -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M4 2h9l1 1v11l-1 1H4l-1-1V3l1-1zm0 1v11h9V3H4zm1 1h2v1H5V4zm0 3h2v1H5V7zm0 3h2v1H5v-1z"/>
      </svg>
      Notebook preview
    </span>
    {#if nb}
      <span class="ml-2 badge badge-ghost badge-xs font-mono">{notebookLanguage(nb)}</span>
    {/if}
    <span class="ml-2 text-xs opacity-50 truncate font-mono">{file}</span>
  </header>

  {#if err}
    <div class="alert alert-error text-xs m-2">{err}</div>
  {:else if !nb}
    <div class="p-4 text-xs opacity-60">
      <span class="loading loading-spinner loading-xs"></span>
      Loading…
    </div>
  {:else}
    <div class="flex-1 overflow-auto px-4 py-3 space-y-3">
      {#each nb.cells as cell, idx (idx + ':' + cell.cell_type)}
        <article class="rounded bg-base-100 border border-base-300">
          {#if cell.cell_type === 'markdown'}
            <div class="prose max-w-none px-3 py-2">
              {@html renderMarkdown(cell.source)}
            </div>
          {:else if cell.cell_type === 'code'}
            <div class="flex">
              <span class="px-2 py-2 text-[10px] font-mono opacity-50 select-none w-10 text-right">
                [{cell.execution_count ?? ' '}]
              </span>
              <pre class="flex-1 px-3 py-2 font-mono text-xs whitespace-pre-wrap m-0 bg-base-200/40">{cell.source}</pre>
            </div>
            {#if cell.outputs && cell.outputs.length}
              <div class="border-t border-base-300 bg-base-200/20">
                {#each cell.outputs as o}
                  {#if o.output_type === 'stream'}
                    <pre
                      class="text-xs whitespace-pre-wrap px-3 py-2 font-mono"
                      class:text-error={o.name === 'stderr'}
                    >{o.text}</pre>
                  {:else if o.output_type === 'error'}
                    <pre class="text-xs whitespace-pre-wrap px-3 py-2 font-mono text-error bg-error/5"
                    >{o.ename}: {o.evalue}{'\n'}{o.traceback.join('\n')}</pre>
                  {:else if o.output_type === 'display_data' || o.output_type === 'execute_result'}
                    {#if typeof o.data['text/html'] === 'string'}
                      <div class="px-3 py-2">{@html DOMPurify.sanitize(o.data['text/html'] as string)}</div>
                    {:else if typeof o.data['image/png'] === 'string'}
                      <img src={'data:image/png;base64,' + o.data['image/png']} alt="cell output" class="max-w-full px-3 py-2" />
                    {:else if typeof o.data['image/svg+xml'] === 'string'}
                      <div class="px-3 py-2">{@html DOMPurify.sanitize(o.data['image/svg+xml'] as string)}</div>
                    {:else if typeof o.data['text/plain'] === 'string'}
                      <pre class="text-xs whitespace-pre-wrap px-3 py-2 font-mono">{o.data['text/plain']}</pre>
                    {:else}
                      <pre class="text-[10px] opacity-50 px-3 py-2">{JSON.stringify(o.data, null, 2)}</pre>
                    {/if}
                  {/if}
                {/each}
              </div>
            {/if}
          {:else}
            <pre class="text-xs whitespace-pre-wrap px-3 py-2 font-mono">{cell.source}</pre>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(.prose h1) { font-size: 1.5rem; font-weight: 700; margin: 0.5rem 0; }
  :global(.prose h2) { font-size: 1.25rem; font-weight: 700; margin: 0.4rem 0; }
  :global(.prose h3) { font-size: 1.1rem; font-weight: 600; margin: 0.3rem 0; }
  :global(.prose p)  { margin: 0.4rem 0; line-height: 1.55; }
  :global(.prose ul), :global(.prose ol) { margin: 0.4rem 0 0.4rem 1.2rem; }
  :global(.prose code) { background: rgba(127,127,127,0.15); padding: 0.05rem 0.25rem; border-radius: 0.2rem; }
</style>
