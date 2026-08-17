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
  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import katex from 'katex';
  import { parseLatex, serializeLatex, type ParsedLatex } from '../latexWysiwyg';
  import { readFile, writeFile } from '../api';
  import { logEvent, logError } from '../logbus';
  import { bib } from '../bibStore.svelte';
  import { buildLabelMap, resolveRefs } from '../refResolver';
  import { wireImageDrop, type UploadImageResult } from '../uploadImage';
  import LatexTableToolbar from './LatexTableToolbar.svelte';
  import WysiwygFindReplace from './WysiwygFindReplace.svelte';
  import TableWizard from './TableWizard.svelte';
  import FigureWizard from './FigureWizard.svelte';
  import TrackChangesPanel from './TrackChangesPanel.svelte';
  import { wireWysiwygPresence, type PresenceWiring } from '../wysiwygPresence';
  import { wireSpellFilter } from '../wysiwygSpellFilter';
  import { attachChangeLog, type ChangeLog } from '../changelog-collab';
  import type { Session } from '../collab';
  import {
    snapshotFormatting,
    applyFormatting,
    publishPainterAwareness,
    wirePeerFormatPainters,
    type FormatSnapshot,
  } from '../formatPainter';
  import { loadMathLive, type MathFieldElement } from '../mathlive-wrapper';

  // Y.js bridge origin sentinel — local edits tagged with this so
  // the ytext.observe callback can short-circuit our own writes.
  const WYSIWYG_LOCAL = 'wysiwyg-local';

  interface Props {
    project: string;
    file: string;
    onCursorStats?: (s: { line: number; col: number; selectionLen: number; words: number }) => void;
    /**
     * The project's collab session. The change log lives on it, so the log is
     * on the server's disk rather than in this component's Y.Doc — which is
     * why it survives a reload. The document itself has not moved yet, so
     * everything else here is still Yjs; without a session the editor works
     * and only the log is absent.
     */
    session?: Session;
  }
  let { project, file, onCursorStats, session }: Props = $props();

  // svelte-ignore non_reactive_update -- bind:this populates this; we only read it in handlers after onMount has fired.
  let editorEl: HTMLDivElement;
  let status = $state<'loading' | 'ready' | 'saving' | 'error'>('loading');
  let errorMessage = $state('');
  let dirty = $state(false);
  let savedAt = $state<number | null>(null);
  let parsed: ParsedLatex = { preamble: '', bodyHtml: '', postamble: '' };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  // ─── find & replace popover ────────────────────────────────────
  let findReplaceOpen = $state<boolean>(false);
  let dropDestroy: (() => void) | undefined;

  // insertLatexAtCaret : inserts a fresh LaTeX block (from a wizard
  // or symbol palette) at the current caret. Wraps the source in
  // a temporary div, parses it via the same latexBodyToHtml the
  // initial load uses, then splices the resulting children into
  // the live document. Renders math + cites + figures + refs over
  // the new content. Triggers onInput so the change syncs.
  function insertLatexAtCaret(latex: string) {
    if (!editorEl) return;
    editorEl.focus();
    const sel = window.getSelection();
    const range = (sel && sel.rangeCount > 0 && editorEl.contains(sel.getRangeAt(0).startContainer))
      ? sel.getRangeAt(0)
      : (() => {
          const r = document.createRange();
          r.selectNodeContents(editorEl);
          r.collapse(false);
          return r;
        })();
    // Parse the LaTeX snippet into HTML via the parser. Wrap in a
    // dummy document body so parseLatex's preamble-skipping works.
    const wrapped = '\\begin{document}\n' + latex + '\n\\end{document}';
    const tmp = parseLatex(wrapped);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = tmp.bodyHtml;
    const frag = document.createDocumentFragment();
    while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
    range.deleteContents();
    range.insertNode(frag);
    // Re-run all post-parse passes on the editor surface so the
    // newly-inserted KaTeX / cite / figure / ref spans light up.
    const labels = buildLabelMap(editorEl);
    resolveRefs(editorEl, labels);
    renderMathNodes(editorEl);
    renderCiteNodes(editorEl);
    renderFigureNodes(editorEl);
    onInput();
  }

  // ─── V0.10 add-ons ─────────────────────────────────────────────
  let tableWizardOpen = $state<boolean>(false);
  let figureWizardOpen = $state<boolean>(false);
  let trackChangesOpen = $state<boolean>(false);
  let presenceDestroy: (() => void) | undefined;
  let spellDestroy: (() => void) | undefined;
  let changeLog = $state<ChangeLog | undefined>(undefined);
  let lastSnapshot = ''; // for change-log before/after diff
  let identityName = $state<string>('me');
  let identityColor = $state<string>('hsl(220, 60%, 50%)');

  // ─── format painter ────────────────────────────────────────────
  // Word-style : click the brush → next selection inherits the
  // formatting captured at click time. The armed snapshot is also
  // broadcast on awareness.formatPainter so peers see the brush
  // light up — wirePeerFormatPainters reads that field below.
  let painterSnap = $state<FormatSnapshot | null>(null);
  let painterPresenceDestroy: (() => void) | undefined;
  function toggleFormatPainter() {
    if (painterSnap) {
      painterSnap = null; // cancel
      publishPainterAwareness(provider?.awareness, null);
      return;
    }
    const snap = snapshotFormatting(window.getSelection());
    if (snap) {
      painterSnap = snap;
      publishPainterAwareness(provider?.awareness, snap);
    }
  }
  function onSurfaceMouseUp() {
    // If the painter is armed, apply on the next selection up-event.
    if (!painterSnap) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const changed = applyFormatting(sel, painterSnap);
      painterSnap = null;
      publishPainterAwareness(provider?.awareness, null);
      if (changed) onInput();
    }
  }

  // ─── Y.js collab plumbing ──────────────────────────────────────
  // Same shape as Editor.svelte : create our own Y.Doc + WebsocketProvider
  // connected to the project's /sync WS room. Both editors (source +
  // WYSIWYG) attach to the SAME Y.Text key "file:<path>" so remote
  // edits from either side land in both views via the relay.
  let ydoc: Y.Doc | undefined;
  let provider: WebsocketProvider | undefined;
  let ytext: Y.Text | undefined;
  let muteObserver = false; // true while we're applying a remote update

  function wsURL(p: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/projects/${encodeURIComponent(p)}/sync`;
  }

  // pushToYtext : called after every local edit (debounced). Reads
  // the live host.innerHTML, serializes back to LaTeX source, and
  // writes the result into the Y.Text inside a LOCAL-origin
  // transaction so the observer below recognises it as our own.
  function pushToYtext() {
    if (!ytext || !ydoc || !editorEl) return;
    const newSource = serializeLatex(parsed, editorEl.innerHTML);
    const prev = ytext.toString();
    if (newSource === prev) return;
    ydoc.transact(() => {
      ytext!.delete(0, ytext!.length);
      ytext!.insert(0, newSource);
    }, WYSIWYG_LOCAL);
    // Record the edit in the change log so peers can review +
    // accept/reject. Skip on initial seed (prev === '').
    if (changeLog && lastSnapshot !== '' && lastSnapshot !== newSource) {
      void changeLog
        .recordChange(session!.site, identityName, identityColor, lastSnapshot, newSource)
        .catch((err) => console.error('collab: recording a change', err));
    }
    lastSnapshot = newSource;
  }

  // applyRemoteSource : called on every non-LOCAL ytext mutation
  // (peer's edit, relay-cached state). Parses the new source +
  // rewrites the host innerHTML + re-runs the render+resolve passes.
  // Caret is reset to start — V0.2 preserves it.
  function applyRemoteSource(source: string) {
    if (!editorEl) return;
    parsed = parseLatex(source);
    muteObserver = true;
    editorEl.innerHTML = parsed.bodyHtml;
    // Drain any pending MutationObserver records the innerHTML
    // assignment queued, then re-run renders.
    const labels = buildLabelMap(editorEl);
    resolveRefs(editorEl, labels);
    renderMathNodes(editorEl);
    renderCiteNodes(editorEl);
    renderFigureNodes(editorEl);
    muteObserver = false;
  }

  // ─── table toolbar ─────────────────────────────────────────────
  // Anchored at a cell when the user clicks one ; gives them
  // insert/delete row+col buttons without going to source view.
  let tableToolbarTarget = $state<{ table: HTMLTableElement; cell: HTMLTableCellElement } | null>(null);
  function onSurfaceClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const td = target.closest('td');
    if (!td) {
      tableToolbarTarget = null;
      return;
    }
    const table = td.closest('table.latex-tabular') as HTMLTableElement | null;
    if (!table) {
      tableToolbarTarget = null;
      return;
    }
    tableToolbarTarget = { table, cell: td as HTMLTableCellElement };
  }

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
  // popoverMode : the editing surface inside the math popover.
  // "source" → the original textarea + KaTeX preview.
  // "visual" → MathLive's <math-field> web component + virtual
  // keyboard. The KaTeX preview renders in both modes.
  let popoverMode = $state<'source' | 'visual'>('source');
  let mathFieldEl: MathFieldElement | undefined;
  let mathLiveReady = $state<boolean>(false);
  // mathFieldInputHandler : the listener wired to <math-field>'s
  // 'input' event. Kept in a closure so onDestroy can detach it.
  let mathFieldInputHandler: ((e: Event) => void) | undefined;
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
    // Detach any active <math-field> listener so the next popover
    // open starts clean. The element itself goes away with the DOM.
    if (mathFieldEl && mathFieldInputHandler) {
      mathFieldEl.removeEventListener('input', mathFieldInputHandler);
    }
    mathFieldEl = undefined;
    mathFieldInputHandler = undefined;
    popoverMode = 'source';
  }

  // wireMathField : Svelte action attached to the <math-field>
  // element. Seeds the field with the current tex, then listens
  // for 'input' events so popoverState.tex stays in sync as the
  // user types via the virtual keyboard. The custom element may
  // not be upgraded yet at action-call time, so the value seed
  // is wrapped in a microtask + try/catch.
  function wireMathField(node: HTMLElement) {
    mathFieldEl = node as MathFieldElement;
    const seed = () => {
      if (!mathFieldEl || !popoverState) return;
      try {
        mathFieldEl.value = popoverState.tex;
      } catch { /* not upgraded yet, retry next tick */ }
    };
    seed();
    queueMicrotask(seed);
    const handler = (_e: Event) => {
      if (!popoverState || !mathFieldEl) return;
      popoverState.tex = mathFieldEl.value ?? '';
    };
    mathFieldInputHandler = handler;
    node.addEventListener('input', handler);
    return {
      destroy() {
        node.removeEventListener('input', handler);
        if (mathFieldEl === node) mathFieldEl = undefined;
        if (mathFieldInputHandler === handler) mathFieldInputHandler = undefined;
      },
    };
  }

  // togglePopoverMode : flip between source-textarea and visual
  // math-field. The lazy MathLive load happens on first switch to
  // visual mode ; subsequent toggles reuse the already-loaded module.
  async function togglePopoverMode() {
    if (popoverMode === 'source') {
      if (!mathLiveReady) {
        try {
          await loadMathLive();
          mathLiveReady = true;
        } catch (e) {
          logError('latex-wysiwyg', 'mathlive_load_failed', e, {});
          return;
        }
      }
      popoverMode = 'visual';
    } else {
      popoverMode = 'source';
    }
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

      // Y.js bootstrap : create the same { ydoc, provider, ytext }
      // triple Editor.svelte does, so remote peers (source view in
      // split mode, OR a second browser on the same file) share the
      // ytext "file:<path>" buffer via the relay.
      ydoc = new Y.Doc();
      provider = new WebsocketProvider(wsURL(project), 'default', ydoc);
      const ytextKey = file ? 'file:' + file : 'wysiwyg';
      ytext = ydoc.getText(ytextKey);

      // Read identity from window-exposed awareness so presence
      // cursors carry the user's color/name. Falls back to a
      // deterministic-ish placeholder so dev mode still renders.
      try {
        const state = provider.awareness.getLocalState() as { user?: { name?: string; color?: string } } | null;
        if (state?.user?.name) identityName = state.user.name;
        if (state?.user?.color) identityColor = state.user.color;
      } catch { /* ignore */ }

      // Wait for the WS sync handshake OR 2 s fallback for offline.
      // Mirrors Editor.svelte's seedFromDisk window.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        provider!.once('sync', finish);
        setTimeout(finish, 2000);
      });

      // Source-of-truth resolution :
      //   - ytext has content (relay-cached OR a peer pushed) →
      //     trust it ; parse + render
      //   - else → seed from disk + push the source into ytext so
      //     peers joining later get it
      let source = ytext.toString();
      if (source.length === 0) {
        source = await readFile(project, file);
        if (source.length > 0) {
          ydoc.transact(() => { ytext!.insert(0, source); }, WYSIWYG_LOCAL);
        }
      }
      parsed = parseLatex(source);
      editorEl.innerHTML = parsed.bodyHtml;

      // Build label map BEFORE renderMathNodes : the KaTeX render
      // overwrites .math-env innerHTML which would wipe the nested
      // latex-label children parser emits for ref resolution.
      const labels = buildLabelMap(editorEl);
      resolveRefs(editorEl, labels);
      renderMathNodes(editorEl);
      renderCiteNodes(editorEl);
      renderFigureNodes(editorEl);

      // Observe ytext for remote updates. Local origin tagging
      // prevents the feedback loop.
      ytext.observe((_event, tr) => {
        if (tr.origin === WYSIWYG_LOCAL) return;
        applyRemoteSource(ytext!.toString());
      });

      // V0.10 wire-ups : presence cursors, LaTeX-aware spell filter,
      // change log for track-changes UI.
      const localClientID = ydoc.clientID;
      const presenceWiring: PresenceWiring = wireWysiwygPresence(
        editorEl,
        provider.awareness,
        localClientID,
      );
      presenceDestroy = presenceWiring.destroy;
      // Peer format-painter badges. Same overlay shape as presence
      // carets ; separate destroy so each can be unmounted on its
      // own (defensive — we tear them down together in onDestroy).
      painterPresenceDestroy = wirePeerFormatPainters(
        editorEl,
        provider.awareness,
        localClientID,
      ).destroy;
      spellDestroy = wireSpellFilter(editorEl);
      if (session) {
        changeLog = await attachChangeLog(session, file ?? '');
      }
      lastSnapshot = ytext.toString();

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
    if (muteObserver) return; // applying a remote update, skip echo
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void save(); }, 600);
    // Push to Y.Text immediately so peers see edits sub-second.
    // The disk save still debounces ; the ytext push is cheap +
    // lossy-safe (overwrite the whole string).
    pushToYtext();
    emitCursorStats();
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      // Only intercept Cmd/Ctrl+F when the WYSIWYG surface has
      // focus — otherwise the browser's native find should fire on
      // out-of-editor regions.
      if (editorEl && editorEl.contains(document.activeElement)) {
        e.preventDefault();
        findReplaceOpen = true;
      }
    }
  }

  // ─── cursor stats ───────────────────────────────────────────────
  // Emits the same shape Editor.svelte does so the StatusBar sees
  // the same line/col/selection/words signal in WYSIWYG mode.
  // Counts WORDS off the contenteditable's plain textContent and
  // SELECTION length off the live selection range.
  function emitCursorStats() {
    if (!onCursorStats || !editorEl) return;
    const text = editorEl.textContent ?? '';
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    let line = 1, col = 1, selectionLen = 0;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (editorEl.contains(range.startContainer)) {
        // Approximate line/col : count newlines + chars-since-last-newline
        // in the text before the caret. The contenteditable doesn't have
        // a real line model, but the textContent slice is good enough
        // for status-bar UX.
        const pre = document.createRange();
        pre.setStart(editorEl, 0);
        pre.setEnd(range.startContainer, range.startOffset);
        const beforeText = pre.toString();
        const newlines = beforeText.split('\n');
        line = newlines.length;
        col = newlines[newlines.length - 1].length + 1;
        selectionLen = range.toString().length;
      }
    }
    onCursorStats({ line, col, selectionLen, words });
  }
  function onSelectionChange() {
    if (status === 'ready') {
      emitCursorStats();
      publishLocalSelection();
    }
  }

  // publishLocalSelection : push our caret/selection offsets into
  // Y.js Awareness so peers can paint our presence cursor in their
  // wysiwygPresence overlay. No-op outside ready + when not focused.
  function publishLocalSelection() {
    if (!editorEl || !provider) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!editorEl.contains(range.startContainer)) return;
    try {
      const pre = document.createRange();
      pre.setStart(editorEl, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const startOffset = pre.toString().length;
      pre.setEnd(range.endContainer, range.endOffset);
      const endOffset = pre.toString().length;
      provider.awareness.setLocalStateField('wysiwygSelection', { startOffset, endOffset });
    } catch { /* selectionchange races, ignore */ }
  }

  // onDrop : inserts an <img class="latex-figure"> at the drop point
  // after wireImageDrop uploads the file. The figure spans round-trip
  // back to \includegraphics{path} via serializeLatex.
  function onDrop(result: UploadImageResult, ev: DragEvent) {
    const img = document.createElement('img');
    img.className = 'latex-figure';
    img.setAttribute('data-path', result.path);
    img.setAttribute('data-opts', '');
    img.setAttribute('alt', result.path);
    img.src = '/api/projects/' + encodeURIComponent(project)
      + '/files/' + result.path.split('/').map(encodeURIComponent).join('/');
    img.contentEditable = 'false';
    // Insert at the caret if the user clicked, else append at end.
    let inserted = false;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (pos) {
        const range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
        range.insertNode(img);
        inserted = true;
      }
    }
    if (!inserted) editorEl.appendChild(img);
    onInput();
  }

  // Reject-a-change handler : TrackChangesPanel dispatches this
  // window event ; the editor rewrites Y.Text back to the change's
  // `before` snapshot. V0.1 safety : only safe when the rejected
  // change is the LAST one (no concurrent edits on top).
  function onRollbackChange(e: Event) {
    const detail = (e as CustomEvent).detail as { id: string; before: string } | null;
    if (!detail || !ytext || !ydoc) return;
    ydoc.transact(() => {
      ytext!.delete(0, ytext!.length);
      ytext!.insert(0, detail.before);
    }, WYSIWYG_LOCAL);
    applyRemoteSource(detail.before);
    lastSnapshot = detail.before;
  }

  onMount(() => {
    void load();
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('weft-loom:rollback-change', onRollbackChange);
    // Wire drag-drop image upload after the editor is mounted.
    if (editorEl) {
      dropDestroy = wireImageDrop(editorEl, project, onDrop);
    }
  });
  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    document.removeEventListener('selectionchange', onSelectionChange);
    window.removeEventListener('weft-loom:rollback-change', onRollbackChange);
    dropDestroy?.();
    presenceDestroy?.();
    painterPresenceDestroy?.();
    spellDestroy?.();
    try { changeLog?.destroy(); } catch { /* ignore */ }
    try { provider?.destroy(); } catch { /* ignore */ }
    try { ydoc?.destroy(); } catch { /* ignore */ }
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="latex-wysiwyg h-full w-full flex flex-col bg-base-100 relative">
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
    <span class="opacity-30">·</span>
    <button
      class="btn btn-xs"
      onclick={() => window.dispatchEvent(new CustomEvent('weft-loom:toggle-palette'))}
      title="LaTeX symbol palette (Greek, operators, brackets, envs)"
      aria-label="Toggle LaTeX symbol palette"
    >Σ Symbols</button>
    <span class="opacity-30">·</span>
    <button
      class="btn btn-xs"
      onclick={() => (findReplaceOpen = !findReplaceOpen)}
      title="Find & replace (Cmd/Ctrl+F)"
      aria-label="Find and replace"
    >🔍 Find</button>
    <span class="opacity-30">·</span>
    <div class="join">
      <button class="join-item btn btn-xs" onclick={() => (tableWizardOpen = true)} title="Table wizard">▦ Table</button>
      <button class="join-item btn btn-xs" onclick={() => (figureWizardOpen = true)} title="Figure wizard">🖼 Figure</button>
    </div>
    <span class="opacity-30">·</span>
    <button
      class="btn btn-xs"
      onclick={() => (trackChangesOpen = !trackChangesOpen)}
      title="Track changes (review pending edits)"
      aria-label="Track changes"
    >🔖 Changes</button>
    <span class="opacity-30">·</span>
    <button
      class="btn btn-xs"
      class:btn-active={painterSnap !== null}
      aria-pressed={painterSnap !== null}
      onclick={toggleFormatPainter}
      title="Format painter — click sample text, then select target"
      aria-label="Format painter"
    >🎨 Paint</button>
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
    onclick={onSurfaceClick}
    onmouseup={onSurfaceMouseUp}
    data-testid="latex-wysiwyg-surface"
  ></div>

  {#if tableToolbarTarget}
    <LatexTableToolbar
      table={tableToolbarTarget.table}
      cell={tableToolbarTarget.cell}
      onChange={onInput}
      onClose={() => (tableToolbarTarget = null)}
    />
  {/if}

  {#if findReplaceOpen && editorEl}
    <WysiwygFindReplace
      host={editorEl}
      onChange={onInput}
      onClose={() => (findReplaceOpen = false)}
    />
  {/if}

  <TableWizard
    bind:open={tableWizardOpen}
    onInsert={(latex) => insertLatexAtCaret(latex)}
    onClose={() => (tableWizardOpen = false)}
  />

  <FigureWizard
    bind:open={figureWizardOpen}
    {project}
    onInsert={(latex) => insertLatexAtCaret(latex)}
    onClose={() => (figureWizardOpen = false)}
  />

  {#if trackChangesOpen && changeLog}
    <TrackChangesPanel
      log={changeLog}
      onClose={() => (trackChangesOpen = false)}
    />
  {/if}

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
          <!-- Source ⟷ Visual toggle : Source = the textarea below,
               Visual = MathLive's <math-field> web component with
               virtual keyboard + live LaTeX output. -->
          <div class="join ml-2" role="tablist" aria-label="Editor mode">
            <button
              type="button"
              class="join-item btn btn-xs"
              class:btn-active={popoverMode === 'source'}
              aria-pressed={popoverMode === 'source'}
              onclick={() => { popoverMode = 'source'; }}
              title="LaTeX source textarea"
            >Source</button>
            <button
              type="button"
              class="join-item btn btn-xs"
              class:btn-active={popoverMode === 'visual'}
              aria-pressed={popoverMode === 'visual'}
              onclick={togglePopoverMode}
              title="Visual math editor (MathLive)"
            >Visual</button>
          </div>
          <span class="ml-auto opacity-60">Enter = apply · Esc = cancel</span>
        </div>
        {#if popoverMode === 'source'}
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
        {:else}
          <!-- MathLive <math-field> : custom element registered via
               loadMathLive(). The use:action seeds value + attaches
               the input listener so popoverState.tex stays live.
               It's a runtime-registered web component, hence the
               svelte:element wrapper. -->
          <svelte:element
            this={'math-field'}
            use:wireMathField
            class="mathlive-field w-80"
            aria-label="LaTeX math (visual)"
          ></svelte:element>
        {/if}
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
  /* MathLive's <math-field> isn't a known element to Svelte/TS but
     it's a real Custom Element registered by `import('mathlive')`.
     The width/height match the textarea it replaces ; the math
     font family hints the OS to pick a math-aware face when the
     element is rendering plain glyphs (the upgraded element
     handles its own typography internally). */
  .math-popover :global(math-field.mathlive-field) {
    display: block;
    width: 100%;
    min-height: 5rem;
    font-family: math, serif;
    font-size: 14px;
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
