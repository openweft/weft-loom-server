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
  import katex from 'katex';
  import { parseLatex, serializeLatex, type ParsedLatex } from '../latexWysiwyg';
  import { readFile, writeFile } from '../api';
  import { logEvent, logError } from '../logbus';
  import { bib } from '../bibStore.svelte';

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

  // ─── cite picker popover state ─────────────────────────────────
  // Quick-insert affordance : type a search term, see matching bib
  // entries with author-year + title, click to insert \cite{key}
  // at the caret without opening the heavier BibliographyPanel.
  let citePickerState = $state<{ filter: string; top: number; left: number } | null>(null);
  let citePickerMatches = $derived.by(() => {
    if (!citePickerState) return [];
    const q = citePickerState.filter.toLowerCase().trim();
    const all = bib.entries;
    if (!q) return all.slice(0, 30);
    return all
      .filter((e) => {
        const k = (e.key ?? '').toLowerCase();
        const author = (e.fields?.author ?? '').toLowerCase();
        const title = (e.fields?.title ?? '').toLowerCase();
        const year = (e.fields?.year ?? '').toLowerCase();
        return k.includes(q) || author.includes(q) || title.includes(q) || year.includes(q);
      })
      .slice(0, 30);
  });
  let citePickerIndex = $state<number>(0);

  function openCitePicker() {
    editorEl.focus();
    const sel = window.getSelection();
    let top = 200;
    let left = 200;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      top = r.bottom + 8;
      left = r.left;
    }
    citePickerState = { filter: '', top, left };
    citePickerIndex = 0;
  }
  function closeCitePicker() {
    citePickerState = null;
  }
  function insertCite(key: string) {
    if (!key) return closeCitePicker();
    const span = document.createElement('span');
    span.className = 'latex-cite';
    span.setAttribute('data-key', key);
    span.contentEditable = 'false';
    const entry = bib.entries.find((e) => e.key === key);
    span.textContent = '[' + (entry ? formatBibLabel(entry) : key) + ']';
    span.title = entry ? `${entry.fields?.author ?? ''} (${entry.fields?.year ?? '?'}) — ${entry.fields?.title ?? key}` : key;
    span.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('weft-loom:toggle-bib'));
    });
    editorEl.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(span);
      range.setStartAfter(span);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editorEl.appendChild(span);
    }
    closeCitePicker();
    onInput();
  }
  function citePickerKey(e: KeyboardEvent) {
    if (!citePickerState) return;
    if (e.key === 'Escape') { e.preventDefault(); closeCitePicker(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      citePickerIndex = Math.min(citePickerIndex + 1, citePickerMatches.length - 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      citePickerIndex = Math.max(citePickerIndex - 1, 0);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = citePickerMatches[citePickerIndex];
      if (picked) insertCite(picked.key);
    }
  }

  // ─── inline math popover state ─────────────────────────────────
  // popoverState carries the editing context : null when closed,
  // otherwise the math node being edited + its current tex source
  // + the display-mode flag + the anchor rect for positioning.
  let popoverState = $state<{
    node: HTMLElement | null;
    tex: string;
    displayMode: boolean;
    top: number;
    left: number;
  } | null>(null);
  let popoverPreviewHtml = $derived.by(() => {
    if (!popoverState) return '';
    try {
      return katex.renderToString(popoverState.tex, {
        throwOnError: false,
        displayMode: popoverState.displayMode,
        output: 'html',
      });
    } catch {
      return '<span class="text-error">parse error</span>';
    }
  });
  function openMathPopover(node: HTMLElement | null, displayMode: boolean, tex: string) {
    let top = 200;
    let left = 200;
    if (node) {
      const rect = node.getBoundingClientRect();
      top = rect.bottom + 8;
      left = rect.left;
    } else {
      // Brand-new insert : anchor near the editor's caret line.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        top = r.bottom + 8;
        left = r.left;
      }
    }
    popoverState = { node, tex, displayMode, top, left };
  }
  function closeMathPopover() {
    popoverState = null;
  }
  function applyMathPopover() {
    if (!popoverState) return;
    const { node, tex, displayMode } = popoverState;
    if (node) {
      // Edit existing node : update data-tex + re-render.
      node.setAttribute('data-tex', tex);
      try {
        node.innerHTML = katex.renderToString(tex, {
          throwOnError: false,
          displayMode,
          output: 'html',
        });
        node.classList.remove('math-error');
      } catch {
        node.textContent = '⚠ ' + tex;
        node.classList.add('math-error');
      }
    } else {
      // New node : create + insert at caret.
      const span = document.createElement(displayMode ? 'div' : 'span');
      span.className = 'math ' + (displayMode ? 'math-display' : 'math-inline');
      span.setAttribute('data-tex', tex);
      span.contentEditable = 'false';
      span.dataset.katexRendered = '1';
      try {
        span.innerHTML = katex.renderToString(tex, {
          throwOnError: false,
          displayMode,
          output: 'html',
        });
      } catch {
        span.textContent = '⚠ ' + tex;
        span.classList.add('math-error');
      }
      span.addEventListener('click', () => {
        openMathPopover(span, displayMode, span.getAttribute('data-tex') ?? '');
      });
      editorEl.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(span);
        range.setStartAfter(span);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editorEl.appendChild(span);
      }
    }
    closeMathPopover();
    onInput();
  }

  async function load() {
    try {
      status = 'loading';
      bib.setProject(project);
      const source = await readFile(project, file);
      parsed = parseLatex(source);
      editorEl.innerHTML = parsed.bodyHtml;
      renderMathNodes(editorEl);
      renderCiteNodes(editorEl);
      renderFigureNodes(editorEl);
      status = 'ready';
      logEvent('latex-wysiwyg', 'loaded', { file, bytes: source.length });
    } catch (e) {
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
      logError('latex-wysiwyg', 'load_failed', e, { file });
    }
  }

  // renderCiteNodes replaces the [key] placeholder text of each
  // .cite span with the BibTeX author-year string when available.
  // Falls back to the key itself when the entry isn't loaded (yet
  // — bibStore polls .bib on a timer + we re-render on tick).
  function renderCiteNodes(root: HTMLElement) {
    const nodes = root.querySelectorAll('.latex-cite');
    nodes.forEach((node) => {
      const el = node as HTMLElement;
      const key = el.getAttribute('data-key') ?? '';
      const entry = bib.entries.find((e) => e.key === key);
      const label = entry ? formatBibLabel(entry) : key;
      el.textContent = '[' + label + ']';
      el.title = entry ? `${entry.fields?.author ?? ''} (${entry.fields?.year ?? '?'}) — ${entry.fields?.title ?? key}` : 'unknown bib key';
      if (!el.dataset.clickWired) {
        el.dataset.clickWired = '1';
        el.addEventListener('click', () => {
          // Surface the bib panel for editing — fast affordance ;
          // V0.4 will let the user pick a different key inline.
          window.dispatchEvent(new CustomEvent('weft-loom:toggle-bib'));
        });
      }
    });
  }

  // renderFigureNodes wires up the <img class="latex-figure">
  // src attribute from data-path. Resolves relative paths against
  // the same project the .tex lives in via /api/projects/.../files/.
  // Marks the node contenteditable=false so click-deletes are
  // atomic, and click opens a tiny popover-style prompt for V0.4 ;
  // for now the alt-text + path are visible on hover.
  function renderFigureNodes(root: HTMLElement) {
    const imgs = root.querySelectorAll('img.latex-figure');
    imgs.forEach((img) => {
      const el = img as HTMLImageElement;
      const path = el.getAttribute('data-path') ?? '';
      if (!path) return;
      const url = '/api/projects/' + encodeURIComponent(project)
        + '/files/' + path.split('/').map(encodeURIComponent).join('/');
      el.src = url;
      el.contentEditable = 'false';
      el.title = `\\includegraphics{${path}}`;
    });
  }

  function formatBibLabel(entry: { fields?: Record<string, string>; key: string }): string {
    const f = entry.fields ?? {};
    const authorRaw = f.author ?? '';
    const year = f.year ?? '';
    // First author surname : "Einstein, A." → "Einstein", "Albert Einstein" → "Einstein".
    let surname = '';
    if (authorRaw) {
      const firstAuthor = authorRaw.split(/\s+and\s+/i)[0];
      if (firstAuthor.includes(',')) {
        surname = firstAuthor.split(',')[0].trim();
      } else {
        const parts = firstAuthor.trim().split(/\s+/);
        surname = parts[parts.length - 1];
      }
    }
    if (surname && year) return `${surname} ${year}`;
    if (surname) return surname;
    return entry.key;
  }

  // Re-render cite labels when the bib store ticks (new entries
  // arrived from disk). Cheap : just walks the visible spans.
  $effect(() => {
    void bib.entries.length;
    if (editorEl && status === 'ready') {
      renderCiteNodes(editorEl);
    }
  });

  // renderMathNodes walks the surface, renders each math span via
  // KaTeX, and marks it contenteditable=false so the user can't
  // accidentally delete a half-character + leave broken markup.
  // Backspace on the node still works (whole-node delete), and the
  // Insert-math toolbar button creates new ones.
  // KaTeX env name remapping : KaTeX supports `aligned` / `gathered`
  // (the inline-math wrappers) but NOT the display-math standalone
  // forms `align` / `gather`. When rendering a math-env we wrap the
  // tex in the KaTeX-compatible env so AMS markers (&, \\) survive.
  const KATEX_ENV_MAP: Record<string, string> = {
    equation: '',          // bare math — no wrapper needed
    'equation*': '',
    align: 'aligned',
    'align*': 'aligned',
    gather: 'gathered',
    'gather*': 'gathered',
    multline: 'gathered',
    'multline*': 'gathered',
  };

  function renderMathNodes(root: HTMLElement) {
    const nodes = root.querySelectorAll('.math-inline, .math-display, .math-env');
    nodes.forEach((node) => {
      const el = node as HTMLElement;
      if (el.dataset.katexRendered === '1') return;
      let tex = el.getAttribute('data-tex') ?? '';
      if (el.classList.contains('math-env')) {
        const env = el.getAttribute('data-env') ?? 'equation';
        const wrapper = KATEX_ENV_MAP[env];
        if (wrapper) {
          tex = `\\begin{${wrapper}}\n${tex}\n\\end{${wrapper}}`;
        }
      }
      const displayMode = el.classList.contains('math-display') || el.classList.contains('math-env');
      try {
        el.innerHTML = katex.renderToString(tex, {
          throwOnError: false,
          displayMode,
          output: 'html',
        });
      } catch (e) {
        el.textContent = '⚠ ' + tex;
        el.classList.add('math-error');
        logError('latex-wysiwyg', 'katex_render', e, { tex });
      }
      el.contentEditable = 'false';
      el.dataset.katexRendered = '1';
      // Click-to-edit : open the inline popover with KaTeX live
      // preview + textarea, anchored at the node's bottom-left.
      el.addEventListener('click', () => {
        openMathPopover(el, displayMode, el.getAttribute('data-tex') ?? '');
      });
    });
  }

  // Insert a fresh math span via the popover (live KaTeX preview +
  // textarea + Apply/Cancel). Triggered from the toolbar's ∑ / ∫
  // buttons. The actual insert happens in applyMathPopover().
  function insertMath(displayMode: boolean) {
    openMathPopover(null, displayMode, displayMode ? 'x^2 + y^2 = z^2' : 'a + b');
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
    <span class="opacity-30">·</span>
    <div class="join">
      <button class="join-item btn btn-xs" onclick={() => insertMath(false)} title="Insert inline math ($…$)" aria-label="Insert inline math">∑</button>
      <button class="join-item btn btn-xs" onclick={() => insertMath(true)} title="Insert display math (\\[…\\])" aria-label="Insert display math">∫</button>
    </div>
    <span class="opacity-30">·</span>
    <button class="btn btn-xs" onclick={openCitePicker} title="Insert citation (fuzzy search bib entries)" aria-label="Insert citation">📚 Cite</button>
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

  {#if popoverState}
    <!-- Inline math popover : floats over the editor at the clicked
         node's bottom-left, lets the user edit the LaTeX source
         with a KaTeX preview that re-renders on every keystroke.
         Enter = apply, Esc = cancel. -->
    <div
      class="math-popover card bg-base-200 border border-base-300 shadow-xl"
      style="top: {popoverState.top}px; left: {popoverState.left}px;"
      role="dialog"
      aria-label="Edit LaTeX math"
      data-testid="math-popover"
    >
      <div class="card-body p-3 gap-2">
        <div class="flex items-center gap-2 text-xs">
          <span class="font-semibold">{popoverState.displayMode ? 'Display math' : 'Inline math'}</span>
          <span class="ml-auto opacity-60">Enter = apply · Esc = cancel</span>
        </div>
        <textarea
          class="textarea textarea-bordered textarea-sm font-mono text-xs w-80"
          rows="3"
          bind:value={popoverState.tex}
          onkeydown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeMathPopover(); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); applyMathPopover(); }
          }}
          aria-label="LaTeX math source"
        ></textarea>
        <div class="math-popover-preview text-center text-sm py-2 border border-base-300 rounded bg-base-100">
          {@html popoverPreviewHtml}
        </div>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost btn-xs" onclick={closeMathPopover}>Cancel</button>
          <button class="btn btn-primary btn-xs" onclick={applyMathPopover}>Apply</button>
        </div>
      </div>
    </div>
  {/if}

  {#if citePickerState}
    <!-- Cite picker : fuzzy-searches bib.entries, click or Enter
         to insert \cite{key} at the caret. Beats Overleaf which
         requires switching to the bibliography pane. -->
    <div
      class="cite-picker card bg-base-200 border border-base-300 shadow-xl"
      style="top: {citePickerState.top}px; left: {citePickerState.left}px;"
      role="dialog"
      aria-label="Insert citation"
      data-testid="cite-picker"
    >
      <div class="card-body p-2 gap-2">
        <input
          class="input input-bordered input-sm w-72 text-sm"
          placeholder="Search author / title / year / key…"
          bind:value={citePickerState.filter}
          onkeydown={citePickerKey}
          autofocus
          data-testid="cite-picker-filter"
        />
        <div class="cite-picker-list max-h-64 overflow-y-auto">
          {#if citePickerMatches.length === 0}
            <div class="p-2 text-xs opacity-60 italic">
              {bib.entries.length === 0 ? 'No .bib file loaded in this project' : 'No match'}
            </div>
          {:else}
            {#each citePickerMatches as entry, idx}
              <button
                type="button"
                class="cite-picker-row w-full text-left p-2 text-xs border-b border-base-300 last:border-b-0 hover:bg-base-300"
                class:bg-primary={idx === citePickerIndex}
                class:text-primary-content={idx === citePickerIndex}
                onclick={() => insertCite(entry.key)}
                onmouseenter={() => (citePickerIndex = idx)}
              >
                <div class="font-mono font-semibold">{entry.key}</div>
                <div class="opacity-80 truncate">
                  {entry.fields?.author ?? '?'} ({entry.fields?.year ?? '?'})
                </div>
                <div class="opacity-60 truncate">{entry.fields?.title ?? ''}</div>
              </button>
            {/each}
          {/if}
        </div>
        <div class="flex justify-between text-[10px] opacity-60">
          <span>↑↓ navigate · Enter to insert · Esc to cancel</span>
          <button class="btn btn-ghost btn-xs" onclick={closeCitePicker}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
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
    background: rgba(80, 140, 255, 0.08);
    border-radius: 3px;
    padding: 0 4px;
    cursor: pointer;
    user-select: none;
  }
  .latex-wysiwyg-surface :global(.math-inline:hover),
  .latex-wysiwyg-surface :global(.math-display:hover) {
    background: rgba(80, 140, 255, 0.18);
  }
  .latex-wysiwyg-surface :global(.math-display) {
    display: block;
    margin: 0.5em 0;
    padding: 0.5em;
    text-align: center;
  }
  .latex-wysiwyg-surface :global(.math-error) {
    background: rgba(255, 80, 80, 0.18) !important;
    color: #c00;
  }
  .math-popover {
    position: fixed;
    z-index: 50;
    max-width: 24rem;
  }
  .cite-picker {
    position: fixed;
    z-index: 50;
  }
  .latex-wysiwyg-surface :global(.latex-cite) {
    color: hsl(220, 70%, 50%);
    background: rgba(80, 140, 255, 0.08);
    border-radius: 3px;
    padding: 0 4px;
    cursor: pointer;
    user-select: none;
    font-size: 0.9em;
  }
  .latex-wysiwyg-surface :global(.latex-cite:hover) {
    background: rgba(80, 140, 255, 0.22);
  }
  .latex-wysiwyg-surface :global(.latex-ref) {
    color: hsl(280, 60%, 50%);
    background: rgba(180, 100, 220, 0.10);
    border-radius: 3px;
    padding: 0 4px;
    cursor: pointer;
    user-select: none;
    font-size: 0.9em;
  }
  .latex-wysiwyg-surface :global(.latex-label) {
    color: hsl(280, 30%, 60%);
    opacity: 0.6;
    cursor: help;
    user-select: none;
  }
  .latex-wysiwyg-surface :global(.latex-footnote) {
    color: hsl(40, 80%, 45%);
    cursor: help;
    vertical-align: super;
    font-size: 0.7em;
    user-select: none;
  }
  .latex-wysiwyg-surface :global(.latex-figure) {
    display: block;
    max-width: 100%;
    margin: 0.8em auto;
    border: 1px solid hsl(0, 0%, 70%);
    border-radius: 4px;
  }
  .latex-wysiwyg-surface :global(table.latex-tabular) {
    border-collapse: collapse;
    margin: 1em 0;
  }
  .latex-wysiwyg-surface :global(table.latex-tabular td) {
    border: 1px solid hsl(0, 0%, 70%);
    padding: 4px 8px;
    min-width: 2em;
  }
  .latex-wysiwyg-surface :global(.math-env) {
    display: block;
    margin: 0.8em 0;
    padding: 0.5em;
    background: rgba(80, 140, 255, 0.06);
    border-left: 3px solid rgba(80, 140, 255, 0.6);
    text-align: center;
    cursor: pointer;
  }
  .latex-wysiwyg-surface :global(.math-env:hover) {
    background: rgba(80, 140, 255, 0.14);
  }
</style>
