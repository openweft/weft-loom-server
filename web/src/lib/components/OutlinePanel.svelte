<script lang="ts">
  // OutlinePanel — Overleaf-style table of contents. Sits in the
  // bottom half of the FileExplorer column whenever the active file
  // is structured prose (LaTeX or Markdown). Parses headings + lets
  // the user click an entry to jump the editor caret.
  //
  // LaTeX headings :
  //   \chapter        → depth 0
  //   \section        → depth 1
  //   \subsection     → depth 2
  //   \subsubsection  → depth 3
  //   \paragraph      → depth 4
  //
  // Markdown headings :
  //   # h1            → depth 0
  //   ## h2           → depth 1
  //   ### h3          → depth 2
  //   ...
  //
  // Polls the file every 1.5 s + ETag short-circuit ; not LSP-driven
  // — fine for the file sizes weft-loom targets.

  import { onMount, onDestroy } from 'svelte';
  import { i18n } from '../i18n.svelte';

  interface Props {
    project: string;
    file: string;
    onJump?: (line: number) => void;
    // Accordion state owned by App.svelte so the wrapper can shrink
    // to fit just the header when collapsed (no wasted vertical
    // space below). $bindable so click-to-toggle stays one-way.
    collapsed?: boolean;
    onToggle?: () => void;
  }
  let { project, file, onJump, collapsed = $bindable(true), onToggle }: Props = $props();

  interface Entry {
    depth: number;     // 0 = chapter, 4 = paragraph
    label: string;     // user-visible heading text
    line: number;      // 1-based line number
    starred: boolean;  // \section* → unnumbered
    // number is the auto-computed dotted prefix ("1", "1.1",
    // "1.1.1" …) following the same numbering rules as LaTeX's
    // article class : every starred / level≥4 entry stays blank.
    number: string;
  }

  let entries = $state<Entry[]>([]);
  let lastSig = '';
  let loading = $state(false);
  let poll: ReturnType<typeof setInterval> | undefined;

  // Collapsed (accordion) state is OWNED by App.svelte so the
  // parent wrapper can shrink to just the header row when collapsed.
  // Toggle dispatches `onToggle` instead of mutating local state.
  function toggleCollapsed() {
    onToggle?.();
  }

  const DEPTH_OF: Record<string, number> = {
    chapter: 0,
    section: 1,
    subsection: 2,
    subsubsection: 3,
    paragraph: 4,
  };

  function parseLatex(src: string): Entry[] {
    const out: Entry[] = [];
    const lines = src.split('\n');
    // Skip the preamble — `\title{}` / `\author{}` aren't outline
    // entries even though they look like headings.
    let inDoc = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inDoc) {
        if (line.includes('\\begin{document}')) inDoc = true;
        else continue;
      }
      const m = /\\(chapter|section|subsection|subsubsection|paragraph)(\*?)\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/.exec(line);
      if (!m) continue;
      out.push({
        depth: DEPTH_OF[m[1]],
        label: (m[3] || m[4]).trim(),
        line: i + 1,
        starred: !!m[2],
        number: '',
      });
    }
    return out;
  }

  function parseMarkdown(src: string): Entry[] {
    const out: Entry[] = [];
    const lines = src.split('\n');
    // Track whether we're inside a fenced code block so `# foo`
    // inside a shell snippet doesn't slip into the outline.
    let inFence = false;
    let fenceMarker = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fence[1][0];
        } else if (line.startsWith(fenceMarker)) {
          inFence = false;
        }
        continue;
      }
      if (inFence) continue;
      // ATX heading : `# Title` … `###### h6`. Trailing `#`s are
      // optional decoration and stripped.
      const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (!m) continue;
      out.push({
        depth: m[1].length - 1, // 0-based
        label: m[2].trim(),
        line: i + 1,
        starred: false,
        number: '',
      });
    }
    return out;
  }

  // Compute "1", "1.1", "1.1.1" dotted numbers for each heading
  // mirroring LaTeX article-class numbering : every starred entry
  // is unnumbered, paragraph (level ≥ 4) too. Higher-level entries
  // zero out every lower counter when they bump (so "subsection 1.2"
  // resets to "1.3.1" under the next subsubsection).
  function applyNumbers(entries: Entry[], maxLevel: number) {
    const counters = [0, 0, 0, 0, 0];
    for (const e of entries) {
      if (e.starred || e.depth > maxLevel) {
        e.number = '';
        continue;
      }
      for (let i = e.depth + 1; i < counters.length; i++) counters[i] = 0;
      counters[e.depth]++;
      // Skip leading zero counters : an article-class doc with no
      // \chapter shouldn't surface "0.1.1" — start the dotted
      // number at the first level that has actually appeared.
      let start = 0;
      while (start < e.depth && counters[start] === 0) start++;
      e.number = counters.slice(start, e.depth + 1).join('.');
    }
  }

  function parseOutline(src: string, lang: 'latex' | 'markdown'): Entry[] {
    const entries = lang === 'markdown' ? parseMarkdown(src) : parseLatex(src);
    // LaTeX article : section + subsection + subsubsection numbered
    // (depth 1..3) ; \paragraph (depth 4) unnumbered. Markdown :
    // every depth 0..5 gets a number ("1", "1.1", …).
    applyNumbers(entries, lang === 'markdown' ? 5 : 3);
    return entries;
  }

  function langForFile(f: string): 'latex' | 'markdown' | null {
    if (f.endsWith('.tex')) return 'latex';
    if (f.endsWith('.md') || f.endsWith('.markdown') || f.endsWith('.mdown')) return 'markdown';
    return null;
  }

  async function refresh() {
    const lang = file ? langForFile(file) : null;
    if (!file || !lang) {
      entries = [];
      return;
    }
    loading = true;
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
        { headers: lastSig ? { 'If-None-Match': lastSig } : undefined },
      );
      if (r.status === 304) return;
      if (!r.ok) {
        loading = false;
        return;
      }
      const tag = r.headers.get('etag') ?? '';
      if (tag) lastSig = tag;
      const text = await r.text();
      entries = parseOutline(text, lang);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    refresh();
    poll = setInterval(refresh, 1500);
  });
  onDestroy(() => {
    if (poll) clearInterval(poll);
  });
  $effect(() => {
    file;
    lastSig = '';
    refresh();
  });
