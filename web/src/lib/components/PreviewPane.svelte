<script lang="ts">
  // PreviewPane — live in-window preview of the current document.
  //
  // Hooks into the Yjs document the Editor sits on (shared `codemirror`
  // ytext) and re-renders the right pane on every change, debounced.
  //
  //   language == 'markdown' → marked.parse → DOMPurify → HTML
  //   language == 'latex'    → split into prose / $...$ / $$...$$
  //                            segments ; prose stays as <pre>, math
  //                            renders via KaTeX. NOT a full LaTeX
  //                            compile — that needs the compile RPC
  //                            (V0.3) ; once the PDF lands we'll
  //                            embed PDF.js here.
  //   other                  → <pre> mirror of the text, in monospace
  //
  // No download of artefacts — this is the **inline** preview the
  // user asked for : edits land on the left, rendering changes on the
  // right within ~100ms.
  import { onDestroy } from 'svelte';
  import * as Y from 'yjs';
  import { marked } from 'marked';
  import markedKatex from 'marked-katex-extension';
  import { markedHighlight } from 'marked-highlight';
  import { gfmHeadingId } from 'marked-gfm-heading-id';
  import DOMPurify from 'dompurify';
  import 'katex/dist/katex.css';
  // GitHub Markdown CSS gives the rendered HTML the same visual
  // signature as github.com (headings, tables, blockquotes, code,
  // task-lists). The "light" build wins by default ; the daisyUI
  // dark themes get overridden by our :global() rules.
  import 'github-markdown-css/github-markdown.css';
  // highlight.js auto-detects the language of each fenced block ;
  // the CSS picks `github-dark` so the colour palette matches the
  // rest of weft-loom's default dark theme.
  import hljs from 'highlight.js';
  import 'highlight.js/styles/github-dark.css';
  import NotebookPreview from './NotebookPreview.svelte';
  import PdfViewer from './PdfViewer.svelte';
  import { parseRTF } from '../rtf';
  import { marpThemeStyle } from '../marp';
  import { expandTemplate } from '../templateExpr';
  import { compileDiagnostics } from '../compileDiagnostics.svelte';

  // Marked KaTeX extension : $...$ and $$...$$ in markdown render
  // alongside the GFM blocks. throwOnError=false keeps invalid math
  // visible as plain text rather than breaking the whole preview.
  // Marked pipeline mirrors GitHub's : GFM + heading IDs (anchor
  // links) + syntax-highlighted fenced code via highlight.js + KaTeX
  // math. Order matters : markedHighlight registers a renderer.code
  // override, markedKatex registers tokenizers for $...$ which must
  // run before code-block tokenization to keep $ inside fences raw.
  marked.use(gfmHeadingId());
  marked.use(
    markedHighlight({
      langPrefix: 'hljs language-',
      highlight(code: string, lang: string): string {
        const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
        try {
          return hljs.highlight(code, { language, ignoreIllegals: true }).value;
        } catch {
          return code;
        }
      },
    }),
  );
  marked.use(
    markedKatex({
      throwOnError: false,
      output: 'html',
    }),
  );
  marked.setOptions({ gfm: true, breaks: false });

  interface Props {
    ydoc: Y.Doc | undefined;
    language: string;
    // file is the active file path within the project. Empty maps to
    // the legacy single-ytext key "codemirror" ; a file path X maps
    // to "file:X" so the preview tracks the same ytext the Editor
    // is editing.
    file?: string;
    // project is needed for the notebook preview to fetch the .ipynb
    // file via the project files API (the regular preview reads from
    // the shared Y.Doc, but notebooks own their own JSON parser +
    // serialiser so the round-trip stays clean).
    project?: string;
    // pdfURL is set by CompileDrawer when the compile result arrives.
    // When non-empty and language='latex', the pane swaps to a
    // browser-native <embed type="application/pdf"> so the PDF
    // renders inline (no download). The user toggles back to the
    // source preview via the "▦ Source" button.
    pdfURL?: string;
    // Click handler for the "N errors" pill in the header. Set by
    // App.svelte to open the BottomPanel's Errors sub-tab.
    onShowErrors?: () => void;
    // Close the preview column (the panel is independent of file
    // type now — same lifecycle as ChatRoom / AIChatPanel).
    onClose?: () => void;
    // Explicit panel width in px — owned by App.svelte's drag
    // handler. Bypasses the intermediate wrapper div so the panel's
    // header sits at exactly the same y-coordinate as ChatRoom's.
    width?: number;
  }

  let { ydoc, language, file, project, pdfURL, onShowErrors, onClose, width }: Props = $props();

  // Notebooks bypass the Y.Doc-backed renderer entirely : their cell
  // structure + outputs come from a JSON parse of the .ipynb file
  // (NotebookPreview re-fetches on a 1.5s poll).
  const isNotebook = $derived(!!file && file.endsWith('.ipynb'));

  // showPDF flips to true automatically when a fresh PDF URL arrives ;
  // the user can flip back to "▦ Source" to see the mini-renderer
  // again. New PDF lands → snap back to PDF view.
  let showPDF = $state(false);
  $effect(() => {
    if (pdfURL) showPDF = true;
  });
  // Reset the PDF toggle when the artefact URL is cleared OR the
  // active file changes ; otherwise we'd keep showing a stale PDF
  // viewer over an unrelated file. App.svelte still owns clearing
  // artifactURL on file change ; this local reset is the safety net.
  $effect(() => {
    file;
    if (!pdfURL) showPDF = false;
  });

  let html: string = $state('');
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let ytext: Y.Text | undefined;
  let observer: (() => void) | undefined;
  // Track whether the renderer is currently busy. Flipped true at
  // the start of each debounced re-render, false in the finally
  // branch. The overlay below uses this to show a loading spinner
  // only when the work actually takes more than ~50 ms — small
  // markdown files don't need a flash.
  let rendering = $state<boolean>(false);
  // Until the first render lands we count as loading so the empty
  // pane doesn't read as "no content" before the ytext sync.
  let firstRenderDone = $state<boolean>(false);

  function escapeHTML(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // parseFrontMatter : pulls a YAML-ish front-matter block out of the
  // source. Returns { meta, body }. We only need a handful of keys
  // (marp, theme, paginate, size) — full YAML compliance not required
  // for the preview heuristic.
  function parseFrontMatter(src: string): { meta: Record<string, string>; body: string } {
    const m = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!m) return { meta: {}, body: src };
    const meta: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^\s*(\w+)\s*:\s*(.*?)\s*$/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].toLowerCase();
    }
    return { meta, body: src.slice(m[0].length) };
  }

  // Marp theme styling lives in ../marp.ts so the autocomplete provider
  // can share the catalogue with this preview. marpThemeStyle returns a
  // safe default for unknown themes.

  // renderMarkdown : detects a YAML front-matter `marp: true` and
  // falls into the Marp slide renderer ; otherwise plain GFM with
  // KaTeX math. DOMPurify-sanitised in both cases.
  function renderMarkdown(rawSrc: string): string {
    // Expand `${expression}` placeholders before parsing the
    // front-matter or the body. Authors use this for slowly-aging
    // values (year, build date, derived counters). The escape form
    // `$${literal}` survives untouched.
    const src = expandTemplate(rawSrc, { file: file || '', project: project || '' });
    const { meta, body } = parseFrontMatter(src);
    const isMarp = meta.marp === 'true';
    if (isMarp) {
      const themeStyle = marpThemeStyle(meta.theme || 'default');
      const paginate = meta.paginate === 'true';
      // Parse the size directive into an aspect ratio. Marp accepts
      // "16:9", "4:3", or "<w>x<h>" pixel dims (e.g. "1280x720").
      // Fallback to 16:9 when unset / unparseable.
      let aspect = '16 / 9';
      const sz = meta.size || '16:9';
      const colon = sz.match(/^(\d+)\s*:\s*(\d+)$/);
      const xform = sz.match(/^(\d+)\s*x\s*(\d+)$/);
      if (colon) aspect = colon[1] + ' / ' + colon[2];
      else if (xform) aspect = xform[1] + ' / ' + xform[2];
      // Split into slides on a standalone "---" line. marked treats
      // these as <hr> in plain markdown ; we promote them to slide
      // breaks here.
      const slides = body.split(/\n---\s*\n/);
      const cards = slides.map((s, i) => {
        const html = marked.parse(s, { async: false, gfm: true }) as string;
        const page = paginate
          ? '<div class="text-xs opacity-50 mt-2 text-right">' + (i + 1) + ' / ' + slides.length + '</div>'
          : '';
        return (
          '<div class="rounded-box border my-4 p-6 shadow-sm overflow-hidden flex flex-col justify-start" style="aspect-ratio:' +
          aspect +
          ';' +
          themeStyle +
          '">' +
          html +
          page +
          '</div>'
        );
      });
      return DOMPurify.sanitize(cards.join(''), {
        ADD_TAGS: ['math', 'mrow', 'mi', 'mo', 'mn', 'mfrac', 'msup', 'msub'],
        ADD_ATTR: ['style'],
      });
    }
    const raw = marked.parse(src, { async: false, gfm: true }) as string;
    return DOMPurify.sanitize(raw, {
      // KaTeX MathML : math/mrow/etc — and GFM extras we want
      // to keep : task-list `<input type=checkbox>` (DOMPurify
      // strips inputs by default), `id` on headings (anchor links),
      // `class` for hljs/markdown-body styling.
      ADD_TAGS: ['math', 'mrow', 'mi', 'mo', 'mn', 'mfrac', 'msup', 'msub'],
      ADD_ATTR: ['id', 'class', 'type', 'checked', 'disabled'],
    });
  }

  function render(src: string) {
    switch (language) {
      case 'markdown':
        html = renderMarkdown(src);
        break;
      case 'latex':
        // For LaTeX we ONLY show the compiled PDF (when pdfURL is
        // set). The inline KaTeX-on-source rendering was misleading
        // — it never matched the real pdflatex output. Until the
        // compile button is clicked, show a clear placeholder.
        html = pdfURL
          ? '' // PDF embed renders separately ; html stays empty
          : '<div class="opacity-60 italic p-4 text-sm">'
            + 'Click <b>Run</b> in the Compile log tab to render the PDF here.'
            + '</div>';
        break;
      case 'rtf': {
        const parsed = parseRTF(src);
        // Sanitise (the parser already escapes < > but DOMPurify
        // double-guards against future-me adding new tags).
        html = DOMPurify.sanitize(parsed.html, {
          ALLOWED_TAGS: ['b', 'i', 'u', 'br', 'p', 'em', 'strong'],
          ALLOWED_ATTR: [],
        });
        break;
      }
      default:
        html =
          '<pre class="whitespace-pre-wrap text-base-content">' +
          escapeHTML(src) +
          '</pre>';
    }
  }

  function scheduleRender() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const src = ytext?.toString() ?? '';
      rendering = true;
      try {
        render(src);
      } finally {
        rendering = false;
        firstRenderDone = true;
      }
    }, 100);
  }

  // Re-subscribe when ydoc changes (different project).
  $effect(() => {
    if (observer) {
      ytext?.unobserve(observer);
      observer = undefined;
    }
    ytext = undefined;
    if (!ydoc) {
      html = '<div class="text-base-content/60 p-4 italic">No document loaded</div>';
      return;
    }
    const ytextKey = file && file !== '' ? 'file:' + file : 'codemirror';
    ytext = ydoc.getText(ytextKey);
    render(ytext.toString());
    observer = () => scheduleRender();
    ytext.observe(observer);
  });

  onDestroy(() => {
    if (debounce) clearTimeout(debounce);
    if (observer) ytext?.unobserve(observer);
  });
