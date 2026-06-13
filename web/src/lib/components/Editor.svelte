<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { logEvent } from '../logbus';
  import { Compartment, EditorState } from '@codemirror/state';
  import { EditorView, keymap } from '@codemirror/view';
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
  } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';
  import { markdown } from '@codemirror/lang-markdown';
  import { autocompletion } from '@codemirror/autocomplete';
  import { marpMetadataCompletion } from '../marpAutocomplete';
  import { codeblockLanguageCompletion } from '../codeblockAutocomplete';
  import { go } from '@codemirror/lang-go';
  import { cpp } from '@codemirror/lang-cpp';
  import { python } from '@codemirror/lang-python';
  import { rust } from '@codemirror/lang-rust';
  import { javascript } from '@codemirror/lang-javascript';
  import { html } from '@codemirror/lang-html';
  import { css } from '@codemirror/lang-css';
  import { json } from '@codemirror/lang-json';
  import { yaml } from '@codemirror/lang-yaml';
  import { svelte } from '@replit/codemirror-lang-svelte';
  import { stex } from '@codemirror/legacy-modes/mode/stex';
  import { ruby } from '@codemirror/legacy-modes/mode/ruby';
  import { shell } from '@codemirror/legacy-modes/mode/shell';
  import { toml } from '@codemirror/legacy-modes/mode/toml';
  import { perl } from '@codemirror/legacy-modes/mode/perl';
  // Custom HCL StreamLanguage — own block / heredoc / interpolation
  // tokenizer ; designed to be contributed back to
  // @codemirror/legacy-modes (no weft-loom deps). Zig still falls
  // back to rust for now until a real Zig pack lands.
  import { hcl as hclStream } from '../codemirrorHCL';
  import { closeBrackets } from '@codemirror/autocomplete';
  import { latexRichText, richTextCompartment, applyLatexCommand, type LatexCommand } from '../latexRichText';
  import { settings, vscodeThemes } from '../settings.svelte';
  import { buildVSCodeThemeExtension, vscodeThemeCompartment } from '../vscodeThemeApply.svelte';
  import { lintExtension, lintCompartment } from '../lintAll.svelte';
  import { compileDiagnostics } from '../compileDiagnostics.svelte';
  import { showMinimap } from '@replit/codemirror-minimap';
  import { citeCompletion } from '../citeAutocomplete';
  import { citeHover } from '../citeHover';
  import { bib } from '../bibStore.svelte';
  import { search, searchKeymap } from '@codemirror/search';
  import { EditorState as ES, type Extension } from '@codemirror/state';
  import { lineNumbers as lineNumbersExt } from '@codemirror/view';

  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import { yjsBinding } from '../ybinding';
  import type { Awareness } from 'y-protocols/awareness';
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
  function updateCursorStats() {
    if (!view) return;
    const sel = view.state.selection.main;
    const lineObj = view.state.doc.lineAt(sel.head);
    const col = sel.head - lineObj.from + 1;
    const selLen = sel.to - sel.from;
    const text = selLen > 0
      ? view.state.doc.sliceString(sel.from, sel.to)
      : view.state.doc.toString();
    const words = text.split(/\s+/).filter(Boolean).length;
    onCursorStats?.({ line: lineObj.number, col, selectionLen: selLen, words });
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
  // without the user having to retype in the editor.
  $effect(() => {
    void compileDiagnostics.items.length;
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

  function languagePack(name: string) {
    switch (name) {
      case 'latex':
        return StreamLanguage.define(stex);
      case 'markdown':
        return markdown();
      case 'go':
        return go();
      case 'cpp':
      case 'c':
        return cpp();
      case 'python':
        return python();
      case 'rust':
        return rust();
      case 'javascript':
        return javascript({ typescript: false, jsx: true });
      case 'typescript':
        return javascript({ typescript: true, jsx: true });
      case 'svelte':
        return svelte();
      case 'html':
      case 'xml':
      case 'svg':
        return html();
      case 'css':
      case 'scss':
        return css();
      case 'json':
        return json();
      case 'yaml':
      case 'yml':
        return yaml();
      case 'toml':
        return StreamLanguage.define(toml);
      case 'hcl':
        return StreamLanguage.define(hclStream);
      case 'ruby':
      case 'rb':
        return StreamLanguage.define(ruby);
      case 'perl':
      case 'pl':
        return StreamLanguage.define(perl);
      case 'shell':
      case 'bash':
      case 'sh':
      case 'zsh':
        return StreamLanguage.define(shell);
      case 'zig':
        // Fallback to rust — closest brace-syntax cousin.
        return rust();
      default:
        return markdown();
    }
  }

  function wsURL(p: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/projects/${encodeURIComponent(p)}/sync`;
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
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(cmDarkHighlight),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          // LaTeX-mode shortcuts : Bold / Italic / Math match the
          // bindings every word-processor + Overleaf user expects.
          { key: 'Mod-b', run: (v) => { if (language === 'latex') { applyLatexCommand(v, 'textbf'); return true; } return false; } },
          { key: 'Mod-i', run: (v) => { if (language === 'latex') { applyLatexCommand(v, 'textit'); return true; } return false; } },
          { key: 'Mod-m', run: (v) => { if (language === 'latex') { applyLatexCommand(v, 'inline-math'); return true; } return false; } },
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
        ]),
        languagePack(language),
        // Custom Y.Text ↔ CodeMirror two-way binding. Replaces
        // y-codemirror.next's yCollab : its observer dropped updates
        // past the first sync handshake in our setup and ALSO
        // conflicted with our seed-from-disk path (double dispatch on
        // initial content load left the editor empty). Pure custom
        // binding here ; cursor + selection colouring for awareness
        // peers lives in app.css against the .cm-y* classes the
        // y-protocols Awareness state already exposes.
        binding.extension,
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
          override: [marpMetadataCompletion, codeblockLanguageCompletion, citeCompletion],
          activateOnTyping: true,
          closeOnBlur: false,
        }),
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
        fontCompartment.of(fontExt()),
        tabCompartment.of(tabExt()),
        wordWrapCompartment.of(wordWrapExt()),
        minimapCompartment.of(minimapExt()),
        vscodeThemeCompartment.of(vscodeThemeExt()),
        lintCompartment.of(lintExtension(language, file)),
        EditorView.theme({
          '&': { height: '100%' },
        }),
        // Cursor + selection + word-count → StatusBar slot.
        EditorView.updateListener.of((u) => {
          if (u.docChanged || u.selectionSet) updateCursorStats();
        }),
      ],
    });

    view = new EditorView({ state, parent: host });
    updateCursorStats();
    // Attach the yToCm observer NOW so it has a valid view target
    // even for the very first remote update.
    bindingDetach = binding.attach(view);

    // Expose a global insert-at-cursor hook so the LaTeX symbol
    // palette + math equation builder can splice LaTeX commands
    // into the source view without needing a parent reference.
    // `placeCursorOffset` (optional) lets the palette put the
    // caret at a useful position inside the inserted snippet — e.g.
    // \\frac{|}{} parks at the numerator stub.
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
      try {
        const url = '/api/projects/' + encodeURIComponent(project)
          + '/seed-claim/' + file.split('/').map(encodeURIComponent).join('/');
        const resp = await fetch(url, { method: 'POST' });
        if (resp.status === 409) {
          // Phantom / stale claim : nobody seeded but the lock is
          // held. Wait 3 s for the rightful seeder ; if the buffer
          // is still empty, force-fetch the file ourselves. The
          // ytext.length re-check right before dispatch keeps us
          // safe from a last-second peer insert.
          await new Promise((r) => setTimeout(r, 3000));
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
    provider!.once('sync', () => {
      // Seed `bib` cache for this project (\cite{} autocomplete +
      // future lint resolve). Cheap : it just kicks off polling.
      bib.setProject(project);
      bib.start();
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
    ydoc!.on('update', (update: Uint8Array, origin: unknown) => {
      console.log('[ydoc.update]', { bytes: update.length, origin: String(origin) });
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

    // Auto-save : every edit reschedules a debounced PUT to the file
    // API. 250 ms of idle (was 1 s, reduced so Compile clicks pick
    // up edits without a long wait) → write to disk → schedulePush()
    // (server side) kicks off the auto-commit + git push pipeline.
    ytext.observe(() => {
      if (!file) return;
      if (saveDebounce) clearTimeout(saveDebounce);
      saveDebounce = setTimeout(async () => {
        if (!file) return;
        try {
          await writeFile(project, file, ytext.toString());
        } catch (e) {
          console.error('autosave failed', e);
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
    // Flush any pending save before tearing down so a fast file switch
    // doesn't lose the user's last keystrokes.
    if (saveDebounce) {
      clearTimeout(saveDebounce);
      if (ydoc && file) {
        const ytextKey = 'file:' + file;
        const t = ydoc.getText(ytextKey);
        // Fire-and-forget : the provider's about to die anyway.
        writeFile(project, file, t.toString()).catch(() => {});
      }
    }
    view?.destroy();
    provider?.destroy();
    ydoc?.destroy();
    bib.stop();
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
        <button class="join-item btn btn-xs" onclick={() => fmt('inline-math')} title="Inline math $…$">∑</button>
        <button class="join-item btn btn-xs" onclick={() => fmt('display-math')} title="Display math $$…$$">∫</button>
      </div>
      <span class="opacity-30">·</span>
      <button class="btn btn-xs" onclick={() => fmt('href')} title="Insert hyperlink">🔗</button>
      <span class="ml-auto"></span>
      <div class="join">
        <button
          class="join-item btn btn-xs"
          class:btn-active={richTextEnabled}
          onclick={toggleRichText}
          title="Rich-text view : headings, bold, math rendered inline"
        >📜 Rich Text</button>
        <button
          class="join-item btn btn-xs"
          class:btn-active={!richTextEnabled}
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