</script>

<aside class="flex flex-col bg-base-100 text-xs h-full w-full" class:flex-none={collapsed}>
  <!-- Header is the accordion trigger : click anywhere on it (not on
       the absolute spinner) to expand / collapse the entries list.
       Pattern matches the GitSidebar Source Graph collapse + every
       VSCode accordion section. -->
  <button
    type="button"
    class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200 select-none gap-1 w-full text-left hover:bg-base-300"
    onclick={toggleCollapsed}
    title={collapsed ? 'Expand outline' : 'Collapse outline'}
    aria-expanded={!collapsed}
  >
    <!-- Chevron — sized to match VSCode's accordion glyph (16×16,
         high contrast). Rotates 90° when expanded for the
         "tree-node disclosure" affordance. -->
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
    <!-- codicon `list-tree` — outline / table of contents glyph
         matching the canonical header style. -->
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M14 3h-3v1h3V3zm0 3h-3v1h3V6zm-3 3h3v1h-3V9zm3 3h-3v1h3v-1zM1 2v12l1 1h12l1-1V2L14 1H2L1 2zm1 12V2h12v12H2zm6-9H6v1h2V5zM6 8h2V7H6v1zm0 2h2V9H6v1zm0 2h2v-1H6v1zM4 5H3v1h1V5zm-1 3h1V7H3v1zm0 2h1V9H3v1zm0 2h1v-1H3v1z"/>
    </svg>
    <span class="font-semibold text-sm">Outline</span>
    {#if entries.length > 0}
      <span class="ml-2 badge badge-ghost badge-xs">{entries.length}</span>
    {/if}
    {#if loading}
      <span class="ml-auto loading loading-spinner loading-xs"></span>
    {/if}
  </button>

  {#if collapsed}
    <!-- Accordion closed : the parent's flex sizing collapses the
         entries list to zero height ; no body rendered so the layout
         tracks the chevron. -->
  {:else if !file || !langForFile(file)}
    <p class="px-3 py-2 opacity-50 italic">Open a .tex or .md file to see its outline.</p>
  {:else if entries.length === 0}
    <p class="px-3 py-2 opacity-50 italic">No headings yet.</p>
  {:else}
    <ul class="overflow-auto flex-1 py-1">
      {#each entries as e (e.line)}
        <li>
          <button
            type="button"
            class="w-full text-left px-2 py-0.5 hover:bg-base-200 font-mono truncate"
            style="padding-left: {e.depth * 0.75 + 0.5}rem"
            onclick={() => onJump?.(e.line)}
            title={`L${e.line} · ${e.label}`}
          >
            <span class="opacity-50 mr-1">
              {#if e.starred}*{:else if e.number}{e.number}{:else if e.depth >= 4}¶{:else}§{/if}
            </span>
            {e.label}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>
