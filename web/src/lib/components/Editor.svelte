<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { logEvent, logError } from '../logbus';
  import { Compartment, EditorState } from '@codemirror/state';
  import { EditorView, keymap, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
  import { authorshipExtension } from '../authorship';
  import {
    defaultKeymap,
    history,
    historyKeymap,
    toggleComment,
    toggleBlockComment,
    indentMore,
    indentLess,
  } from '@codemirror/commands';
  import {
    syntaxHighlighting,
    defaultHighlightStyle,
    HighlightStyle,
    indentOnInput,
    bracketMatching,
    StreamLanguage,
    foldGutter,
    foldKeymap,
  } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';
  import { autocompletion } from '@codemirror/autocomplete';
  import { marpMetadataCompletion } from '../marpAutocomplete';
  import { codeblockLanguageCompletion } from '../codeblockAutocomplete';
  import { snippetSource } from '../snippets';
  // Language packs (@codemirror/lang-* + @codemirror/legacy-modes/*)
  // are lazy-loaded via dynamic import in loadLanguagePack() below
  // so the cold-load bundle stays small (each pack is 50-150 KB).
  // The editor mounts immediately with no pack — the Compartment
  // gets reconfigured with the real pack as soon as the chunk
  // arrives. See loadLanguagePack() for the cache + dispatch.
  // Custom HCL StreamLanguage — own block / heredoc / interpolation
  // tokenizer ; designed to be contributed back to
  // @codemirror/legacy-modes (no weft-loom deps). Zig still falls
  // back to rust for now until a real Zig pack lands.
  import { closeBrackets } from '@codemirror/autocomplete';
  import { latexRichText, richTextCompartment, applyLatexCommand, type LatexCommand } from '../latexRichText';
  import { settings, vscodeThemes } from '../settings.svelte';
  import { buildVSCodeThemeExtension, vscodeThemeCompartment } from '../vscodeThemeApply.svelte';
  import { lintExtension, lintCompartment } from '../lintAll.svelte';
  import { compileDiagnostics } from '../compileDiagnostics.svelte';
  import { showMinimap } from '@replit/codemirror-minimap';
  import { citeCompletion } from '../citeAutocomplete';
  import { inlineMathRender } from '../inlineMathRender';
  import { visibilityCheckExtension } from '../editorVisibilityCheck';
  import { sectionFolding } from '../sectionFolding';
  import { createLSPClient, fetchAvailableLanguages, type LSPClient } from '../lspClient';
  import { linter } from '@codemirror/lint';
  import { hoverTooltip } from '@codemirror/view';
  import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
  import { commentDecorations, setCommentRanges, type CommentRange } from '../commentDecorations';
  import { citeHover } from '../citeHover';
  import { bib } from '../bibStore.svelte';
  import { search, searchKeymap, selectNextOccurrence } from '@codemirror/search';
  import { EditorState as ES, type Extension } from '@codemirror/state';
  import { lineNumbers as lineNumbersExt } from '@codemirror/view';

  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import { yjsBinding, YORIGIN_LOCAL } from '../ybinding';
  import type { Awareness } from 'y-protocols/awareness';
  import { presenceCursors } from '../presence';
  import type { Identity } from '../identity';
  import { readFile, writeFile } from '../api';

  interface Props {
    project: string;
    language: string;
    file?: string;
    identity: Identity;
    onStatus?: (
      status: 'connecting' | 'connected' | 'disconnected',
    ) => void;
    onYDoc?: (doc: Y.Doc) => void;
    onAwareness?: (a: Awareness) => void;
    // onYTextTick fires every time the Y.Text observes a change
    // (local OR remote). Surfaced in the navbar as a counter so we
    // can confirm whether remote updates actually reach the local
    // Y.Text — if A types and B's tick doesn't increment, the WS
    // message arrived (server log confirms) but never reached the
    // text CRDT.
    onYTextTick?: (n: number) => void;
    // Cursor + selection stats : surfaced for the StatusBar's
    // "Ln N, Col M" + word-count slots. Fires on every selection
    // change. Word counter is a cheap whitespace split — exact
    // counts (excluding URLs / tags) are V0.9.
    onCursorStats?: (s: { line: number; col: number; selectionLen: number; words: number }) => void;
    // revisionMode toggles the authorship background-tint extension.
    // When true, every character is painted with the colour of the
    // peer who typed it (look-up via awareness.user.color). When
    // false the editor renders with the normal CodeMirror theme.
    revisionMode?: boolean;
    // jumpToLine drives a "scroll the editor to line N" effect from
    // the parent (OutlinePanel click). Any non-zero value moves the
    // caret to that line ; re-clicking the same line is fine since
    // the dispatch is idempotent on the actual position.
    jumpToLine?: number;
  }

  let { project, language, file, identity, onStatus, onYDoc, onAwareness, onYTextTick, onCursorStats, revisionMode, jumpToLine }: Props = $props();

  // Rich-text mode for LaTeX : Overleaf-style inline decorations.
  // Inline rich-text decoration mode : decorates the LaTeX source
  // so headings appear sized + bold inline, math renders as KaTeX
  // widgets, etc. The user pointed out this "in-source" mode is the
  // wrong UX for LaTeX (Overleaf's Rich Text is a SEPARATE WYSIWYG
  // view, not in-source decorations). Default OFF now — the
  // PreviewPane carries the "rendered view" role ; the source pane
  // stays clean. The toggle remains for users who liked the
  // decorations. Truly editable Word-like view = V0.9 follow-up
  // (HTML contenteditable round-tripping back to LaTeX).
  let richTextEnabled = $state<boolean>(
    (() => {
      try { return localStorage.getItem('weft-loom-rich-text') === '1'; } catch { return false; }
    })(),
  );
  function toggleRichText() {
    richTextEnabled = !richTextEnabled;
    try { localStorage.setItem('weft-loom-rich-text', richTextEnabled ? '1' : '0'); } catch { /* ignore */ }
    if (view) {
      view.dispatch({
        effects: richTextCompartment.reconfigure(
          latexRichText(language === 'latex' && richTextEnabled, project),
        ),
      });
    }
  }

  function fmt(cmd: LatexCommand) {
    if (view) applyLatexCommand(view, cmd);
  }

  // Cursor + selection + word-count stats — emitted to App.svelte
  // which pipes them into the StatusBar. The CM updateListener
  // below calls this on every doc or selection change.
  //
  // Hot path : called on every keystroke. The earlier implementation
  // materialised the ENTIRE document to a JS string + regex-split on
  // whitespace whenever the selection was empty (the common case),
  // costing O(N) per keystroke on multi-KB docs. We now :
  //   1. emit line/col/selectionLen synchronously (cheap : doc.lineAt
  //      is O(log N) ; selection bookkeeping is O(1)).
  //   2. for selections, count words off the (small) selection slice
  //      synchronously — selecting is a deliberate action so the user
  //      tolerates the burst.
  //   3. for caret-only, re-emit the LAST known word count immediately
  //      and schedule a debounced rescan (250 ms quiet) before
  //      surfacing the fresh value.
  //   4. for docs over 100 KB we count runs-of-non-whitespace in a
  //      single linear pass over the doc text iterator — same answer
  //      as the regex split but no intermediate array.
  // See perf-audit-2026-06-14 H2.
  const WORD_COUNT_DEBOUNCE_MS = 250;
  const WORD_COUNT_LINEAR_THRESHOLD = 100 * 1024;
  let cachedWords = 0;
  let wordsDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  function countWordsInString(s: string): number {
    return s.split(/\s+/).filter(Boolean).length;
  }
  // Linear non-whitespace-run count without materialising the full
  // doc as a single JS string. CodeMirror's Text.iter yields chunks
  // we can walk character-by-character, tracking whether the previous
  // char was whitespace to detect word boundaries. Result matches
  // `s.split(/\s+/).filter(Boolean).length` for ASCII + UTF-16 BMP.
  function countWordsLinear(doc: import('@codemirror/state').Text): number {
    let words = 0;
    let prevWS = true;
    const iter = doc.iter();
    while (!iter.next().done) {
      const chunk = iter.value;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk.charCodeAt(i);
        // ASCII whitespace + common Unicode line breaks. The previous
        // regex was /\s+/ which is JS \s — this approximates it well
        // for the codepoints typists actually produce.
        const isWS = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160;
        if (prevWS && !isWS) words++;
        prevWS = isWS;
      }
    }
    return words;
  }

  function recomputeFullDocWords() {
    if (!view) return;
    const doc = view.state.doc;
    cachedWords = doc.length >= WORD_COUNT_LINEAR_THRESHOLD
      ? countWordsLinear(doc)
      : countWordsInString(doc.toString());
    // Re-emit with the up-to-date count + current cursor position.
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.from !== sel.to) return; // selection took over ; its own emit wins
    const lineObj = view.state.doc.lineAt(sel.head);
    const col = sel.head - lineObj.from + 1;
    onCursorStats?.({ line: lineObj.number, col, selectionLen: 0, words: cachedWords });
  }

  function updateCursorStats() {
    if (!view) return;
    const sel = view.state.selection.main;
    const lineObj = view.state.doc.lineAt(sel.head);
    const col = sel.head - lineObj.from + 1;
    const selLen = sel.to - sel.from;
    if (selLen > 0) {
      // Selection : count synchronously off the (typically small) slice.
      const text = view.state.doc.sliceString(sel.from, sel.to);
      const words = countWordsInString(text);
      onCursorStats?.({ line: lineObj.number, col, selectionLen: selLen, words });
      return;
    }
    // Caret-only : keep cursor position live ; surface cached word
    // count immediately + schedule a debounced rescan.
    onCursorStats?.({ line: lineObj.number, col, selectionLen: 0, words: cachedWords });
    if (wordsDebounceTimer) clearTimeout(wordsDebounceTimer);
    wordsDebounceTimer = setTimeout(() => {
      wordsDebounceTimer = undefined;
      recomputeFullDocWords();
    }, WORD_COUNT_DEBOUNCE_MS);
  }

  // Compartments for the settings panel : font / tab / line numbers /
  // word wrap all reconfigure live without rebuilding the editor
  // state. settingsExtensions() reads the current store value ; a
  // $effect reapplies whenever the store changes.
  const fontCompartment = new Compartment();
  const tabCompartment = new Compartment();
  const lineNumbersCompartment = new Compartment();
  const wordWrapCompartment = new Compartment();
  const minimapCompartment = new Compartment();
  const languageCompartment = new Compartment();
  const inlineMathCompartment = new Compartment();
  const foldGutterCompartment = new Compartment();
  const sectionFoldingCompartment = new Compartment();

  function inlineMathExt(): Extension {
    return (language === 'latex' || language === 'markdown') ? inlineMathRender() : [];
  }
  function foldGutterExt(): Extension {
    return (language === 'latex' || language === 'markdown') ? foldGutter() : [];
  }
  function sectionFoldingExt(): Extension {
    return sectionFolding(language);
  }

  function fontExt(): Extension {
    const f = settings.current.font;
    return EditorView.theme({
      '&': {
        fontFamily: f.family,
        fontSize: f.size + 'px',
        lineHeight: String(f.lineHeight),
      },
      '.cm-content': {
        fontFamily: f.family,
        fontSize: f.size + 'px',
      },
      '.cm-gutters': {
        fontFamily: f.family,
        fontSize: Math.max(10, f.size - 1) + 'px',
      },
    });
  }
  function tabExt(): Extension {
    const ts = Math.max(1, Math.min(8, settings.current.tabSize | 0));
    return ES.tabSize.of(ts);
  }
  function lineNumExt(): Extension {
    return settings.current.lineNumbers ? lineNumbersExt() : [];
  }
  function wordWrapExt(): Extension {
    return settings.current.wordWrap ? EditorView.lineWrapping : [];
  }
  function minimapExt(): Extension {
    // showMinimap is a Facet ; we register a `create` function that
    // returns the minimap DOM node. The third-party plugin renders
    // a scaled canvas thumbnail of the doc + a draggable viewport
    // marker on the right edge of the editor.
    if (!settings.current.minimap) return [];
    return showMinimap.compute(['doc'], () => ({
      create: () => {
        const dom = document.createElement('div');
        return { dom };
      },
      displayText: 'characters',
      showOverlay: 'always',
      gutters: [],
    }));
  }
  function vscodeThemeExt(): Extension {
    const theme = vscodeThemes.resolve();
    return theme ? buildVSCodeThemeExtension(theme) : [];
  }

  // Refresh the lint Compartment whenever the global compile
  // diagnostics change so squiggles + gutter markers appear / clear
  // without the user having to retype in the editor. We track the
  // microtask-coalesced `version` counter instead of `items.length` so
  // a streamed batch of 30-50 diagnostics fires this effect ONCE per
  // compile instead of once per item. See perf-audit-2026-06-14 L1.
  $effect(() => {
    void compileDiagnostics.version;
    if (!view) return;
    view.dispatch({
      effects: lintCompartment.reconfigure(lintExtension(language, file)),
    });
  });

  // jumpToLine effect : scrolls the editor to the given 1-based
  // line + drops the caret at column 0. Triggered by OutlinePanel
  // clicks for LaTeX outline navigation.
  $effect(() => {
    const target = jumpToLine ?? 0;
    if (!view || target <= 0) return;
    const doc = view.state.doc;
    const line = Math.max(1, Math.min(doc.lines, target));
    const pos = doc.line(line).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    view.focus();
  });

  // Reconfigure the language pack + language-conditional extensions
  // when `language` flips. Without this, switching files of different
  // languages kept the original pack's parser/highlighter in place.
  // The pack itself loads asynchronously via loadLanguagePack() so
  // the cold-load bundle stays small ; language-conditional ext-
  // ensions can reconfigure synchronously since they're already in
  // the main bundle.
  $effect(() => {
    void language;
    if (!view) return;
    view.dispatch({
      effects: [
        inlineMathCompartment.reconfigure(inlineMathExt()),
        foldGutterCompartment.reconfigure(foldGutterExt()),
        sectionFoldingCompartment.reconfigure(sectionFoldingExt()),
      ],
    });
    void loadLanguagePack(language);
  });

  // Reactively push setting changes into the editor. The effect
  // captures the current settings + dispatches a reconfigure on
  // each compartment ; only the compartments whose backing extension
  // actually changed re-render their views.
  $effect(() => {
    // Read every reactive field so $effect tracks them all.
    const s = settings.current;
    void s.font.family; void s.font.size; void s.font.lineHeight;
    void s.tabSize; void s.lineNumbers; void s.wordWrap; void s.minimap;
    // Track active VSCode theme switches too — same effect runs on
    // either change so all compartments stay in sync.
    void vscodeThemes.active;
    if (!view) return;
    view.dispatch({
      effects: [
        fontCompartment.reconfigure(fontExt()),
        tabCompartment.reconfigure(tabExt()),
        lineNumbersCompartment.reconfigure(lineNumExt()),
        wordWrapCompartment.reconfigure(wordWrapExt()),
        minimapCompartment.reconfigure(minimapExt()),
        vscodeThemeCompartment.reconfigure(vscodeThemeExt()),
      ],
    });
  });
  // Compartment holds the authorship extension so we can swap it
  // in / out at runtime when revisionMode changes — no editor remount.
  const authorshipCompartment = new Compartment();

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;
  let provider: WebsocketProvider | undefined;
  let ydoc: Y.Doc | undefined;
  let saveDebounce: ReturnType<typeof setTimeout> | undefined;
  let seeded = false;
  // Show a loading spinner overlay until the editor mounts AND its
  // ytext has either content OR completed the seed-from-disk path.
  // We flip `loading` to false once the seed promise resolves or
  // the binding observes a non-empty ytext from a remote peer.
  let loading = $state<boolean>(true);

  // Dark-theme syntax highlight : the defaultHighlightStyle uses
  // dark blue keywords which become unreadable on a dark background.
  // This palette is roughly the VS Code Dark+ defaults — bright enough
  // to read on a #1e1e1e-ish base. CodeMirror gates application on
  // `themeType: 'dark'` so it auto-applies only when daisyUI's dark
  // theme is active.
  const cmDarkHighlight = HighlightStyle.define(
    [
      { tag: t.keyword, color: '#c586c0' },
      { tag: t.controlKeyword, color: '#c586c0' },
      { tag: t.atom, color: '#569cd6' },
      { tag: t.number, color: '#b5cea8' },
      { tag: t.string, color: '#ce9178' },
      { tag: t.tagName, color: '#569cd6' },
      { tag: t.heading, color: '#569cd6', fontWeight: 'bold' },
      { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
      { tag: t.meta, color: '#dcdcaa' },
      { tag: t.invalid, color: '#f44747' },
      { tag: t.url, color: '#3794ff' },
      { tag: t.variableName, color: '#9cdcfe' },
      { tag: t.typeName, color: '#4ec9b0' },
      { tag: t.macroName, color: '#dcdcaa' },
      { tag: t.processingInstruction, color: '#c586c0' },
      { tag: t.bracket, color: '#d4d4d4' },
      { tag: t.brace, color: '#d4d4d4' },
      { tag: t.operator, color: '#d4d4d4' },
      { tag: t.punctuation, color: '#d4d4d4' },
    ],
    { themeType: 'dark' },
  );

  // Initial placeholder for the language Compartment : the editor
  // mounts INSTANTLY with no language pack, so the cold-load bundle
  // doesn't have to ship 50-150 KB per language synchronously.
  // loadLanguagePack(name) kicks off the dynamic import + dispatches
  // the real pack into the Compartment when the chunk arrives. Cache
  // hits (e.g. opening a second .tex) are synchronous.
  function languagePack(_name: string): Extension {
    return [];
  }

  // Module-scope cache : each language pack is constructed once on
  // first use. The keyed Extension is reused for every subsequent
  // file in that language so a tab swap doesn't re-parse the chunk.
  // (Lives outside the component instance so it survives unmounts
  // for the lifetime of the SPA.)
  type PackLoader = () => Promise<Extension>;
  const packLoaders: Record<string, PackLoader> = {
    'latex':       async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/stex')).stex),
    'markdown':    async () => (await import('@codemirror/lang-markdown')).markdown(),
    'go':          async () => (await import('@codemirror/lang-go')).go(),
    'cpp':         async () => (await import('@codemirror/lang-cpp')).cpp(),
    'c':           async () => (await import('@codemirror/lang-cpp')).cpp(),
    'python':      async () => (await import('@codemirror/lang-python')).python(),
    'rust':        async () => (await import('@codemirror/lang-rust')).rust(),
    'javascript':  async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: false, jsx: true }),
    'typescript':  async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
    'svelte':      async () => (await import('@replit/codemirror-lang-svelte')).svelte(),
    'html':        async () => (await import('@codemirror/lang-html')).html(),
    'xml':         async () => (await import('@codemirror/lang-html')).html(),
    'svg':         async () => (await import('@codemirror/lang-html')).html(),
    'css':         async () => (await import('@codemirror/lang-css')).css(),
    'scss':        async () => (await import('@codemirror/lang-css')).css(),
    'json':        async () => (await import('@codemirror/lang-json')).json(),
    'yaml':        async () => (await import('@codemirror/lang-yaml')).yaml(),
    'yml':         async () => (await import('@codemirror/lang-yaml')).yaml(),
    'toml':        async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml),
    'hcl':         async () => StreamLanguage.define((await import('../codemirrorHCL')).hcl),
    'ruby':        async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
    'rb':          async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
    'perl':        async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/perl')).perl),
    'pl':          async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/perl')).perl),
    'shell':       async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
    'bash':        async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
    'sh':          async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
    'zsh':         async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
    // Fallback to rust — closest brace-syntax cousin until a real
    // Zig pack lands.
    'zig':         async () => (await import('@codemirror/lang-rust')).rust(),
  };
  // Caches resolved Extension (or in-flight Promise) per language id.
  // Module-scope so it survives a component remount.
  const packCache = new Map<string, Promise<Extension>>();

  function resolveLanguagePack(name: string): Promise<Extension> {
    // Unknown language → fall through to markdown : same default the
    // old synchronous switch used. Reading via Object.prototype.has
    // (rather than truthy-check) keeps tsc happy with strict types
    // — packLoaders is a Record<string, PackLoader> so loader is
    // never typed as possibly-undefined.
    const has = Object.prototype.hasOwnProperty.call(packLoaders, name);
    const key = has ? name : 'markdown';
    let p = packCache.get(key);
    if (!p) {
      p = packLoaders[key]();
      packCache.set(key, p);
    }
    return p;
  }

  // loadLanguagePack(name) : kicks off the dynamic import + dispatches
  // a Compartment reconfigure once the chunk + cache resolve. The
  // generation token guards against the user flipping `language` again
  // before the previous load settles — only the most recent request's
  // extension wins. A no-op when the editor isn't mounted yet ; the
  // onMount path calls this once the EditorView exists.
  let languageGen = 0;
  async function loadLanguagePack(name: string) {
    const gen = ++languageGen;
    const promise = resolveLanguagePack(name);
    if (!promise) return;
    let ext: Extension;
    try {
      ext = await promise;
    } catch (err) {
      logError('editor', 'lang-pack-load', err);
      return;
    }
    if (gen !== languageGen) return;
    if (!view) return;
    view.dispatch({ effects: languageCompartment.reconfigure(ext) });
  }

  function wsURL(p: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/projects/${encodeURIComponent(p)}/sync`;
  }

  // T8 LSP : the per-language client lives for the lifetime of
  // this Editor instance. Opened lazily after the SPA confirms the
  // host has the binary ; teardown happens in onDestroy.
  let lspClient: LSPClient | undefined;
  // The set of languages whose binary is on $PATH (fetched once
  // from /api/lsp on mount). Empty when the host has no LSPs OR
  // the endpoint isn't reachable.
  let lspAvailable: Set<string> | undefined;
  // Map our internal language ids to the URL slug used by the
  // server's LSP registry.
  const LSP_LANG_SLUG: Record<string, string> = {
    latex: 'latex', go: 'go', python: 'python', rust: 'rust',
    typescript: 'typescript', javascript: 'javascript',
  };
  function lspSlugFor(lang: string): string | null {
    return LSP_LANG_SLUG[lang] ?? null;
  }
  // lspDiagnosticsLinter : a CodeMirror linter source that pulls
  // from the active lspClient.diagnosticsFor(). Stays present even
  // when no client is open so the lint extension's compartment
  // doesn't need to be reconfigured on connect.
  function lspDiagnosticsLinter() {
    return linter((view) => {
      if (!lspClient || !file) return [];
      return lspClient.diagnosticsFor('file://' + file, view);
    });
  }

  // posFromOffset / offsetFromPos : convert between CodeMirror's
  // absolute offset + LSP's {line, character} positions. LSP uses
  // 0-based line + UTF-16 character offsets within the line ; CM's
  // line numbers are 1-based so we subtract 1.
  function posFromOffset(view: EditorView, offset: number): { line: number; character: number } {
    const line = view.state.doc.lineAt(offset);
    return { line: line.number - 1, character: offset - line.from };
  }
  function offsetFromPos(view: EditorView, line: number, character: number): number {
    const doc = view.state.doc;
    const cmLine = Math.min(doc.lines, Math.max(1, line + 1));
    const lineObj = doc.line(cmLine);
    return Math.min(doc.length, lineObj.from + character);
  }

  // lspCompletionSource : CodeMirror autocomplete override that
  // asks the LSP server for completion items at the cursor. Falls
  // through (returns null) when no client is open OR when the
  // server has nothing to offer — the static sources keep working.
  async function lspCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
    if (!lspClient || !file) return null;
    // Conservative trigger : only fire after explicit Cmd+space OR
    // after the user has typed a wordy char so we don't slam the
    // server on every keystroke. CM's `explicit` flag covers the
    // first case ; `matchBefore` the second.
    const word = ctx.matchBefore(/[\w.\\]+/);
    if (!ctx.explicit && (!word || (word.to - word.from === 0 && !ctx.explicit))) return null;
    const pos = posFromOffset(ctx.view, ctx.pos);
    const items = await lspClient.completion('file://' + file, pos.line, pos.character);
    if (!items || items.length === 0) return null;
    return {
      from: word ? word.from : ctx.pos,
      options: items.slice(0, 256).map(it => ({
        label: it.label,
        detail: it.detail,
        info: typeof it.documentation === 'string'
          ? it.documentation
          : it.documentation?.value,
        apply: it.insertText ?? it.label,
      })),
      validFor: /^[\w]*$/,
    };
  }

  // lspHoverTooltip : CodeMirror hoverTooltip source that asks the
  // LSP for the symbol info under the pointer. Result is rendered
  // as plain text in a small floating box.
  const lspHoverTooltip = hoverTooltip(async (view, pos) => {
    if (!lspClient || !file) return null;
    const p = posFromOffset(view, pos);
    const result = await lspClient.hover('file://' + file, p.line, p.character);
    if (!result) return null;
    return {
      pos,
      end: pos,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-lsp-hover';
        dom.style.maxWidth = '32em';
        dom.style.padding = '0.4em 0.6em';
        dom.style.background = 'var(--fallback-b1, #1e1e1e)';
        dom.style.border = '1px solid rgba(0,0,0,0.2)';
        dom.style.borderRadius = '4px';
        dom.style.fontSize = '0.8em';
        dom.style.whiteSpace = 'pre-wrap';
        dom.textContent = result.contents;
        return { dom };
      },
    };
  });

  // gotoDefinition : F12 / Cmd+click → ask LSP for the def location
  // + jump to it. When the target lives in another file we open it
  // via the App-level hook ; same-file jumps re-position the caret.
  async function gotoDefinition() {
    if (!lspClient || !view || !file) return false;
    const sel = view.state.selection.main;
    const p = posFromOffset(view, sel.head);
    const locs = await lspClient.definition('file://' + file, p.line, p.character);
    if (!locs || locs.length === 0) return false;
    const loc = locs[0];
    // Convert the LSP uri back to a project-relative path.
    let target = loc.uri.replace(/^file:\/\//, '');
    if (target.startsWith('/')) {
      const sep = '/' + project + '/';
      const cut = target.indexOf(sep);
      if (cut >= 0) target = target.slice(cut + sep.length);
      else target = target.split('/').pop() ?? target;
    }
    if (target && target !== file) {
      const openFn = (window as unknown as {
        weftLoomOpenFile?: (p: string) => void;
      }).weftLoomOpenFile;
      openFn?.(target);
      // After the new file mounts, defer the jump. Pass line +
      // character (NOT a pre-computed offset from THIS editor's
      // doc) so the NEW editor — which holds the right doc — can
      // resolve the offset against its own buffer. The old code
      // captured `view` from the file we were leaving, so the
      // offset was for the wrong document.
      const targetLine = loc.range.start.line;
      const targetChar = loc.range.start.character;
      setTimeout(() => {
        const w = (window as unknown as {
          weftLoomJumpToOffset?: (
            arg: { offset: number; to?: number } | { line: number; character: number },
          ) => void;
        });
        w.weftLoomJumpToOffset?.({ line: targetLine, character: targetChar });
      }, 250);
    } else if (view) {
      const off = offsetFromPos(view, loc.range.start.line, loc.range.start.character);
      view.dispatch({
        selection: { anchor: off, head: off },
        effects: EditorView.scrollIntoView(off, { y: 'center' }),
      });
      view.focus();
    }
    return true;
  }

  onMount(() => {
    if (!host) return;
    logEvent('editor', 'mount', { file, project });
    ydoc = new Y.Doc();
    onYDoc?.(ydoc);
    provider = new WebsocketProvider(wsURL(project), 'default', ydoc);
    provider.awareness.setLocalStateField('user', {
      name: identity.name,
      color: identity.color,
      // colorLight is what y-codemirror.next uses as the selection
      // highlight bg. Defaults to color + '33' (20 % alpha) when
      // omitted ; we push an explicit slightly-stronger 28 % alpha
      // so the highlight reads on both light + dark daisyUI themes.
      colorLight: identity.color.startsWith('hsl(')
        ? identity.color.replace('hsl(', 'hsla(').replace(')', ', 0.28)')
        : identity.color + '47',
      avatar: identity.avatar,
    });
    onAwareness?.(provider.awareness);
    // Expose the live Awareness handle on window so tests (and the
    // odd power-user) can inject synthetic peer states without needing
    // a second browser tab. The presence.ts ViewPlugin listens on the
    // same object's 'change' event, so any `setLocalState` /
    // `setLocalStateField` call from outside will re-trigger a
    // decoration rebuild end-to-end exactly like a remote peer would.
    (window as unknown as { weftLoomAwareness?: Awareness }).weftLoomAwareness = provider.awareness;
    const ytextKey = file && file !== '' ? 'file:' + file : 'codemirror';
    const ytext = ydoc.getText(ytextKey);

    // Build the cmToY extension here. The yToCm observer is wired
    // INLINE further down after EditorView is created so it captures
    // the view reference directly via closure (any indirection
    // through a binding factory was making Svelte's #key-driven
    // remounts leak the wrong view ref).
    const binding = yjsBinding(ytext, ydoc);

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbersCompartment.of(lineNumExt()),
        history(),
        // Multi-cursor : Alt-click adds a cursor at the clicked spot,
        // Cmd+D selects the next occurrence of the current selection,
        // Cmd+Shift+L selects every occurrence. Standard VSCode UX.
        // drawSelection replaces the native browser cursor with CM's
        // own rendering, which is the only way to PAINT more than one
        // caret at a time. allowMultipleSelections opts the state into
        // a SelectionRange[] instead of a single anchor/head pair.
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(cmDarkHighlight),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          // LaTeX-mode shortcuts : Bold / Italic / Math match the
          // bindings every word-processor + Overleaf user expects.
          // T8 V0.2 : F12 → go-to-definition (also wired on
          // Mod-Alt-d for keyboards without F-keys). Falls through
          // when no LSP is connected.
          { key: 'F12', run: () => { void gotoDefinition(); return true; } },
          { key: 'Mod-Alt-d', run: () => { void gotoDefinition(); return true; } },
          { key: 'Mod-b', run: (v) => { if (language === 'latex') { applyLatexCommand(v, 'textbf'); return true; } return false; } },
          { key: 'Mod-i', run: (v) => { if (language === 'latex') { applyLatexCommand(v, 'textit'); return true; } return false; } },
          { key: 'Mod-m', run: (v) => { if (language === 'latex') { applyLatexCommand(v, 'inline-math'); return true; } return false; } },
          // T5 : Cmd+J = "show this line in PDF" (forward SyncTeX).
          { key: 'Mod-j', run: (v) => {
            if (language !== 'latex' || !file) return false;
            const cursor = v.state.selection.main.head;
            const line = v.state.doc.lineAt(cursor).number;
            const fn = (window as unknown as {
              weftLoomSyncTeXForward?: (s: string, l: number) => Promise<unknown>;
            }).weftLoomSyncTeXForward;
            if (typeof fn === 'function') {
              void fn(file, line);
            }
            return true;
          } },
          // VSCode standard editor shortcuts that the default
          // CodeMirror keymap leaves unwired :
          // - Cmd+/   toggle line comment
          // - Cmd+Shift+/  toggle block comment
          // - Tab / Shift+Tab indent/outdent (already in default)
          { key: 'Mod-/', run: toggleComment },
          { key: 'Mod-Shift-/', run: toggleBlockComment },
          // Cmd+] / Cmd+[ : indent / outdent (matches VSCode + JetBrains).
          { key: 'Mod-]', run: indentMore },
          { key: 'Mod-[', run: indentLess },
          // Multi-cursor : VSCode-equivalent shortcuts.
          // Cmd+D selects the next occurrence of the current selection
          // (or grows the selection from the cursor word). Repeating
          // Cmd+D adds further occurrences. selectNextOccurrence is
          // CodeMirror's own implementation — same semantics as VSCode.
          { key: 'Mod-d', run: selectNextOccurrence },
        ]),
        languageCompartment.of(languagePack(language)),
        // Self-check : warns when the doc has content but the
        // editor's .cm-content area is unreadable (fg ≈ bg, or
        // zero-height paint). Cheap — gated on viewportChanged.
        // See editorVisibilityCheck.ts for the contract.
        visibilityCheckExtension(),
        // Custom Y.Text ↔ CodeMirror two-way binding. Replaces
        // y-codemirror.next's yCollab : its observer dropped updates
        // past the first sync handshake in our setup and ALSO
        // conflicted with our seed-from-disk path (double dispatch on
        // initial content load left the editor empty). Pure custom
        // binding here ; cursor + selection colouring for awareness
        // peers lives in app.css against the .cm-y* classes the
        // y-protocols Awareness state already exposes.
        binding.extension,
        // Real-time presence : remote peers' carets + selection
        // ranges decorate the editor surface live, driven by the
        // same Yjs Awareness map CollaboratorsSidebar reads. Every
        // local selection change broadcasts a `cursor` field into
        // awareness (throttled at 50 ms) so peers see us too. The
        // extension is unconditional — when no peers are connected
        // it simply paints nothing.
        presenceCursors(provider.awareness),
        // Authorship colouring goes through a Compartment so the
        // toggle button in the navbar can swap it in / out without
        // rebuilding the whole EditorState.
        authorshipCompartment.of(
          revisionMode ? authorshipExtension(ytext, provider.awareness) : [],
        ),
        // Marp theme autocomplete : fires when the cursor sits in a
        // YAML front-matter block on a `theme:` line. Closed if the
        // user types a value that isn't a known theme.
        // Autocomplete pipeline : the marp/codeblock overrides fire
        // first ; if they return null the language-pack's own
        // completions take over (HTML tags, CSS properties,
        // markdown front-matter, Python keywords, etc.). closeBrackets
        // auto-pairs `(`, `[`, `{`, `"`, `'`.
        autocompletion({
          override: [marpMetadataCompletion, codeblockLanguageCompletion, citeCompletion, lspCompletionSource, snippetSource(language)],
          activateOnTyping: true,
          closeOnBlur: false,
        }),
        // T8 V0.2 : LSP-backed hover tooltip alongside citeHover.
        // Returns null when no LSP client is open ; citeHover keeps
        // working for the static LaTeX paths.
        lspHoverTooltip,
        closeBrackets(),
        // Find / replace (Cmd+F to open, Cmd+G to next, Cmd+Shift+G prev).
        search({ top: true }),
        keymap.of(searchKeymap),
        // Hover tooltip for LaTeX \cite{} + \ref{} : pops resolved
        // bib entry or label location. Cheap to mount globally —
        // the tooltip code returns null when the language isn't
        // LaTeX or the cursor isn't on a citation/ref.
        citeHover,
        // LaTeX Rich-text mode : decorates source so headings,
        // \textbf, math, lists render inline (Overleaf parity).
        // Compartment so the toolbar button can flip it without
        // tearing down the editor.
        richTextCompartment.of(latexRichText(language === 'latex' && richTextEnabled, project)),
        // V0.1.5 : inline KaTeX rendering for LaTeX + markdown.
        // `$E=mc^2$` / `$$...$$` / `\(...\)` / `\[...\]` segments
        // render live while the cursor is outside them ; entering
        // the segment swaps back to raw source so it can be edited.
        inlineMathCompartment.of(inlineMathExt()),
        // T7 : section-aware fold ranges. foldGutter renders the
        // chevron markers in the gutter ; foldKeymap binds Cmd+Alt+[
        // / Cmd+Alt+] to fold/unfold ; sectionFolding teaches CM
        // about \section + # heading regions for LaTeX/Markdown.
        foldGutterCompartment.of(foldGutterExt()),
        sectionFoldingCompartment.of(sectionFoldingExt()),
        // T6 : decorations for commented text ranges (yellow dotted
        // underline). The ranges are pushed via the StateEffect
        // below — driven by the comments Y.Array observer.
        commentDecorations(),
        fontCompartment.of(fontExt()),
        tabCompartment.of(tabExt()),
        wordWrapCompartment.of(wordWrapExt()),
        minimapCompartment.of(minimapExt()),
        vscodeThemeCompartment.of(vscodeThemeExt()),
        lintCompartment.of(lintExtension(language, file)),
        // T8 LSP : diagnostics published by the LSP server land
        // here. The linter source closure reads from the lspClient
        // singleton ; while no client is open it returns [].
        lspDiagnosticsLinter(),
        EditorView.theme({
          '&': { height: '100%' },
        }),
        // Cursor + selection + word-count → StatusBar slot. The
        // selection report also drives the CommentsPanel : when the
        // user types in the editor + the panel's input has body, the
        // panel reads the latest selection range to anchor a new
        // comment.
        EditorView.updateListener.of((u) => {
          if (u.docChanged || u.selectionSet) {
            updateCursorStats();
            const sel = u.state.selection.main;
            const text = u.state.doc.sliceString(sel.from, sel.to);
            const fn = (window as unknown as {
              weftLoomReportSelection?: (s: { from: number; to: number; text: string } | null) => void;
            }).weftLoomReportSelection;
            if (typeof fn === 'function') {
              fn(sel.from === sel.to ? null : { from: sel.from, to: sel.to, text });
            }
          }
        }),
      ],
    });

    view = new EditorView({ state, parent: host });
    updateCursorStats();
    // Kick off the lazy language-pack load. The Compartment was
    // created with `[]` so the editor mounts instantly without a
    // pack ; the chunk arrival reconfigures the Compartment with
    // the real parser + highlighter.
    void loadLanguagePack(language);
    // Attach the yToCm observer NOW so it has a valid view target
    // even for the very first remote update.
    bindingDetach = binding.attach(view);

    // Expose a global insert-at-cursor hook so the LaTeX symbol
    // palette + math equation builder can splice LaTeX commands
    // into the source view without needing a parent reference.
    // `placeCursorOffset` (optional) lets the palette put the
    // caret at a useful position inside the inserted snippet — e.g.
    // \\frac{|}{} parks at the numerator stub.
    // T6 : setter for comment-range decorations. CommentsPanel
    // resolves Yjs RelativePositions to absolute offsets + pushes
    // them here so the editor paints the dotted-underline marks.
    (window as unknown as {
      weftLoomSetCommentRanges?: (ranges: CommentRange[]) => void;
    }).weftLoomSetCommentRanges = (ranges: CommentRange[]) => {
      if (!view) return;
      view.dispatch({ effects: setCommentRanges.of(ranges) });
    };
    type JumpArg = { offset: number; to?: number } | { line: number; character: number };
    (window as unknown as {
      weftLoomJumpToOffset?: (a: JumpArg | number, b?: number) => void;
    }).weftLoomJumpToOffset = (a: JumpArg | number, b?: number) => {
      if (!view) return;
      let from: number;
      let to: number;
      if (typeof a === 'number') {
        // Legacy positional call : (from, to). Both are offsets in
        // THIS editor's doc.
        from = a;
        to = b ?? a;
      } else if ('line' in a) {
        // LSP-style {line, character} (0-based) : resolve against
        // THIS editor's current doc, which is the only safe source
        // when the jump arrives after a cross-file open.
        const doc = view.state.doc;
        const cmLine = Math.min(doc.lines, Math.max(1, a.line + 1));
        const lineObj = doc.line(cmLine);
        from = Math.min(doc.length, lineObj.from + a.character);
        to = from;
      } else {
        from = a.offset;
        to = a.to ?? a.offset;
      }
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
      view.focus();
    };
    (window as unknown as {
      weftLoomInsertAtCursor?: (s: string, placeCursorOffset?: number) => void;
    }).weftLoomInsertAtCursor = (s: string, placeCursorOffset?: number) => {
      if (!view) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: s },
        selection: placeCursorOffset !== undefined
          ? { anchor: sel.from + placeCursorOffset }
          : { anchor: sel.from + s.length },
      });
      view.focus();
    };

    provider.on('status', (event: { status: string }) => {
      if (
        event.status === 'connected' ||
        event.status === 'connecting' ||
        event.status === 'disconnected'
      ) {
        onStatus?.(event.status);
      }
    });

    // Auto-seed from disk : MUST wait for the WS sync handshake so
    // that the relay's existing doc state (or another peer's seed)
    // has settled before we decide whether to seed.
    //
    // Race fixed here : an earlier version seeded immediately on
    // mount which made two clients on the same room both seed the
    // disk content INDEPENDENTLY. Yjs CRDT then merged the two
    // independent insertions into duplicated text (or worse, masked
    // each other's subsequent edits) — appeared as "text doesn't
    // propagate between users" because the doc state diverged the
    // moment both clients touched it.
    //
    // New protocol :
    //   1. wait for `sync` event (WS handshake complete + state from
    //      relay applied) OR a 2 s timeout fallback (offline mode).
    //   2. if ytext is still empty AND no other peer is connected,
    //      we ARE the first client : seed from disk.
    //   3. if ytext has content : someone (relay state OR a peer)
    //      already populated it — don't touch it.
    //   4. if other peers are connected but ytext is empty : a peer
    //      is mid-typing or about to seed ; let them.
    const seedFromDisk = async () => {
      if (!file || seeded) return;
      if (ytext.length > 0) {
        seeded = true;
        loading = false;
        return;
      }
      seeded = true;
      // Fast path : if awareness shows only one client (us), no
      // double-seed race is possible. Skip the seed-claim handshake
      // entirely + read straight from disk. Closes the user-reported
      // "reload → 3 s empty editor" path : after Cmd+R, awareness
      // sees only the new tab (the old tab's awareness died with the
      // page), but the server-side seed-claim might still hold a
      // stale claim from the killed tab. The claim was protecting
      // against multi-browser racing ; with one client there's
      // nothing to protect.
      try {
        const peerCount = provider!.awareness.getStates().size;
        if (peerCount <= 1) {
          const content = await readFile(project, file);
          if (content && ytext.length === 0 && view) {
            view.dispatch({ changes: { from: 0, insert: content } });
            logEvent('seed', 'solo-fast-path', { file, bytes: content.length });
          }
          loading = false;
          return;
        }
      } catch { /* fall through to the claim path below */ }
      try {
        const url = '/api/projects/' + encodeURIComponent(project)
          + '/seed-claim/' + file.split('/').map(encodeURIComponent).join('/');
        const resp = await fetch(url, { method: 'POST' });
        if (resp.status === 409) {
          // Someone else holds the claim. Two paths converge here :
          //   - they're a live peer about to push the seed via Yjs
          //     update (we should see it via ytext.observe momentarily)
          //   - they're a stale claim (crashed mid-seed, page reload
          //     within the 30 s window). No one will push, so we have
          //     to force-fetch ourselves.
          //
          // Race-aware wait : observe ytext until it goes non-empty
          // OR a 3 s hard deadline expires. Wakes up immediately when
          // the elected seeder lands content (typical reload = O(ms)),
          // falls back to force-fetch otherwise.
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              ytext.unobserve(onChange);
              clearTimeout(timer);
              resolve();
            };
            const onChange = () => {
              if (ytext.length > 0) finish();
            };
            ytext.observe(onChange);
            // 500 ms deadline : the awareness propagation + ytext
            // update from a real co-author is sub-second on the
            // local relay. If nobody pushes in 500 ms the claim
            // holder is most likely a stale ghost (page reload
            // before WS close), so force-fetching ourselves loses
            // nothing — the `ytext.length === 0` re-check below
            // still guards against a last-second double-insert.
            const timer = setTimeout(finish, 500);
            // Already populated by the time we registered ? Check
            // once synchronously to avoid the entire wait when the
            // peer's insert beat us to the observe() call.
            if (ytext.length > 0) finish();
          });
          if (ytext.length === 0 && view) {
            try {
              const content = await readFile(project, file);
              if (content && ytext.length === 0) {
                view.dispatch({ changes: { from: 0, insert: content } });
                logEvent('seed', 'force-after-409', { file, bytes: content.length });
              }
            } catch { /* ignore */ }
          }
          return;
        }
        if (!resp.ok) { loading = false; return; }
        const content = await readFile(project, file);
        if (content && ytext.length === 0 && view) {
          view.dispatch({ changes: { from: 0, insert: content } });
          logEvent('seed', 'completed', { file, bytes: content.length });
        }
      } catch {
        // 404 / permission denied / network error — leave the buffer
        // empty so the user can edit a fresh file from scratch.
      } finally {
        loading = false;
      }
    };

    // Designated-seeder protocol : after the WS sync handshake we
    // wait 500 ms for awareness to propagate, then the peer with
    // the smallest awareness clientID is the one that reads the file
    // from disk + inserts into the Y.Text. All other peers wait and
    // pick up the seed via the relay's normal update broadcast.
    //
    // Why : two clients opening the same file simultaneously each
    // saw peerCount==0 at sync time (their own state hadn't echoed
    // to the awareness map yet) and BOTH seeded — Yjs merged the two
    // independent inserts at offset 0 into a duplicated "hellohello"
    // buffer, or worse, silently corrupted the doc state.
    // Seed the bib cache eagerly — independent of the WS sync
    // handshake. The cite-autocomplete + BibliographyPanel both
    // want a project handle the moment the editor mounts, not 2 s
    // later. Polling kicks off the periodic .bib refresh too.
    bib.setProject(project);
    bib.start();
    provider!.once('sync', () => {
      setTimeout(() => {
        void seedFromDisk();
      }, 500);
    });
    // Offline fallback : if the WS never confirms sync (relay down,
    // handshake broken) we still want the user to see the file. 2 s
    // is past the median sync latency by an order of magnitude.
    setTimeout(() => { void seedFromDisk(); }, 2000);

    // Diagnostic : every ytext.observe pulse pushes the count up via
    // onYTextTick. Helps isolate whether remote WS frames reach the
    // Y.Text CRDT or are dropped at the y-websocket → ydoc layer.
    let ytextTickCount = 0;
    ytext.observe(() => {
      ytextTickCount++;
      onYTextTick?.(ytextTickCount);
    });

    // DIAGNOSTIC : log every ydoc update event so we can see whether
    // local typing actually produces Y.Doc updates that should reach
    // the WebSocketProvider's send-on-update listener. If the user
    // types and we see no "[ydoc.update]" line, the CM→Y.Text path
    // is broken inside our binding. If we see updates but the
    // server log still shows only heartbeats, the WS provider isn't
    // forwarding them.
    // Gated : the unconditional version flooded the console on every
    // keystroke (~5-15 ms per stroke through the DevTools reflection
    // bridge). Now opt-in via `window.weftLoomVerbose = true` in a DEV
    // build only — production users never pay. See perf-audit-2026-06-14
    // H1.
    ydoc!.on('update', (update: Uint8Array, origin: unknown) => {
      // Vite injects `import.meta.env.DEV` ; the cast keeps the
      // tsconfig (no @types/vite) happy without pulling in client.d.ts.
      const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
      if (env?.DEV && (window as unknown as { weftLoomVerbose?: boolean }).weftLoomVerbose) {
        console.log('[ydoc.update]', { bytes: update.length, origin: String(origin) });
      }
    });

    // Debug API : window.__weftDebug.insert(s) writes s directly to
    // the Y.Text CRDT, bypassing CodeMirror + yCollab. If A calls it
    // and B sees the chars appear → WS sync IS working, the bug is
    // in yCollab's transaction → Y.Text bridge. If B doesn't see it
    // either → bug is in y-websocket / Y.Doc.update broadcasting.
    (window as unknown as { __weftDebug: { insert: (s: string) => void } }).__weftDebug = {
      insert: (s: string) => {
        ydoc!.transact(() => {
          ytext.insert(ytext.length, s);
        }, 'debug-insert');
        console.log('[__weftDebug] inserted', s, 'ytext.length now', ytext.length);
      },
    };

    // Auto-save : every LOCAL edit reschedules a debounced PUT to
    // the file API. 250 ms of idle (was 1 s, reduced so Compile
    // clicks pick up edits without a long wait) → write to disk →
    // schedulePush() (server side) kicks off the auto-commit + git
    // push pipeline. Remote (peer) updates skip the autosave path —
    // the originating peer already wrote the file ; double-writing
    // from every viewer would thrash the disk + fight on the lock.
    ytext.observe((_event, tr) => {
      if (tr.origin !== YORIGIN_LOCAL) return;
      if (!file) return;
      if (saveDebounce) clearTimeout(saveDebounce);
      saveDebounce = setTimeout(async () => {
        if (!file) return;
        try {
          await writeFile(project, file, ytext.toString());
          // V0.11 : dispatch an autosave-completed signal so the
          // compile-on-save toggle can fire a recompile. Throttled +
          // language-gated at the listener side, NOT here — the
          // editor only knows that bytes hit disk.
          window.dispatchEvent(new CustomEvent('weft-loom-autosave-completed', {
            detail: { project, file, language },
          }));
        } catch (e) {
          logError('editor', 'autosave', e);
          console.error('autosave failed', e);
        }
        // T8 LSP : push the latest buffer to the language server
        // so the next publishDiagnostics frame reflects what's on
        // disk. We piggy-back on the same 250 ms debounce as the
        // file write — pre-commit diagnostics are rarely useful.
        if (lspClient) {
          try { lspClient.didChange('file://' + file, ytext.toString()); } catch { /* ignore */ }
        }
      }, 250);
    });

    // Compile-time flush : the user expects "Compile" to use what's
    // in the editor RIGHT NOW, not what was last debounced to disk
    // (the 1 s autosave window means a fast click after typing
    // compiles the old version). CompileLogPanel dispatches this
    // event before starting the job ; the listener cancels the
    // pending debounce + writes synchronously + attaches the resulting
    // promise to ev.detail.ack so the dispatcher can await it.
    const flushSaves = (e: Event) => {
      const ev = e as CustomEvent<{ ack: Promise<void> | null }>;
      if (!file || !ydoc) return;
      ev.detail.ack = (async () => {
        if (saveDebounce) { clearTimeout(saveDebounce); saveDebounce = undefined; }
        const content = ytext.toString();
        try {
          await writeFile(project, file, content);
          console.log('[flush-saves] wrote', file, content.length, 'bytes');
        } catch (e) { console.error('flushSave failed', e); }
      })();
    };
    window.addEventListener('weft-loom-flush-saves', flushSaves);
    // Wrap the existing bindingDetach (set when `binding.attach(view)`
    // ran earlier) so onDestroy tears down BOTH the Yjs binding +
    // our flush listener.
    const prevDetach = bindingDetach;
    bindingDetach = () => {
      window.removeEventListener('weft-loom-flush-saves', flushSaves);
      prevDetach?.();
    };
  });

  // Reconfigure the authorship Compartment when revisionMode flips.
  // untrack the view/provider/ydoc reads so the effect's only dep is
  // revisionMode itself — the other state is captured by closure but
  // doesn't drive re-runs.
  $effect(() => {
    const on = revisionMode;
    untrack(() => {
      if (!view || !provider || !ydoc) return;
      const ytextKey = file && file !== '' ? 'file:' + file : 'codemirror';
      const ext = on
        ? authorshipExtension(ydoc.getText(ytextKey), provider.awareness)
        : [];
      view.dispatch({ effects: authorshipCompartment.reconfigure(ext) });
    });
  });

  let bindingDetach: (() => void) | undefined;

  onDestroy(() => {
    bindingDetach?.();
    // Cancel the debounced word-count rescan : the editor's about to
    // be torn down so emitting cursor stats from a stale `view`
    // reference would NPE in StatusBar.
    if (wordsDebounceTimer) {
      clearTimeout(wordsDebounceTimer);
      wordsDebounceTimer = undefined;
    }
    // Flush any pending save before tearing down so a fast file switch
    // doesn't lose the user's last keystrokes.
    if (saveDebounce) {
      clearTimeout(saveDebounce);
      if (ydoc && file) {
        const ytextKey = 'file:' + file;
        const t = ydoc.getText(ytextKey);
        // Fire-and-forget : the provider's about to die anyway.
        writeFile(project, file, t.toString()).catch((err) => {
          logError('editor', 'onDestroy-flush', err);
          console.error('editor flush failed', err);
        });
      }
    }
    view?.destroy();
    provider?.destroy();
    ydoc?.destroy();
    bib.stop();
    // T8 LSP : send didClose + tear down the WS so the subprocess
    // doesn't leak when the user closes the file.
    if (lspClient && file) {
      try { lspClient.didClose('file://' + file); } catch { /* ignore */ }
      try { lspClient.dispose(); } catch { /* ignore */ }
      lspClient = undefined;
    }
  });

  // T8 LSP : open the WS lazily — wait for the SPA to know which
  // LSPs the host has + only connect for those. The lifecycle is
  // mirror-of-Editor.mount : we open once per (project, file).
  // Generation-token guard : when the user toggles language / file
  // fast, two effect runs race ; without a gen check the loser's
  // ready-resolution could overwrite lspClient with a stale client.
  let lspGen = 0;
  let lspDetach: (() => void) | undefined;
  $effect(() => {
    file; language;
    const gen = ++lspGen;
    const ac = new AbortController();
    const prevDetach = lspDetach;
    lspDetach = undefined;
    // Captures the detach + client this run installs. The cleanup
    // returned from the effect closes over these, so a destroy that
    // fires mid-await still tears down the work the async block
    // eventually finishes — no orphan onChange listener.
    let runDetach: (() => void) | undefined;
    let runClient: LSPClient | undefined;
    let cancelled = false;
    untrack(() => {
      void (async () => {
        if (lspAvailable === undefined) {
          lspAvailable = await fetchAvailableLanguages({ signal: ac.signal });
        }
        if (cancelled || gen !== lspGen) return;
        const slug = lspSlugFor(language);
        if (lspClient) {
          try { lspClient.dispose(); } catch { /* ignore */ }
          lspClient = undefined;
        }
        if (!slug || !lspAvailable.has(slug) || !file) return;
        const c = createLSPClient({
          url: '/api/lsp/' + slug,
          rootUri: 'file:///' + project,
          workspaceFolderName: project,
        });
        runClient = c;
        try {
          await c.ready;
        } catch {
          try { c.dispose(); } catch { /* ignore */ }
          if (runClient === c) runClient = undefined;
          return;
        }
        if (cancelled || gen !== lspGen) {
          try { c.dispose(); } catch { /* ignore */ }
          if (runClient === c) runClient = undefined;
          return;
        }
        lspClient = c;
        const text = ydoc?.getText('file:' + file).toString() ?? '';
        c.didOpen('file://' + file, slug, text);
        const detach = c.onChange(() => {
          if (view) view.dispatch({ effects: [] });
        });
        // Window between onChange registration and the cancelled check :
        // if cleanup fired during c.ready / didOpen, dispose now.
        if (cancelled || gen !== lspGen) {
          try { if (typeof detach === 'function') detach(); } catch { /* ignore */ }
          try { c.dispose(); } catch { /* ignore */ }
          if (lspClient === c) lspClient = undefined;
          if (runClient === c) runClient = undefined;
          return;
        }
        runDetach = typeof detach === 'function' ? detach : undefined;
        lspDetach = runDetach;
      })();
    });
    return () => {
      cancelled = true;
      ac.abort();
      prevDetach?.();
      runDetach?.();
      if (runClient && runClient !== lspClient) {
        try { runClient.dispose(); } catch { /* ignore */ }
      }
    };
  });
