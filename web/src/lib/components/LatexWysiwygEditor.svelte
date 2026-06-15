<script lang="ts">
  // LatexWysiwygEditor — Word-like editable surface for .tex files.
  // The complement to Editor.svelte (CodeMirror source view) :
  // App.svelte routes between them based on the per-file
  // `wysiwygMode` toggle. The .tex on disk is parsed via
  // parseLatex into { preamble, bodyHtml, postamble } ; the body
  // renders in a contenteditable + saves back via serializeLatex.
  //
  // V0.1 — single-user, file-based, no Yjs binding. Round-trip
  // covers the latexWysiwyg.ts supported subset ; unknown
  // commands ride through as latex-raw spans + reappear in the
  // source view byte-for-byte.

  import { onMount, onDestroy } from 'svelte';
  import { parseLatex, serializeLatex, type ParsedLatex } from '../latexWysiwyg';
  import { readFile, writeFile } from '../api';
  import { logEvent, logError } from '../logbus';

  interface Props {
    project: string;
    file: string;
  }
  let { project, file }: Props = $props();

  let editorEl: HTMLDivElement;
  let status = $state<'loading' | 'ready' | 'saving' | 'error'>('loading');
  let errorMessage = $state('');
  let dirty = $state(false);
  let savedAt = $state<number | null>(null);
  let parsed: ParsedLatex = { preamble: '', bodyHtml: '', postamble: '' };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    try {
      status = 'loading';
      const source = await readFile(project, file);
      parsed = parseLatex(source);
      // contenteditable wants the HTML in the element BEFORE the
      // browser parses it ; setting innerHTML triggers the layout
      // pass. The math-display + math-inline spans render in the
      // PreviewPane elsewhere ; here they show as bracketed source
      // so the user can edit by clicking inside.
      editorEl.innerHTML = parsed.bodyHtml;
      status = 'ready';
      logEvent('latex-wysiwyg', 'loaded', { file, bytes: source.length });
    } catch (e) {
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
      logError('latex-wysiwyg', 'load_failed', e, { file });
    }
  }

  async function save() {
    if (status === 'saving') return;
    status = 'saving';
    try {
      const body = serializeLatex(parsed, editorEl.innerHTML);
      await writeFile(project, file, body);
      status = 'ready';
      dirty = false;
      savedAt = Date.now();
      logEvent('latex-wysiwyg', 'saved', { file, bytes: body.length });
    } catch (e) {
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
      logError('latex-wysiwyg', 'save_failed', e, { file });
    }
  }

  function onInput() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void save(); }, 600);
  }

  // Toolbar commands : execCommand is officially deprecated but
  // remains the simplest portable way to wrap/unwrap inline marks.
  // Replacement (Range + Selection APIs) would balloon the
  // component ; revisit when the API truly disappears.
  function exec(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editorEl.focus();
    onInput();
  }
  function wrapHeading(level: 1 | 2 | 3) {
    document.execCommand('formatBlock', false, 'h' + level);
    editorEl.focus();
    onInput();
  }

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
      void save();
    }
  }

  onMount(() => {
    void load();
  });
  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="latex-wysiwyg h-full w-full flex flex-col bg-base-100">
  <!-- Format toolbar : same affordances as the source-view LaTeX
       toolbar (B/I/U + headings + lists) but the commands route
       through execCommand into the contenteditable. -->
  <div class="flex-none flex items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200/60 text-xs">
    <div class="join">
      <button class="join-item btn btn-xs font-bold" onclick={() => exec('bold')} title="Bold (Cmd+B)">B</button>
      <button class="join-item btn btn-xs italic" onclick={() => exec('italic')} title="Italic (Cmd+I)">I</button>
      <button class="join-item btn btn-xs underline" onclick={() => exec('underline')} title="Underline">U</button>
    </div>
    <span class="opacity-30">·</span>
    <div class="join">
      <button class="join-item btn btn-xs" onclick={() => wrapHeading(1)} title="Section (H1)">H1</button>
      <button class="join-item btn btn-xs" onclick={() => wrapHeading(2)} title="Subsection (H2)">H2</button>
      <button class="join-item btn btn-xs" onclick={() => wrapHeading(3)} title="Subsubsection (H3)">H3</button>
    </div>
    <span class="opacity-30">·</span>
    <div class="join">
      <button class="join-item btn btn-xs" onclick={() => exec('insertUnorderedList')} title="Bullet list">• List</button>
      <button class="join-item btn btn-xs" onclick={() => exec('insertOrderedList')} title="Numbered list">1. List</button>
    </div>
    <span class="ml-auto opacity-70 text-[10px] font-mono mr-2">
      {#if status === 'loading'}loading…
      {:else if status === 'saving'}saving…
      {:else if status === 'error'}<span class="text-error">{errorMessage}</span>
      {:else if dirty}modified
      {:else if savedAt}saved
      {:else}ready
      {/if}
    </span>
    <button
      class="btn btn-xs"
      onclick={() => window.dispatchEvent(new CustomEvent('weft-loom:toggle-wysiwyg-mode'))}
      title="Switch back to source (CodeMirror) view"
      aria-label="Switch to source"
    >&lt;/&gt; Source</button>
  </div>

  <!-- The editable surface. The .latex-wysiwyg-surface class
       gives it the prose-style typography ; the contenteditable
       attribute on the div is what makes the user able to type
       directly into it. -->
  <div
    bind:this={editorEl}
    class="latex-wysiwyg-surface prose prose-sm max-w-none flex-1 overflow-y-auto p-6 outline-none"
    contenteditable="true"
    role="textbox"
    aria-label="LaTeX WYSIWYG editor"
    aria-multiline="true"
    spellcheck="true"
    oninput={onInput}
    data-testid="latex-wysiwyg-surface"
  ></div>
</div>

<style>
  /* Render the latex-raw inline tokens as a faint monospace pill
     so the user can SEE which spans are still LaTeX source they
     could replace + which ones the WYSIWYG already understands. */
  .latex-wysiwyg-surface :global(.latex-raw) {
    font-family: ui-monospace, SFMono-Regular, monospace;
    background: rgba(120, 120, 120, 0.12);
    border-radius: 3px;
    padding: 0 4px;
    font-size: 0.85em;
    color: var(--cm-peer-color, hsl(0, 0%, 60%));
  }
  .latex-wysiwyg-surface :global(.math-inline),
  .latex-wysiwyg-surface :global(.math-display) {
    font-family: ui-monospace, SFMono-Regular, monospace;
    background: rgba(80, 140, 255, 0.10);
    border-radius: 3px;
    padding: 0 4px;
  }
  .latex-wysiwyg-surface :global(.math-display) {
    display: block;
    margin: 0.5em 0;
    padding: 0.5em;
  }
</style>