</script>

{#if isNotebook && project && file}
  <NotebookPreview {project} {file} />
{:else}
<!-- Same outer geometry as ChatRoom : `<aside flex-none border-l>`
     with an explicit width — no intermediate wrapper div, so the
     header sits flush against the top of the row exactly like
     ChatRoom's header. `flex-none` keeps the panel from collapsing
     when the row is tight. -->
<aside
  class="flex-none flex flex-col bg-base-100 border-l border-base-300 overflow-hidden"
  style={width != null ? 'width: ' + width + 'px' : 'width: 100%'}
>
  <!-- Permanent header label — same visual signature as the
       CollaboratorsSidebar header so the two side panels read as a
       pair. The PDF/Source toggle below only renders when there's
       a compiled PDF available. -->
  <!-- Header padding kept on `py-2` so the height matches every
       other panel header (Editor toolbar, AIChatPanel, ChatRoom,
       CollaboratorsSidebar) exactly. All badges in this header are
       forced to `badge-xs` so they don't push the row taller than
       the text baseline. -->
  <header class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200">
    <span class="font-semibold text-sm flex items-center gap-1">
      <!-- codicon `open-preview` — eye+page glyph that matches the
           rest of the VSCode-style ActivityBar / BottomPanel icons. -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M2 3h11l1 1v8.5l-.5.5H8.71l-2.36 2.35L5.5 15v-2H2l-1-1V3.99L2 3zm0 8.99h4v1.3l1.29-1.3H13V4H2v7.99zM13.27 0H4.06l-.71.7-.16.71.71.7L4.05 2H14v9.24l-.04.16.7.71h.71l.7-.71V.99L14.27 0h-1z"/>
      </svg>
      Preview
    </span>
    {#if file && language}
      <!-- Only show the language badge once we actually have a
           file open — the default 'markdown' on an empty preview
           was misleading. -->
      <span class="ml-2 badge badge-ghost badge-xs font-mono">{language}</span>
    {/if}
    {#if file}
      <span class="ml-2 text-xs opacity-50 truncate font-mono">{file}</span>
    {/if}
    {#if compileDiagnostics.items.length > 0}
      <!-- Quick-access pill : the user looking at the preview sees
           the error count immediately + can jump straight to the
           Errors sub-tab in the BottomPanel without hunting. -->
      <button
        class="ml-auto badge badge-error badge-sm gap-1 cursor-pointer"
        onclick={onShowErrors}
        title="Show compile errors"
      >
        ⚠ {compileDiagnostics.items.length} {compileDiagnostics.items.length === 1 ? 'error' : 'errors'}
      </button>
    {/if}
    {#if onClose}
      <!-- Close ✕ ; mirrors ChatRoom + AIChatPanel + Collaborators. -->
      <button
        class="btn btn-ghost btn-xs"
        class:ml-auto={compileDiagnostics.items.length === 0}
        onclick={onClose}
        title="Hide preview panel"
        aria-label="Close preview"
      >✕</button>
    {/if}
  </header>

  {#if pdfURL && language === 'latex'}
    <div class="flex items-center gap-2 px-3 py-1 border-b border-base-300 bg-base-200 text-xs">
      <div class="join">
        <button
          class="join-item btn btn-xs"
          class:btn-active={showPDF}
          onclick={() => (showPDF = true)}
          title="Compiled PDF"
        >📄 PDF</button>
        <button
          class="join-item btn btn-xs"
          class:btn-active={!showPDF}
          onclick={() => (showPDF = false)}
          title="Source render (KaTeX + minimal LaTeX → HTML)"
        >▦ Source</button>
      </div>
      <span class="opacity-50 truncate font-mono">{pdfURL}</span>
      <span class="ml-auto"></span>
      <!-- Download : anchor with `download` attribute, browser saves
           the PDF without opening it in a new tab. The job-id-based
           filename keeps successive compiles distinguishable in the
           downloads folder. -->
      <a
        class="btn btn-xs btn-ghost"
        href={pdfURL}
        download={(file || 'output').replace(/\.[^./]+$/, '') + '.pdf'}
        title="Download the compiled PDF"
      >⤓ Download</a>
    </div>
  {/if}

  {#if pdfURL && language === 'latex' && showPDF}
    <!-- T5b : PDF.js-backed viewer replaces the browser-native
         <embed> so we can intercept clicks + send (page, x, y) to
         the SyncTeX endpoint, then jump to the matching source
         line via window.weftLoomSyncTeXBackward (set in App.svelte).
         The viewer also honours `#page=N` fragments the forward
         SyncTeX path leaves on pdfURL. -->
    <PdfViewer
      src={pdfURL}
      onClickPage={(page, x, y) => {
        const fn = (window as unknown as {
          weftLoomSyncTeXBackward?: (p: number, x: number, y: number) => Promise<unknown>;
        }).weftLoomSyncTeXBackward;
        if (typeof fn === 'function') void fn(page, x, y);
      }}
    />
  {:else}
    <div class="flex-1 relative overflow-hidden" data-pdf-source>
      <div class="absolute inset-0 overflow-auto p-6 markdown-body max-w-none">
        {@html html}
      </div>
      {#if file && (!firstRenderDone || rendering)}
        <!-- Spinner overlay : visible until the first render lands +
             during any subsequent re-render that takes long enough
             to flash. Gated on `file` so the empty-state ("no file
             selected") doesn't show a perpetual loader.
             backdrop-blur-sm keeps the existing render visible
             underneath so the user sees "refreshing" rather than
             "empty". -->
        <div
          class="absolute inset-0 flex items-center justify-center pointer-events-none bg-base-100/50 backdrop-blur-sm z-10"
          aria-live="polite"
        >
          <div class="flex items-center gap-3 px-4 py-2 rounded-md bg-base-100 border border-base-300 shadow text-sm">
            <span class="loading loading-spinner loading-sm"></span>
            <span class="opacity-80">{firstRenderDone ? 'Refreshing' : 'Rendering'} {language || 'preview'}…</span>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</aside>
{/if}

<style>
  /* GitHub Markdown CSS sets its own background ; force inherit so
     daisyUI themes show through. Padding lives on the wrapper, not
     the `.markdown-body` root, so the CSS defaults don't fight us. */
  :global(.markdown-body) {
    background-color: transparent !important;
    color: inherit !important;
    font-family: inherit !important;
    box-sizing: border-box;
  }
  /* Keep KaTeX font separate from GFM body font ; otherwise the
     hljs/github-dark style overrides KaTeX's <span class="katex">. */
  :global(.markdown-body .katex *) { color: inherit !important; }
  /* Bring back default markdown styling DOMPurify strips. Tailwind's
     `prose` plugin would do this for us if we had `@tailwindcss/typography`
     installed ; for now hand-craft the bits the preview actually uses. */
  /* Heading auto-numbering matches the WYSIWYG editor's pattern. */
  :global(.prose) { counter-reset: sec 0 ssec 0 sssec 0; }
  :global(.prose h1) {
    font-size: 1.75rem; font-weight: 700; margin: 1rem 0;
    counter-increment: sec; counter-reset: ssec 0 sssec 0;
  }
  :global(.prose h1):not(.no-num)::before {
    content: counter(sec) ". ";
    color: rgba(0, 100, 200, 0.7);
  }
  :global(.prose h2) {
    font-size: 1.4rem; font-weight: 700; margin: 0.8rem 0;
    counter-increment: ssec; counter-reset: sssec 0;
  }
  :global(.prose h2):not(.no-num)::before {
    content: counter(sec) "." counter(ssec) " ";
    color: rgba(0, 100, 200, 0.7);
  }
  :global(.prose h3) {
    font-size: 1.15rem; font-weight: 600; margin: 0.6rem 0;
    counter-increment: sssec;
  }
  :global(.prose h3):not(.no-num)::before {
    content: counter(sec) "." counter(ssec) "." counter(sssec) " ";
    color: rgba(0, 100, 200, 0.7);
  }
  :global(.prose p)  { margin: 0.5rem 0; line-height: 1.6; }
  :global(.prose ul), :global(.prose ol) { margin: 0.5rem 0 0.5rem 1.5rem; }
  :global(.prose code) { background: rgba(127,127,127,0.15); padding: 0.1rem 0.3rem; border-radius: 0.2rem; }
  :global(.prose pre) { background: rgba(127,127,127,0.08); padding: 0.75rem; border-radius: 0.4rem; overflow-x: auto; }
  :global(.prose pre code) { background: transparent; padding: 0; }
  :global(.prose blockquote) { border-left: 3px solid rgba(127,127,127,0.3); padding-left: 0.75rem; color: rgba(127,127,127,1); }
  :global(.prose table) { border-collapse: collapse; }
  :global(.prose th), :global(.prose td) { border: 1px solid rgba(127,127,127,0.3); padding: 0.3rem 0.6rem; }
</style>
