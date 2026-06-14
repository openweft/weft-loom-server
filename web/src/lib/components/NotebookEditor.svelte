<script lang="ts">
  // NotebookEditor — Jupyter `.ipynb` cell list. Each cell is one of
  //
  //   - markdown : rendered via marked + KaTeX (same pipeline the
  //                preview pane uses for .md files)
  //   - code     : monospace textarea + Run button ; output area
  //                renders stored outputs (text/plain, text/html,
  //                image/png, application/json) verbatim.
  //   - raw      : <pre> (round-trips but never executed)
  //
  // Persistence : every edit re-serialises the notebook + PUTs it
  // back via the project files API, debounced. The Yjs CRDT path
  // doesn't apply here — notebooks ARE JSON, character-by-character
  // collaboration would corrupt the structure ; the cell list is the
  // per-cell collab unit (future : Y.Array<Cell>).
  //
  // Execution (V1) : code cells fire POST /api/projects/{p}/notebook/exec
  // with `{ language, source }` ; the server dispatches via the workspace
  // VM's NATS exec session and replies with the stdout/stderr capture.
  // Cell outputs[] are replaced with a single Stream output for now ;
  // proper kernel state (variables, plots) lives in V0.7.

  import { onMount, onDestroy } from 'svelte';
  import { marked } from 'marked';
  import markedKatex from 'marked-katex-extension';
  import DOMPurify from 'dompurify';
  import 'katex/dist/katex.css';
  import {
    parseNotebook,
    serialiseNotebook,
    notebookLanguage,
    type Notebook,
    type Cell,
  } from '../notebook';

  marked.use(markedKatex({ throwOnError: false, output: 'html' }));

  interface Props {
    project: string;
    file: string;
  }

  let { project, file }: Props = $props();

  let nb = $state<Notebook | null>(null);
  let loadErr = $state<string | null>(null);
  let saveErr = $state<string | null>(null);
  let saving = $state(false);
  let busyCell = $state<number | null>(null);

  let saveDebounce: ReturnType<typeof setTimeout> | undefined;
  // Suppress save during initial load — the file read writes nb,
  // which would otherwise fire $effect → save the file we just read.
  let dirty = $state(false);
  // Bumped on every load() entry ; awaited fetches that resolve after
  // a newer load started bail before mutating nb/dirty (rapid file switch).
  let loadSeq = 0;

  async function load() {
    const seq = ++loadSeq;
    // Reset state so the spinner overlay shows while the fetch is
    // in flight. Without this, switching from notebook A → B kept
    // A's cells rendered until B's parse finished — no perceptible
    // loading indicator (the user pointed this out).
    nb = null;
    loadErr = null;
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
      );
      if (seq !== loadSeq) return;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const raw = await r.text();
      if (seq !== loadSeq) return;
      nb = parseNotebook(raw);
      dirty = false;
    } catch (e) {
      if (seq !== loadSeq) return;
      loadErr = String(e);
    }
  }

  async function save() {
    if (!nb) return;
    saving = true;
    saveErr = null;
    try {
      const body = serialiseNotebook(nb);
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      );
      if (!r.ok) throw new Error('HTTP ' + r.status);
      dirty = false;
      // Notify any NotebookPreview rendering the same file so it can
      // re-fetch immediately without 1.5 s polling (M4). Filtered by
      // project + file on the listener side.
      window.dispatchEvent(
        new CustomEvent('weft-loom-notebook-changed', {
          detail: { project, file },
        }),
      );
    } catch (e) {
      saveErr = String(e);
    } finally {
      saving = false;
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(save, 800);
  }

  function flushOnUnload() {
    if (dirty) void save();
  }

  onMount(() => {
    window.addEventListener('beforeunload', flushOnUnload);
  });
  onDestroy(() => {
    window.removeEventListener('beforeunload', flushOnUnload);
    if (saveDebounce) clearTimeout(saveDebounce);
    if (dirty) void save();
  });

  // Reload on file change (user opens a different .ipynb).
  $effect(() => {
    file;
    load();
  });

  // Markdown render : sanitise via DOMPurify so the same protection
  // we apply in the .md preview pane covers notebooks too.
  //
  // Memoised per `source` string (H7). Whenever the cells array is
  // reassigned via `nb.cells = [...]` (run / add / delete / move /
  // typing in one cell), every {#each} markdown cell would otherwise
  // pay `marked.parse + DOMPurify.sanitize` again — a 30-cell notebook
  // with 20 markdown cells dominates the profile with marked.parse.
  // The cache keys on cell.source so only the cell whose source
  // actually changed recomputes ; an LRU cap keeps memory bounded
  // across long edit sessions / cell additions.
  const RENDER_CACHE_MAX = 256;
  const renderCache = new Map<string, string>();
  function renderMarkdown(source: string): string {
    const hit = renderCache.get(source);
    if (hit !== undefined) {
      // Refresh recency : delete + set moves the key to the tail
      // (Map iteration order = insertion order), so eviction below
      // drops the least-recently-used entry.
      renderCache.delete(source);
      renderCache.set(source, hit);
      return hit;
    }
    const html = DOMPurify.sanitize(marked.parse(source) as string);
    renderCache.set(source, html);
    if (renderCache.size > RENDER_CACHE_MAX) {
      const oldest = renderCache.keys().next().value;
      if (oldest !== undefined) renderCache.delete(oldest);
    }
    return html;
  }

  // Run a code cell via the workspace exec endpoint. Captures stdout
  // + stderr into a single Stream output on success ; on error sets
  // an OutputError so the traceback renders red.
  async function runCell(idx: number) {
    if (!nb) return;
    const cell = nb.cells[idx];
    if (cell.cell_type !== 'code') return;
    busyCell = idx;
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/notebook/exec',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            language: notebookLanguage(nb),
            source: cell.source,
          }),
        },
      );
      if (!r.ok) {
        const text = await r.text();
        nb.cells[idx].outputs = [
          {
            output_type: 'error',
            ename: 'HTTPError',
            evalue: 'HTTP ' + r.status,
            traceback: [text],
          },
        ];
      } else {
        const { stdout, stderr, exit_code } = await r.json();
        const outs: Cell['outputs'] = [];
        if (stdout) outs!.push({ output_type: 'stream', name: 'stdout', text: stdout });
        if (stderr) outs!.push({ output_type: 'stream', name: 'stderr', text: stderr });
        nb.cells[idx].outputs = outs;
        nb.cells[idx].execution_count = (nb.cells[idx].execution_count ?? 0) + 1;
        if (exit_code !== 0 && !stderr) {
          nb.cells[idx].outputs!.push({
            output_type: 'error',
            ename: 'ExitCode',
            evalue: 'exit ' + exit_code,
            traceback: [],
          });
        }
      }
      // Force reactivity by reassigning the cells array.
      nb.cells = [...nb.cells];
      scheduleSave();
    } catch (e) {
      nb.cells[idx].outputs = [
        {
          output_type: 'error',
          ename: 'ClientError',
          evalue: String(e),
          traceback: [],
        },
      ];
      nb.cells = [...nb.cells];
    } finally {
      busyCell = null;
    }
  }

  function addCell(after: number, type: 'markdown' | 'code') {
    if (!nb) return;
    const cell: Cell = {
      cell_type: type,
      source: '',
      metadata: {},
      ...(type === 'code' ? { outputs: [], execution_count: null } : {}),
    };
    nb.cells = [...nb.cells.slice(0, after + 1), cell, ...nb.cells.slice(after + 1)];
    scheduleSave();
  }

  function deleteCell(idx: number) {
    if (!nb) return;
    nb.cells = nb.cells.filter((_, i) => i !== idx);
    scheduleSave();
  }

  function moveCell(idx: number, delta: -1 | 1) {
    if (!nb) return;
    const j = idx + delta;
    if (j < 0 || j >= nb.cells.length) return;
    const arr = [...nb.cells];
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    nb.cells = arr;
    scheduleSave();
  }

  function onCellSourceInput(idx: number, ev: Event) {
    if (!nb) return;
    const ta = ev.target as HTMLTextAreaElement;
    nb.cells[idx].source = ta.value;
    scheduleSave();
  }