</script>

<div class="h-full w-full flex flex-col bg-base-100">
  {#if language === 'latex'}
    <!-- Format toolbar — Overleaf parity. Buttons wrap the current
         selection (or insert a placeholder) in the matching LaTeX
         command ; the Rich Text / Source toggle on the right swaps
         decorations on / off without rebuilding the editor. -->
    <div class="flex-none flex items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200/60 text-xs">
      <div class="join">
        <button class="join-item btn btn-xs font-bold" onclick={() => fmt('textbf')} title="Bold (Cmd+B)">B</button>
        <button class="join-item btn btn-xs italic" onclick={() => fmt('textit')} title="Italic (Cmd+I)">I</button>
        <button class="join-item btn btn-xs underline" onclick={() => fmt('underline')} title="Underline">U</button>
        <button class="join-item btn btn-xs font-mono" onclick={() => fmt('texttt')} title="Monospace">{`{}`}</button>
      </div>
      <span class="opacity-30">·</span>
      <div class="join">
        <button class="join-item btn btn-xs" onclick={() => fmt('section')} title="Section">H1</button>
        <button class="join-item btn btn-xs" onclick={() => fmt('subsection')} title="Subsection">H2</button>
        <button class="join-item btn btn-xs" onclick={() => fmt('subsubsection')} title="Subsubsection">H3</button>
      </div>
      <span class="opacity-30">·</span>
      <div class="join">
        <button class="join-item btn btn-xs" onclick={() => fmt('itemize')} title="Bullet list">• List</button>
        <button class="join-item btn btn-xs" onclick={() => fmt('enumerate')} title="Numbered list">1. List</button>
      </div>
      <span class="opacity-30">·</span>
      <div class="join">
        <button class="join-item btn btn-xs" onclick={() => fmt('inline-math')} title="Inline math $…$" aria-label="Insert inline math">∑</button>
        <button class="join-item btn btn-xs" onclick={() => fmt('display-math')} title="Display math $$…$$" aria-label="Insert display math">∫</button>
      </div>
      <span class="opacity-30">·</span>
      <button class="btn btn-xs" onclick={() => fmt('href')} title="Insert hyperlink" aria-label="Insert link">🔗</button>
      <span class="ml-auto"></span>
      <div class="join">
        <button
          class="join-item btn btn-xs"
          class:btn-active={richTextEnabled}
          aria-pressed={richTextEnabled}
          onclick={toggleRichText}
          title="Rich-text view : headings, bold, math rendered inline"
        >📜 Rich Text</button>
        <button
          class="join-item btn btn-xs"
          class:btn-active={!richTextEnabled}
          aria-pressed={!richTextEnabled}
          onclick={toggleRichText}
          title="Source view : raw LaTeX commands"
        >&lt;/&gt; Source</button>
      </div>
    </div>
  {/if}
  <div class="flex-1 overflow-hidden relative">
    <div bind:this={host} class="absolute inset-0"></div>
    {#if loading}
      <!-- Loading overlay : sits on top of the CodeMirror host until
           the seed-from-disk path resolves (or a peer's content
           propagates). Semi-transparent so the user still sees the
           editor frame establishing. -->
      <div
        class="absolute inset-0 flex items-center justify-center pointer-events-none bg-base-100/60 backdrop-blur-sm z-10"
        aria-live="polite"
      >
        <div class="flex items-center gap-3 px-4 py-2 rounded-md bg-base-100 border border-base-300 shadow text-sm">
          <span class="loading loading-spinner loading-sm"></span>
          <span class="opacity-80">Loading {file || 'document'}…</span>
        </div>
      </div>
    {/if}
  </div>
</div>
