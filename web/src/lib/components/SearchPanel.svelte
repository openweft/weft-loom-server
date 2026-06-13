<script lang="ts">
  // SearchPanel — VSCode-style "find in files" panel. Pulls the
  // file list via /api/projects/{p}/files, fetches the contents of
  // each candidate via /api/projects/{p}/files/{path}, and runs the
  // user's regex against them client-side. Streaming is good enough
  // for the small dev-mode projects we target ; a server-side grep
  // RPC lands as a follow-up once project sizes warrant it.
  //
  // The panel matches VSCode's behaviour : search box on top, options
  // (case sensitive, whole word, regex) below, then the result tree
  // grouped by file with the matched line + column highlighted in
  // each row.

  import { onDestroy } from 'svelte';
  import { listFiles, type File } from '../api';
  import { i18n } from '../i18n.svelte';

  interface Props {
    project: string;
    onOpen: (path: string, language: string) => void;
  }

  let { project, onOpen }: Props = $props();

  let query = $state('');
  let useRegex = $state(false);
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let busy = $state(false);
  let err = $state<string | null>(null);

  interface Match {
    line: number; // 1-based
    col: number;
    text: string; // the line's content
  }
  interface FileResult {
    path: string;
    matches: Match[];
  }
  let results = $state<FileResult[]>([]);

  // Debounce input changes ; cancel in-flight search on new query.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let cancelToken = 0;

  function scheduleSearch() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(runSearch, 250);
  }

  function makeRegex(): RegExp | null {
    if (!query) return null;
    let pattern: string;
    if (useRegex) {
      pattern = query;
    } else {
      pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (wholeWord) pattern = '\\b' + pattern + '\\b';
    try {
      return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (e) {
      err = String(e);
      return null;
    }
  }

  async function runSearch() {
    err = null;
    results = [];
    if (!query) {
      busy = false;
      return;
    }
    const re = makeRegex();
    if (!re) {
      busy = false;
      return;
    }
    const seq = ++cancelToken;
    busy = true;
    try {
      const files = await listFiles(project);
      // Skip directories + the .weft-loom scratch tree (build noise).
      const candidates = files.filter(
        (f: File) => !f.dir && !f.path.startsWith('.weft-loom/'),
      );
      const acc: FileResult[] = [];
      for (const f of candidates) {
        if (seq !== cancelToken) return;
        try {
          const r = await fetch(
            '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(f.path),
          );
          if (!r.ok) continue;
          // Skip likely-binary by sniffing magic bytes ; a simple
          // "any null byte in first 4 KB" heuristic catches PDFs +
          // images without false-positives on UTF-8 text.
          const buf = new Uint8Array(await r.arrayBuffer());
          let isBinary = false;
          for (let i = 0; i < Math.min(buf.length, 4096); i++) {
            if (buf[i] === 0) {
              isBinary = true;
              break;
            }
          }
          if (isBinary) continue;
          const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
          const lines = text.split('\n');
          const matches: Match[] = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            re.lastIndex = 0;
            const m = re.exec(line);
            if (m) {
              matches.push({ line: i + 1, col: m.index + 1, text: line });
            }
          }
          if (matches.length) {
            acc.push({ path: f.path, matches });
            results = [...acc];
          }
        } catch {
          /* per-file errors stay silent — keep results streaming */
        }
      }
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }

  onDestroy(() => {
    if (debounce) clearTimeout(debounce);
  });

  // Highlight the matched substring in a result line. Returns an
  // HTML string ; we only emit text + <mark> so direct innerHTML
  // is XSS-safe (the line content + query are both string-escaped
  // before assembly).
  function highlight(line: string): string {
    const re = makeRegex();
    if (!re) return escape(line);
    // Use placeholder sentinels so we can HTML-escape the full line
    // (matched bytes included) AFTER tagging match positions, then
    // swap the placeholders for the real <mark> wrappers.
    const OPEN = '\u0001';
    const CLOSE = '\u0002';
    const tagged = line.replace(re, (m) => OPEN + m + CLOSE);
    const escaped = escape(tagged);
    return escaped
      .split(OPEN).join('<mark class="bg-warning/40 text-base-content">')
      .split(CLOSE).join('</mark>');
  }
  function escape(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const totalMatches = $derived(
    results.reduce((sum, fr) => sum + fr.matches.length, 0),
  );
</script>

<div class="h-full flex flex-col bg-base-100 text-sm">
  <header class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200 gap-2">
    <span class="font-semibold text-sm flex items-center gap-1">
      <!-- codicon `search` — same metric (14×14) as every other
           panel header so headers align horizontally. -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M10.02 10.73C9.07 11.52 7.84 12 6.5 12 3.46 12 1 9.54 1 6.5S3.46 1 6.5 1 12 3.46 12 6.5c0 1.34-.48 2.57-1.27 3.52l3.12 3.13a.5.5 0 0 1-.71.7l-3.12-3.12zM11 6.5a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0z"/>
      </svg>
      {i18n.t('activity.search')}
    </span>
  </header>

  <div class="p-2 space-y-1.5 border-b border-base-300">
    <input
      type="text"
      bind:value={query}
      oninput={scheduleSearch}
      placeholder={i18n.t('search.placeholder')}
      class="input input-bordered input-xs w-full font-mono"
    />
    <div class="flex gap-1 text-xs">
      <button
        type="button"
        class="btn btn-xs btn-ghost font-mono"
        class:btn-active={caseSensitive}
        onclick={() => { caseSensitive = !caseSensitive; scheduleSearch(); }}
        title="Case sensitive (Aa)"
      >Aa</button>
      <button
        type="button"
        class="btn btn-xs btn-ghost font-mono"
        class:btn-active={wholeWord}
        onclick={() => { wholeWord = !wholeWord; scheduleSearch(); }}
        title="Whole word (\\b)"
      >ab</button>
      <button
        type="button"
        class="btn btn-xs btn-ghost font-mono"
        class:btn-active={useRegex}
        onclick={() => { useRegex = !useRegex; scheduleSearch(); }}
        title="Regular expression (.*)"
      >.*</button>
      <span class="ml-auto text-[10px] opacity-60 self-center">
        {#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
        {totalMatches} {i18n.t('search.results')}
      </span>
    </div>
  </div>

  {#if err}
    <div class="m-2 alert alert-error text-xs">{err}</div>
  {/if}

  <div class="flex-1 overflow-auto">
    {#if results.length === 0 && !busy && query}
      <p class="p-3 text-xs opacity-60 italic">No matches.</p>
    {:else}
      {#each results as fr}
        <details open class="border-b border-base-300/40">
          <summary
            class="cursor-pointer flex items-center px-2 py-1 hover:bg-base-200 select-none"
          >
            <span class="font-mono text-xs truncate flex-1">{fr.path}</span>
            <span class="badge badge-ghost badge-xs ml-2">{fr.matches.length}</span>
          </summary>
          <ul class="text-xs">
            {#each fr.matches as m}
              <li>
                <button
                  type="button"
                  class="w-full text-left px-4 py-0.5 hover:bg-base-200 font-mono text-[11px] flex gap-2"
                  onclick={() => onOpen(fr.path, '')}
                  title="Open {fr.path} (jump to L{m.line}:C{m.col})"
                >
                  <span class="opacity-50 w-10 text-right">{m.line}:{m.col}</span>
                  <span class="truncate">{@html highlight(m.text)}</span>
                </button>
              </li>
            {/each}
          </ul>
        </details>
      {/each}
    {/if}
  </div>
</div>