</script>

<div class="h-full overflow-auto bg-base-200 px-4 py-3 space-y-3">
  <header class="flex items-center gap-2 sticky top-0 bg-base-200 z-10 px-3 h-9 border-b border-base-300 -mx-4 -mt-3 mb-3">
    <span class="font-semibold text-sm flex items-center gap-1">
      <!-- codicon `notebook` — same metric (14×14) as every other
           panel header so the row height matches across the app. -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M4 2h9l1 1v11l-1 1H4l-1-1V3l1-1zm0 1v11h9V3H4zm1 1h2v1H5V4zm0 3h2v1H5V7zm0 3h2v1H5v-1z"/>
      </svg>
      Notebook
    </span>
    <span class="text-xs opacity-60 font-mono truncate">{file}</span>
    {#if nb}
      <span class="badge badge-ghost badge-xs font-mono">{notebookLanguage(nb)}</span>
    {/if}
    <span class="ml-auto text-xs opacity-60">
      {#if saving}saving…{:else if dirty}● unsaved{:else}saved{/if}
    </span>
    {#if saveErr}
      <span class="badge badge-error badge-xs" title={saveErr}>save err</span>
    {/if}
  </header>

  {#if loadErr}
    <div class="alert alert-error text-xs">{loadErr}</div>
  {:else if !nb}
    <!-- Same visual signature as Editor.svelte's loader so the
         transition between source / notebook panes feels coherent. -->
    <div class="flex-1 flex items-center justify-center min-h-[200px]" aria-live="polite">
      <div class="flex items-center gap-3 px-4 py-2 rounded-md bg-base-100 border border-base-300 shadow text-sm">
        <span class="loading loading-spinner loading-sm"></span>
        <span class="opacity-80">Loading {file || 'notebook'}…</span>
      </div>
    </div>
  {:else}
    {#each nb.cells as cell, idx (idx + ':' + cell.cell_type)}
      <article class="rounded-lg bg-base-100 border border-base-300 overflow-hidden shadow-sm">
        <!-- Cell toolbar : type label + actions. -->
        <header class="flex items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200/40 text-[10px]">
          <span class="font-mono opacity-70">
            {#if cell.cell_type === 'code'}[{cell.execution_count ?? ' '}]{:else if cell.cell_type === 'markdown'}MD{:else}RAW{/if}
          </span>
          <span class="opacity-50">·</span>
          <span class="opacity-50">{cell.cell_type}</span>
          <span class="ml-auto flex gap-0.5">
            {#if cell.cell_type === 'code'}
              <button
                class="btn btn-ghost btn-xs"
                disabled={busyCell === idx}
                onclick={() => runCell(idx)}
                title="Run cell"
              >
                {#if busyCell === idx}
                  <span class="loading loading-spinner loading-xs"></span>
                {:else}
                  ▶
                {/if}
              </button>
            {/if}
            <button class="btn btn-ghost btn-xs" onclick={() => moveCell(idx, -1)} title="Move up">↑</button>
            <button class="btn btn-ghost btn-xs" onclick={() => moveCell(idx, 1)} title="Move down">↓</button>
            <button class="btn btn-ghost btn-xs" onclick={() => addCell(idx, 'code')} title="Add code cell after">+code</button>
            <button class="btn btn-ghost btn-xs" onclick={() => addCell(idx, 'markdown')} title="Add markdown cell after">+md</button>
            <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteCell(idx)} title="Delete cell">✕</button>
          </span>
        </header>

        <!-- Cell source -->
        {#if cell.cell_type === 'markdown'}
          <details>
            <summary class="text-[10px] opacity-50 px-3 py-1 cursor-pointer select-none">
              show / hide source
            </summary>
            <textarea
              class="w-full font-mono text-sm bg-base-100 px-3 py-2 outline-none resize-y border-b border-base-300"
              rows="3"
              value={cell.source}
              oninput={(e) => onCellSourceInput(idx, e)}
            ></textarea>
          </details>
          <div class="prose max-w-none px-3 py-2">
            {@html renderMarkdown(cell.source)}
          </div>
        {:else}
          <textarea
            class="w-full font-mono text-sm bg-base-100 px-3 py-2 outline-none resize-y"
            rows="4"
            value={cell.source}
            oninput={(e) => onCellSourceInput(idx, e)}
            spellcheck="false"
          ></textarea>

          <!-- Stored outputs -->
          {#if cell.outputs && cell.outputs.length}
            <div class="border-t border-base-300 bg-base-200/30">
              {#each cell.outputs as o}
                {#if o.output_type === 'stream'}
                  <pre
                    class="text-xs whitespace-pre-wrap px-3 py-2 font-mono"
                    class:text-error={o.name === 'stderr'}
                  >{o.text}</pre>
                {:else if o.output_type === 'error'}
                  <pre
                    class="text-xs whitespace-pre-wrap px-3 py-2 font-mono text-error bg-error/5"
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
        {/if}
      </article>
    {/each}

    <!-- Bottom "add cell" CTA so the last cell can grow the notebook
         without scrolling back up to a per-cell + button. -->
    <div class="flex gap-2 justify-center py-2 opacity-70 hover:opacity-100">
      <button class="btn btn-xs" onclick={() => addCell(nb!.cells.length - 1, 'code')}>+ code cell</button>
      <button class="btn btn-xs" onclick={() => addCell(nb!.cells.length - 1, 'markdown')}>+ markdown cell</button>
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
  :global(.prose pre) { background: rgba(127,127,127,0.08); padding: 0.6rem; border-radius: 0.4rem; overflow-x: auto; }
  :global(.prose pre code) { background: transparent; padding: 0; }
</style>
