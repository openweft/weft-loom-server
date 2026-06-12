<script lang="ts">
  // Editor restored : the file list works (Navbar/CompileDrawer aren't
  // the blocker we eliminated those). y-websocket now reaches
  // /sync/default so it doesn't saturate the conn pool any more.
  import { onMount } from 'svelte';
  import * as Y from 'yjs';
  import type { Awareness } from 'y-protocols/awareness';
  import FileExplorer from './lib/components/FileExplorer.svelte';
  import PreviewPane from './lib/components/PreviewPane.svelte';
  import Navbar from './lib/components/Navbar.svelte';
  import MenuBar from './lib/components/MenuBar.svelte';
  import ActivityBar from './lib/components/ActivityBar.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import GitSidebar from './lib/components/GitSidebar.svelte';
  import GitPanel from './lib/components/GitPanel.svelte';
  import SearchPanel from './lib/components/SearchPanel.svelte';
  import NotebookEditor from './lib/components/NotebookEditor.svelte';
  import Breadcrumb from './lib/components/Breadcrumb.svelte';
  import SettingsPanel from './lib/components/SettingsPanel.svelte';
  import QuickOpen from './lib/components/QuickOpen.svelte';
  import AdminPanel from './lib/components/AdminPanel.svelte';
  import CommandPalette, { type Command } from './lib/components/CommandPalette.svelte';
  import { compileDiagnostics } from './lib/compileDiagnostics.svelte';
  import OutlinePanel from './lib/components/OutlinePanel.svelte';
  import MetadataPanel from './lib/components/MetadataPanel.svelte';
  import ContextMenu, { type ContextEntry } from './lib/components/ContextMenu.svelte';
  import { i18n } from './lib/i18n.svelte';
  import BottomPanel from './lib/components/BottomPanel.svelte';
  import { setProjectHint, logEvent } from './lib/logbus';
  import Editor from './lib/components/Editor.svelte';
  import WysiwygEditor from './lib/components/WysiwygEditor.svelte';
  import Resizer from './lib/components/Resizer.svelte';
  import TabBar from './lib/components/TabBar.svelte';
  import AIChatPanel from './lib/components/AIChatPanel.svelte';
  import CollaboratorsSidebar from './lib/components/CollaboratorsSidebar.svelte';
  // ShellPanel / CompileLogPanel are mounted inside BottomPanel
  // (the bottom drawer with the "Compile log" + "Shell" tabs).
  import ChatRoom from './lib/components/ChatRoom.svelte';
  import { loadIdentity, type Identity } from './lib/identity';
  import { applyTheme, loadTheme, languageForPath } from './lib/theme';

  let identity = $state<Identity>(loadIdentity());

  onMount(() => {
    applyTheme(loadTheme());
    // Suppress the browser's native right-click menu on the whole
    // app surface. The custom <ContextMenu> below takes over via
    // explicit `oncontextmenu` handlers on each region. Inputs +
    // PDF embeds keep their default menu so the user can still
    // copy/paste in form fields and download PDFs.
    document.addEventListener('contextmenu', (ev) => {
      const el = ev.target as HTMLElement;
      if (!el) return;
      if (el.closest('input, textarea, embed, [contenteditable=true], [data-allow-native-context]')) return;
      ev.preventDefault();
    });

    // Global keyboard shortcuts : Cmd+P quick file open, Cmd+,
    // settings, Cmd+Shift+P command palette (placeholder = QuickOpen
    // for now). CodeMirror keymaps intercept these only when the
    // editor has focus ; we listen at the document level so the
    // shortcuts work from any pane.
    document.addEventListener('keydown', (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod) return;
      // Cmd+P : Go to file
      if (ev.key === 'p' && !ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        quickOpenOpen = true;
        return;
      }
      // Cmd+S : explicit save — forces every mounted editor to
      // flush its buffer to disk immediately. Same event the
      // CompileLogPanel uses before kicking off a compile.
      if (ev.key === 's' && !ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        const flushEv = new CustomEvent<{ ack: Promise<void> | null }>(
          'weft-loom-flush-saves',
          { detail: { ack: null } },
        );
        window.dispatchEvent(flushEv);
        void flushEv.detail.ack;
        return;
      }
      // Cmd+Shift+P : Command palette
      if ((ev.key === 'P' || ev.key === 'p') && ev.shiftKey) {
        ev.preventDefault();
        paletteOpen = true;
        return;
      }
      // Cmd+, : Settings
      if (ev.key === ',') {
        ev.preventDefault();
        settingsOpen = true;
        return;
      }
    });
  });

  // Context menu controller — bound via bind:this so the
  // `editor / explorer / tab` regions can call `ctx.open(x,y,items)`
  // imperatively from their oncontextmenu handler.
  let ctx: { open: (x: number, y: number, items: ContextEntry[]) => void; close: () => void } | undefined = $state();

  function openEditorContext(ev: MouseEvent) {
    ev.preventDefault();
    ctx?.open(ev.clientX, ev.clientY, [
      { kind: 'item', label: 'Cut', shortcut: 'Cmd+X', action: () => document.execCommand('cut') },
      { kind: 'item', label: 'Copy', shortcut: 'Cmd+C', action: () => document.execCommand('copy') },
      { kind: 'item', label: 'Paste', shortcut: 'Cmd+V', action: () => document.execCommand('paste') },
      { kind: 'divider' },
      { kind: 'item', label: 'Compile', shortcut: 'Cmd+Enter', action: toggleLog },
      { kind: 'item', label: 'Toggle revision marks', action: () => onRevisionToggle(!revisionMode) },
      { kind: 'divider' },
      { kind: 'item', label: 'Settings…', shortcut: 'Cmd+,', action: () => (settingsOpen = true) },
    ]);
  }

  function openExplorerContext(ev: MouseEvent) {
    ev.preventDefault();
    ctx?.open(ev.clientX, ev.clientY, [
      { kind: 'item', label: 'New file…', action: () => alert('Click + in the explorer header') },
      { kind: 'item', label: 'Refresh', action: () => (explorerEpoch++) },
      { kind: 'divider' },
      { kind: 'item', label: 'Open in shell', action: () => openBottomTab('shell') },
      { kind: 'item', label: 'Source control', action: () => pickSidebar('scm') },
    ]);
  }

  // URL hash override : ?project=X or #project=X picks the initial
  // project so test harnesses + bookmark links can land on the
  // intended workspace without clicking through ProjectSwitcher.
  function initialProject(): string {
    try {
      const sp = new URLSearchParams(window.location.search);
      const fromQ = sp.get('project');
      if (fromQ) return fromQ;
      const h = window.location.hash;
      if (h.startsWith('#')) {
        const hp = new URLSearchParams(h.slice(1));
        const fromH = hp.get('project');
        if (fromH) return fromH;
      }
    } catch {
      /* SSR or hostile URL — fall through */
    }
    return 'demo';
  }
  let project = $state(initialProject());
  let currentFile = $state('');
  let language = $state<string>('markdown');
  // openFiles[] : the multi-tab editor list, ordered left → right.
  // Adding a file that's already open just activates it.
  let openFiles = $state<string[]>([]);
  let aiOpen = $state<boolean>(false);
  let collabOpen = $state<boolean>(true);
  // Unified bottom drawer : holds the Compile log + Shell tabs.
  // App.svelte holds the activeTab state + flows it down via
  // bind:activeTab to BottomPanel. Navbar buttons set the state
  // directly so a click on 🖥 actually switches the visible tab.
  let bottomOpen = $state<boolean>(true);
  let bottomTab = $state<'log' | 'shell' | 'doctor'>(loadBottomTab());
  // ActivityBar tracks which side panel is showing on the left.
  // 'explorer' default ; 'none' collapses the side bar entirely
  // (VSCode Cmd+B parity).
  let sidebarView = $state<'none' | 'explorer' | 'search' | 'scm' | 'collab'>('explorer');
  let gitConfigOpen = $state<boolean>(false);
  let settingsOpen = $state<boolean>(false);
  let quickOpenOpen = $state<boolean>(false);
  // Project-switcher dropdown open state — bound through Navbar to
  // ProjectSwitcher so MenuBar's "Switch project…" item pops it.
  let projectSwitcherOpen = $state<boolean>(false);
  // AdminPanel modal toggle — operator-only console listing OCI
  // image health, future expansion : μVM status, NATS subjects, …
  let adminPanelOpen = $state<boolean>(false);
  let paletteOpen = $state<boolean>(false);

  // Curated command list — surfaces every "menu-able" action behind
  // a fuzzy search. Each entry captures its action via closure so
  // keyboard-driven access stays one keystroke away.
  const commands = $derived<Command[]>([
    { id: 'file.new', label: 'New File…', detail: 'Create a file from template', shortcut: '', action: () => (newFileOpen = true) },
    { id: 'file.open', label: 'Go to File…', detail: 'Fuzzy-pick any file in the project', shortcut: 'Cmd+P', action: () => (quickOpenOpen = true) },
    { id: 'file.settings', label: 'Settings…', shortcut: 'Cmd+,', action: () => (settingsOpen = true) },
    { id: 'view.explorer', label: 'View: Explorer', shortcut: 'Cmd+Shift+E', action: () => pickSidebar('explorer') },
    { id: 'view.search', label: 'View: Search', shortcut: 'Cmd+Shift+F', action: () => pickSidebar('search') },
    { id: 'view.scm', label: 'View: Source Control', shortcut: 'Cmd+Shift+G', action: () => pickSidebar('scm') },
    { id: 'view.collab', label: 'View: Collaborators', action: () => pickSidebar('collab') },
    { id: 'view.toggleSidebar', label: 'View: Toggle Side Bar', shortcut: 'Cmd+B', action: () => (sidebarView = sidebarView === 'none' ? 'explorer' : 'none') },
    { id: 'view.toggleBottom', label: 'View: Toggle Bottom Panel', shortcut: 'Ctrl+`', action: () => toggleBottom() },
    { id: 'view.togglePreview', label: 'View: Toggle Preview', action: () => togglePreview() },
    { id: 'view.toggleAI', label: 'View: Toggle AI Assistant', action: () => toggleChat() },
    { id: 'compile.run', label: 'LaTeX/Marp: Compile', detail: 'Run pdflatex or marp on the active document', action: () => { bottomOpen = true; bottomTab = 'log'; } },
    { id: 'shell.open', label: 'Terminal: Open shell', shortcut: 'Ctrl+`', action: () => { bottomOpen = true; bottomTab = 'shell'; } },
    { id: 'git.pull', label: 'Git: Pull', action: () => pickSidebar('scm') },
    { id: 'theme.toggle', label: 'Preferences: Toggle dark mode', action: () => { const t = loadTheme(); applyTheme(t === 'dark' ? 'light' : 'dark'); } },
    { id: 'help.shortcuts', label: 'Help: Show all shortcuts', action: () => alert('Cmd+P · Cmd+Shift+P · Cmd+, · Cmd+B · Cmd+/ · Cmd+F\\nCmd+Enter Compile · Cmd+S Save (auto)') },
    { id: 'admin.images', label: 'Admin: Compile image status', detail: 'Probe every per-language OCI image and surface missing / private ones', action: () => (adminPanelOpen = true) },
  ]);
  // jumpToLine is incremented (line number, sentinel-bumped) by the
  // OutlinePanel click handler ; the Editor watches the prop + moves
  // the caret + scrolls into view. We pack the line + a tick so
  // re-clicking the same line still fires the effect downstream.
  let jumpToLine = $state<number>(0);

  // Outline panel height (px). Persists across sessions so the
  // user's preferred split between file tree + outline sticks.
  // Defaults to 240 px ; resized via a drag handle between the two.
  let outlineHeight = $state<number>(
    (() => {
      try {
        const v = Number(localStorage.getItem('weft-loom-outline-height'));
        if (!Number.isNaN(v) && v >= 80 && v <= 800) return v;
      } catch {}
      return 240;
    })(),
  );
  let outlineDragging = $state<boolean>(false);
  // Outline collapsed by default — the file tree is the primary
  // navigation surface ; the outline is a secondary affordance the
  // user opens explicitly when they want to TOC-navigate a long
  // document. Click the header to expand.
  let outlineCollapsed = $state<boolean>(
    (() => {
      try { return localStorage.getItem('weft-loom-outline-collapsed') !== '0'; }
      catch { return true; }
    })(),
  );
  // Chat-under-Collab split — height of the chat sub-pane when both
  // share the left sidebar (sidebarView == 'collab'). Persistent.
  // Width of the right column hosting AI Assistant + Chat. Single
  // resizer for the WHOLE column so AI and Chat share the same px
  // width — only the vertical split between them is per-pane.
  let rightColWidth = $state<number>(
    (() => {
      try {
        const v = Number(localStorage.getItem('weft-loom-rightcol-width'));
        if (!Number.isNaN(v) && v >= 240 && v <= 800) return v;
      } catch {}
      return 360;
    })(),
  );
  let rightColDragging = $state<boolean>(false);
  function startRightColDrag(ev: MouseEvent) {
    ev.preventDefault();
    rightColDragging = true;
    const startX = ev.clientX;
    const startW = rightColWidth;
    function move(e: MouseEvent) {
      const next = Math.max(240, Math.min(800, startW + (startX - e.clientX)));
      rightColWidth = next;
    }
    function up() {
      rightColDragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-rightcol-width', String(rightColWidth)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  let chatPaneHeight = $state<number>(
    (() => {
      try {
        const v = Number(localStorage.getItem('weft-loom-chat-pane-height'));
        if (!Number.isNaN(v) && v >= 100 && v <= 800) return v;
      } catch {}
      return 280;
    })(),
  );
  let chatSplitDragging = $state<boolean>(false);
  function startChatSplitDrag(ev: MouseEvent) {
    ev.preventDefault();
    chatSplitDragging = true;
    const startY = ev.clientY;
    const startH = chatPaneHeight;
    function move(e: MouseEvent) {
      const next = Math.max(100, Math.min(800, startH + (startY - e.clientY)));
      chatPaneHeight = next;
    }
    function up() {
      chatSplitDragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-chat-pane-height', String(chatPaneHeight)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function toggleOutline() {
    outlineCollapsed = !outlineCollapsed;
    try { localStorage.setItem('weft-loom-outline-collapsed', outlineCollapsed ? '1' : '0'); } catch {}
  }

  // Metadata accordion (Title / Author / Date / Class / Packages …)
  // — same lifecycle as Outline : collapsed by default, persisted.
  let metaCollapsed = $state<boolean>(
    (() => {
      try { return localStorage.getItem('weft-loom-meta-collapsed') !== '0'; }
      catch { return true; }
    })(),
  );
  function toggleMeta() {
    metaCollapsed = !metaCollapsed;
    try { localStorage.setItem('weft-loom-meta-collapsed', metaCollapsed ? '1' : '0'); } catch {}
  }
  // Metadata pane height (px) when expanded — resizable via the
  // drag handle above it. Persistent localStorage.
  let metaHeight = $state<number>(
    (() => {
      try {
        const v = Number(localStorage.getItem('weft-loom-meta-height'));
        if (!Number.isNaN(v) && v >= 80 && v <= 600) return v;
      } catch {}
      return 160;
    })(),
  );
  let metaDragging = $state<boolean>(false);
  function startMetaDrag(ev: MouseEvent) {
    ev.preventDefault();
    metaDragging = true;
    const startY = ev.clientY;
    const startH = metaHeight;
    function move(e: MouseEvent) {
      const next = Math.max(80, Math.min(600, startH + (startY - e.clientY)));
      metaHeight = next;
    }
    function up() {
      metaDragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-meta-height', String(metaHeight)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  function startOutlineDrag(ev: MouseEvent) {
    ev.preventDefault();
    outlineDragging = true;
    const startY = ev.clientY;
    const startH = outlineHeight;
    function move(e: MouseEvent) {
      // Inverted : drag UP grows the outline (it docks at the bottom
      // of the column, anchored to the explorer above it).
      const next = Math.max(80, Math.min(800, startH + (startY - e.clientY)));
      outlineHeight = next;
    }
    function up() {
      outlineDragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-outline-height', String(outlineHeight)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  function refreshExplorer() {
    // Bump a counter we can pass into the FileExplorer to trigger a
    // re-fetch after a git pull / clone. Keeps the file list in sync
    // with the working tree without forcing a page reload.
    explorerEpoch++;
  }
  let explorerEpoch = $state(0);
  function pickSidebar(view: 'none' | 'explorer' | 'search' | 'scm' | 'collab') {
    sidebarView = view;
  }
  let chatOpen = $state<boolean>(false);
  // rightColOpen drives the column container : single ActivityBar
  // chat button flips it. Inside, the AI + Chat panes each have
  // their own collapsed state managed below.
  let rightColOpen = $state<boolean>(
    (() => {
      try { return localStorage.getItem('weft-loom-rightcol-open') === '1'; } catch { return false; }
    })(),
  );
  let aiCollapsed = $state<boolean>(false);
  let chatCollapsed = $state<boolean>(true);
  function loadBottomTab(): 'log' | 'shell' | 'doctor' {
    // Storage key bumped to -v2 so any stale 'log' default from
    // before the tab-reorder ships fresh as 'shell'. Persisting the
    // last-used tab still works, just from a clean slate.
    try {
      const v = localStorage.getItem('weft-loom-bottom-tab-v2');
      if (v === 'shell' || v === 'log' || v === 'doctor') return v;
    } catch {}
    return 'shell';
  }
  function toggleBottom() {
    bottomOpen = !bottomOpen;
    try { localStorage.setItem('weft-loom-bottom-open', bottomOpen ? '1' : '0'); } catch {}
  }
  function openBottomTab(tab: 'log' | 'shell' | 'doctor') {
    bottomTab = tab;
    bottomOpen = true;
    try { localStorage.setItem('weft-loom-bottom-open', '1'); } catch {}
  }
  function toggleChat() {
    // Single button : opens / closes the WHOLE right column hosting
    // AI Assistant + Chat as accordions. When opening from a fully
    // closed state, EXPAND both panes — the user explicitly asked
    // for the column to land "en grand" (everything visible) so
    // they don't have to expand each accordion themselves.
    const opening = !rightColOpen;
    rightColOpen = opening;
    if (opening) {
      aiCollapsed = false;
      chatCollapsed = false;
    }
    try { localStorage.setItem('weft-loom-rightcol-open', rightColOpen ? '1' : '0'); } catch {}
  }
  function toggleAI() {
    // Backwards-compat for the AI command-palette entry + the
    // legacy ActivityBar 🤖 button : same target as toggleChat.
    toggleChat();
  }
  let revisionMode = $state<boolean>(false);
  function toggleCollab() {
    collabOpen = !collabOpen;
    try { localStorage.setItem('weft-loom-collab-open', collabOpen ? '1' : '0'); } catch {}
  }
  function onRevisionToggle(on: boolean) {
    revisionMode = on;
    try { localStorage.setItem('weft-loom-revision-mode', on ? '1' : '0'); } catch {}
  }
  // Wire the SPA logbus so every logEvent() call is tagged with the
  // current project. The DoctorPanel filters on it.
  $effect(() => {
    setProjectHint(project);
  });
  onMount(() => {
    logEvent('spa', 'mount', { url: window.location.href });
    const a = localStorage.getItem('weft-loom-ai-open');
    if (a === '1') aiOpen = true;
    const c = localStorage.getItem('weft-loom-collab-open');
    if (c === '0') collabOpen = false;
    // legacy 'shell-open' / 'logpanel-open' keys folded into the
    // unified bottom-open key ; either old key set to '1' opens the
    // drawer.
    if (localStorage.getItem('weft-loom-shell-open') === '1' ||
        localStorage.getItem('weft-loom-logpanel-open') === '1') {
      bottomOpen = true;
    }
    if (localStorage.getItem('weft-loom-chat-open') === '1') chatOpen = true;
    const rm = localStorage.getItem('weft-loom-revision-mode');
    if (rm === '1') revisionMode = true;
  });
  function getFileContent(): string {
    // Best-effort : the Editor binds the ytext via onYDoc. We pull
    // the current file's ytext string for the chat panel context.
    if (!ydoc || !currentFile) return '';
    return ydoc.getText('file:' + currentFile).toString();
  }
  let ydoc = $state<Y.Doc | undefined>();
  let awareness = $state<Awareness | undefined>();
  let connectionStatus = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
  let ytextTick = $state<number>(0);
  // Cursor / selection / word-count surfaced by the Editor + piped
  // into the StatusBar. Reset to undefined when no editor is mounted
  // so the bar's slots collapse instead of showing zero counts.
  let cursorLine = $state<number | undefined>(undefined);
  let cursorCol = $state<number | undefined>(undefined);
  let selectionLen = $state<number | undefined>(undefined);
  let wordCount = $state<number | undefined>(undefined);
  let artifactURL = $state<string | undefined>();
  onMount(() => {
    const v = localStorage.getItem('weft-loom-bottom-open');
    if (v === '0') bottomOpen = false;
  });
  // Compatibility shim : pre-BottomPanel code called toggleLog from
  // the navbar Compile button. It now opens the unified drawer +
  // switches to the log tab.
  function toggleLog() { openBottomTab('log'); }

  // isMarpFile detects YAML front-matter `marp: true` so the export
  // path can route to a real Marp compile instead of the HTML capture.
  function isMarpFile(): boolean {
    if (language !== 'markdown') return false;
    const src = getFileContent();
    if (!src.startsWith('---')) return false;
    const end = src.indexOf('\n---', 3);
    if (end < 0) return false;
    return /\bmarp\s*:\s*true\b/i.test(src.slice(3, end));
  }

  // exportPDF picks between two paths :
  //   1. Real compile  : language is latex OR marp markdown. Trigger
  //      a server-side pdflatex / marp-cli (or microVM when configured),
  //      then download the resulting PDF.
  //   2. HTML capture  : everything else. Bundle the rendered preview
  //      into a standalone .html file the user prints to PDF.
  async function exportPDF() {
    if (language === 'latex' || isMarpFile()) {
      await exportPDFViaCompile();
      return;
    }
    exportPDFViaHTML();
  }

  // exportPDFViaCompile fires a compile job and polls until the
  // artifact URL is ready, then triggers a download. The CompileLog
  // panel also auto-opens so the user sees streaming TeX errors.
  async function exportPDFViaCompile() {
    openBottomTab('log');
    try {
      const startResp = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/compile',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language, entry: currentFile }),
        },
      );
      if (!startResp.ok) throw new Error('start: HTTP ' + startResp.status);
      const { id } = await startResp.json();
      const es = new EventSource(
        '/api/projects/' + encodeURIComponent(project) + '/compile/' + id,
      );
      es.addEventListener('result', (e) => {
        const ev = e as MessageEvent;
        try {
          const r = JSON.parse(ev.data);
          if (r.success && r.artifact) {
            // Open the PDF in a new tab — the user saves from
            // Safari's built-in PDF viewer. Inline display lets them
            // preview before deciding to save.
            artifactURL = r.artifact;
            window.open(r.artifact, '_blank');
          }
        } catch {
          /* malformed result — log panel shows the raw event */
        }
        es.close();
      });
      es.addEventListener('error', () => es.close());
    } catch (e) {
      console.error('exportPDF compile failed', e);
    }
  }

  // exportPDFViaHTML emits a downloadable .html file containing the preview
  // (with embedded styles). The user opens it in any browser and uses
  // Cmd+P → Save as PDF. This sidesteps two problems we hit :
  //   - window.print() in WKWebView opens no dialog (the OSX app
  //     shell doesn't wire a print handler).
  //   - html2pdf.js synchronously rasterises the DOM and froze the
  //     event loop on documents with aspect-ratio slide cards.
  //
  // The blob is created off the rendered preview node, so all
  // KaTeX / Marp slide styling is preserved. Filename derives from
  // the source file.
  function exportPDFViaHTML() {
    const target = document.querySelector('[data-pdf-source]') as HTMLElement | null;
    if (!target) {
      console.warn('exportPDF: no preview to capture');
      return;
    }
    const stylesheets = Array.from(document.styleSheets)
      .map((s) => {
        try {
          return Array.from(s.cssRules).map((r) => r.cssText).join('\n');
        } catch {
          // Cross-origin stylesheet — skip (KaTeX font files etc.).
          return '';
        }
      })
      .join('\n');

    const filenameBase = (currentFile || 'document')
      .replace(/[/\\]/g, '_')
      .replace(/\.[^.]+$/, '');

    // Use string concatenation rather than a template literal because
    // a literal "<script>" tag inside a template string would trip the
    // Svelte parser into thinking we're closing the component's script
    // block. Building the same HTML from pieces keeps the parser happy.
    const scriptOpen = '<' + 'script>';
    const scriptClose = '<' + '/script>';
    const doc =
      '<!DOCTYPE html>\n' +
      '<html lang="en"><head><meta charset="UTF-8">' +
      '<title>' + filenameBase + '</title>' +
      '<style>\n' + stylesheets + '\n' +
      '@media print { @page { margin: 1cm; } body { background: white; color: black; } }\n' +
      'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 900px; margin: 2em auto; padding: 1em 2em; background: white; color: #222; }\n' +
      '</style></head>' +
      '<body class="prose">' +
      target.innerHTML +
      scriptOpen +
      "window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 300); });" +
      scriptClose +
      '</body></html>';

    const blob = new Blob([doc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filenameBase + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // sidebarWidth is the FileExplorer width in px. Persisted to
  // localStorage so the user's drag survives reloads.
  let sidebarWidth = $state<number>(224);
  onMount(() => {
    const v = localStorage.getItem('weft-loom-sidebar-width');
    if (v) {
      const n = Number(v);
      if (!Number.isNaN(n) && n >= 120 && n <= 500) sidebarWidth = n;
    }
  });
  let sidebarDragging = $state(false);
  function startSidebarDrag(ev: MouseEvent) {
    ev.preventDefault();
    sidebarDragging = true;
    const startX = ev.clientX;
    const startW = sidebarWidth;
    function move(e: MouseEvent) {
      const next = Math.max(120, Math.min(500, startW + (e.clientX - startX)));
      sidebarWidth = next;
    }
    function up() {
      sidebarDragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try {
        localStorage.setItem('weft-loom-sidebar-width', String(sidebarWidth));
      } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  // Notebooks are detected by extension so the preview pane opens
  // alongside the editor — the user sees their cell source on the
  // left (NotebookEditor) + the rendered notebook on the right
  // (NotebookPreview) without flipping panes.
  let isNotebook = $derived(currentFile.endsWith('.ipynb'));
  // Languages whose Preview pane has a meaningful renderer.
  // Go / Python / Rust / C++ get no preview — their "output" is
  // stdout (visible in Compile log) or a binary, not a typeset
  // document. The user's panel toggle still works for those
  // (Cmd+Shift+P > Toggle Preview) but the panel hides by default.
  const PREVIEWABLE = new Set(['latex', 'markdown', 'html', 'rtf']);
  let previewable = $derived(PREVIEWABLE.has(language) || isNotebook);
  // previewOpen is an INDEPENDENT panel toggle, persisted across
  // sessions. Detached from `language` so the user can keep the
  // preview docked even while editing a .go / .py / .json file, the
  // same way ChatRoom + AIChatPanel stay open regardless of the
  // active file. A close button on the panel header + a
  // CommandPalette entry flip it.
  let previewOpen = $state<boolean>(
    (() => {
      try { return localStorage.getItem('weft-loom-preview-open') !== '0'; }
      catch { return true; }
    })(),
  );
  function togglePreview() {
    previewOpen = !previewOpen;
    try { localStorage.setItem('weft-loom-preview-open', previewOpen ? '1' : '0'); } catch {}
  }
  // Preview pane width (px) — the preview is now a STANDALONE
  // panel docked to the right of the editor column (sibling to
  // ChatRoom / AIChatPanel), not nested inside the editor split.
  // Persistent via localStorage so the user's drag survives reloads.
  let previewWidth = $state<number>(
    (() => {
      try {
        const v = Number(localStorage.getItem('weft-loom-preview-width'));
        if (!Number.isNaN(v) && v >= 240 && v <= 1200) return v;
      } catch {}
      return 520;
    })(),
  );
  let previewDragging = $state<boolean>(false);
  function startPreviewDrag(ev: MouseEvent) {
    ev.preventDefault();
    previewDragging = true;
    const startX = ev.clientX;
    const startW = previewWidth;
    function move(e: MouseEvent) {
      // Inverted : drag LEFT grows the preview (it docks on the right).
      const next = Math.max(240, Math.min(1200, startW + (startX - e.clientX)));
      previewWidth = next;
    }
    function up() {
      previewDragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-preview-width', String(previewWidth)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function onSwitch(name: string, _lang: string) {
    project = name;
    currentFile = '';
    ydoc = undefined;
    awareness = undefined;
  }
  function onOpenFile(path: string, lang: string) {
    currentFile = path;
    language = lang;
    if (path && !openFiles.includes(path)) {
      openFiles = [...openFiles, path];
    }
  }

  // openFileByPath : programmatic file-open hook used by tests +
  // future deep-link routing. Resolves the language from the
  // extension via languageForPath() so callers don't have to know
  // the mapping table. Exposed on window so puppeteer can call it
  // without simulating a file-explorer click (which is flaky when
  // the file list is virtualised or off-screen).
  function openFileByPath(path: string) {
    if (!path) return;
    onOpenFile(path, languageForPath(path));
  }
  // URL bootstrap : honour ?file=<path> on the initial load so a
  // bookmark / test-harness URL lands on a specific file without
  // clicking through the file explorer.
  $effect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const f = sp.get('file');
      if (f && !currentFile) openFileByPath(f);
    } catch { /* SSR or hostile URL */ }
  });
  // Expose the same hook as `window.weftLoomOpenFile(path)` so
  // headless test harnesses can drive the editor deterministically.
  $effect(() => {
    const w = window as unknown as {
      weftLoomOpenFile?: (p: string) => void;
      weftLoomTriggerCompile?: () => Promise<unknown>;
    };
    w.weftLoomOpenFile = openFileByPath;
    // Mirror of the SPA's Run code-path : start a compile against the
    // current file using the same {language, entry} body the
    // bottom-panel sends. Lets the ui-compile-entry regression suite
    // bypass the brittle "find the visible Run button and click it"
    // detection and assert directly that entry threading works.
    w.weftLoomTriggerCompile = async () => {
      if (!currentFile) return null;
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/compile',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language, entry: currentFile }),
        },
      );
      try { return await r.json(); } catch { return null; }
    };
  });

  function onActivateTab(path: string) {
    currentFile = path;
    language = languageForPath(path);
  }

  function onCloseTab(path: string) {
    const idx = openFiles.indexOf(path);
    if (idx < 0) return;
    const next = openFiles.filter((p) => p !== path);
    openFiles = next;
    if (currentFile === path) {
      // Activate the neighbour : prefer the file that was to the right,
      // fall back to the previous one, fall back to no file.
      const fallback = next[idx] ?? next[idx - 1] ?? '';
      currentFile = fallback;
      language = fallback ? languageForPath(fallback) : 'markdown';
    }
  }
  function onLanguageChange(lang: string) {
    language = lang;
  }
  function onRename(next: Identity) {
    identity = next;
    if (!awareness) return;
    // Re-broadcast the full user payload (name + color + colorLight).
    // setLocalStateField replaces the named field entirely, so we must
    // include colorLight here too — otherwise y-codemirror.next loses
    // the selection-bg tint after the first rename + remote peers see
    // only the old highlight color.
    //
    // colorLight format : HSL → HSLA with 28 % alpha, falls back to
    // the hex+alpha shorthand for hex inputs the picker emits.
    const colorLight = next.color.startsWith('hsl(')
      ? next.color.replace('hsl(', 'hsla(').replace(')', ', 0.28)')
      : next.color + '47';
    awareness.setLocalStateField('user', {
      name: next.name,
      color: next.color,
      colorLight,
      avatar: next.avatar,
    });
  }
</script>

<div class="flex h-screen flex-col bg-base-200">
  <MenuBar
    onNewFile={() => alert('Click the + in the file explorer to create a file (menu wiring TBD)')}
    onSwitchProject={() => (projectSwitcherOpen = true)}
    onToggleExplorer={() => pickSidebar(sidebarView === 'explorer' ? 'none' : 'explorer')}
    onToggleShell={() => openBottomTab('shell')}
    onToggleDoctor={() => openBottomTab('doctor')}
    onToggleAI={toggleAI}
    onToggleChat={toggleChat}
    onToggleCollab={toggleCollab}
    onCompile={toggleLog}
    onExportPDF={exportPDF}
    onRevisionMode={() => onRevisionToggle(!revisionMode)}
    onOpenSettings={() => (settingsOpen = true)}
  />
  <!-- Tagline strip — centered, sits directly under the MenuBar.
       i18n-driven so it flips with the 🌐 locale switcher. -->
  <div
    class="flex-none text-center text-[11px] py-0.5 bg-base-200 border-b border-base-300 opacity-70 tracking-wider select-none"
    aria-label="Tagline"
  >
    {i18n.t('app.tagline')}
  </div>
  <Navbar
    {project}
    {language}
    {connectionStatus}
    {awareness}
    {identity}
    {ytextTick}
    onToggleAI={toggleAI}
    onToggleCollab={toggleCollab}
    onToggleShell={() => openBottomTab('shell')}
    onToggleChat={toggleChat}
    {onSwitch}
    {onLanguageChange}
    {onRename}
    bind:switcherOpen={projectSwitcherOpen}
  />
  <main class="flex flex-1 overflow-hidden">
    <ActivityBar
      bind:activeSidebar={sidebarView}
      onSidebar={pickSidebar}
      onToggleShell={() => openBottomTab('shell')}
      onToggleDoctor={() => openBottomTab('doctor')}
      onToggleAI={toggleAI}
      onToggleChat={toggleChat}
    />
    {#if sidebarView !== 'none'}
    <div
      style="width: {sidebarWidth}px"
      class="flex-none overflow-hidden flex flex-col h-full min-h-0"
    >
      {#if sidebarView === 'explorer'}
        <!-- Top : file tree. Bottom : LaTeX outline when a .tex
             file is open (Overleaf parity). Split via a resizable
             flex pair ; default 60/40 with min heights so neither
             collapses to zero. -->
        <div class="flex flex-col h-full min-h-0">
          <div class="flex-1 min-h-0 overflow-hidden" oncontextmenu={openExplorerContext} role="region" aria-label="Explorer">
            <FileExplorer {project} currentFile={currentFile} onOpen={onOpenFile} />
          </div>
          {#if true}
            <!-- Outline + Metadata are ALWAYS mounted (even when the
                 active file isn't a doc) — the user sees the "no
                 outline yet" state instead of the panels disappearing
                 entirely. -->
            {#if !outlineCollapsed}
              <div
                role="separator"
                aria-orientation="horizontal"
                tabindex="0"
                class="h-1.5 cursor-row-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
                class:bg-primary={outlineDragging}
                onmousedown={startOutlineDrag}
                title="Drag to resize the outline"
              ></div>
            {/if}
            <!-- Height tracks the accordion state : 36 px when
                 collapsed (just the header bar at the bottom of the
                 column) ; outlineHeight px (user-resizable) when
                 expanded. -->
            <div
              class="flex-none overflow-hidden border-t border-base-300"
              style="height: {outlineCollapsed ? 36 : outlineHeight}px"
            >
              <OutlinePanel
                {project}
                file={currentFile}
                collapsed={outlineCollapsed}
                onToggle={toggleOutline}
                onJump={(line) => (jumpToLine = line)}
              />
            </div>
            <!-- Metadata accordion — sits below Outline, follows the
                 same collapse / persist pattern. Surfaces title /
                 author / date / class / packages from the doc
                 preamble (LaTeX) or YAML front-matter (Markdown). -->
            {#if !metaCollapsed}
              <div
                role="separator"
                aria-orientation="horizontal"
                tabindex="0"
                class="h-1.5 cursor-row-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
                class:bg-primary={metaDragging}
                onmousedown={startMetaDrag}
                title="Drag to resize the metadata pane"
              ></div>
            {/if}
            <div
              class="flex-none overflow-hidden border-t border-base-300"
              style="height: {metaCollapsed ? 36 : metaHeight}px"
            >
              <MetadataPanel
                {project}
                file={currentFile}
                collapsed={metaCollapsed}
                onToggle={toggleMeta}
              />
            </div>
          {/if}
        </div>
      {:else if sidebarView === 'search'}
        <SearchPanel {project} onOpen={onOpenFile} />
      {:else if sidebarView === 'scm'}
        <GitSidebar
          {project}
          onOpenConfigModal={() => (gitConfigOpen = true)}
          onSynced={refreshExplorer}
        />
      {:else if sidebarView === 'collab'}
        <CollaboratorsSidebar
          {awareness}
          self={identity}
          bind:revisionMode
          onRename={onRename}
          onRevisionToggle={onRevisionToggle}
          onClose={() => pickSidebar('explorer')}
        />
      {/if}
    </div>
    {/if}
    <div
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      class="w-1.5 cursor-col-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
      class:bg-primary={sidebarDragging}
      onmousedown={startSidebarDrag}
      title="Drag to resize the file explorer"
    ></div>
    <!-- Center column : tabs + breadcrumb + editor/preview side-by-
         side, plus the BottomPanel docked at the bottom of THIS
         column only (VSCode parity puts terminal under the editor
         area, not under the activity bar / sidebar). -->
    <div class="flex-1 flex flex-col overflow-hidden min-w-0">
      <div class="flex-1 flex overflow-hidden min-h-0">
        <div class="overflow-hidden flex flex-col min-w-0 flex-1">
          <TabBar
            files={openFiles}
            active={currentFile}
            onActivate={onActivateTab}
            onClose={onCloseTab}
          />
          <Breadcrumb {project} file={currentFile} />
          <div class="flex-1 overflow-hidden" oncontextmenu={openEditorContext} role="region" aria-label="Editor">
            {#if currentFile}
              {#if currentFile.endsWith('.ipynb')}
                {#key project + '|nb|' + currentFile}
                  <NotebookEditor {project} file={currentFile} />
                {/key}
              {:else if currentFile.toLowerCase().endsWith('.rtf')}
                <!-- RTF files open in the WYSIWYG editor (Word-like
                     surface) instead of the raw-source CodeMirror.
                     Round-trips via parseRTF on load + writeRTF on
                     save. ODT will land here once the V0.9 pandoc
                     pipeline is wired. -->
                {#key project + '|rtf|' + currentFile}
                  <WysiwygEditor {project} file={currentFile} />
                {/key}
              {:else}
                {#key project + '|' + currentFile}
                  <Editor
                    {project}
                    {language}
                    file={currentFile}
                    {identity}
                    {revisionMode}
                    {jumpToLine}
                    onStatus={(s) => (connectionStatus = s)}
                    onYDoc={(d) => (ydoc = d)}
                    onAwareness={(a) => (awareness = a)}
                    onYTextTick={(n) => (ytextTick = n)}
                    onCursorStats={(s) => { cursorLine = s.line; cursorCol = s.col; selectionLen = s.selectionLen; wordCount = s.words; }}
                  />
                {/key}
              {/if}
            {:else}
              <div class="h-full flex items-center justify-center opacity-50 text-sm">
                Pick a file from the explorer to start editing.
              </div>
            {/if}
          </div>
        </div>
      </div>
      <BottomPanel
        bind:open={bottomOpen}
        bind:activeTab={bottomTab}
        {project}
        {language}
        entry={currentFile}
        onArtifact={(url) => (artifactURL = url)}
        onDiagnostic={(d) => compileDiagnostics.push(d)}
        onCompileReset={() => compileDiagnostics.clear()}
        onJump={(line, jfile) => {
          // jfile is null when the compile log doesn't carry a
          // file context (typical for pdfTeX's `l.42` lines) :
          // jump in the currently-open file. When the log names
          // a different file we don't auto-open it yet — log it.
          if (jfile && jfile !== currentFile && !currentFile.endsWith(jfile)) {
            // Open the file before jumping ; only handles project-
            // relative paths (skip "/usr/local/.../foo.sty" type
            // hits that come from texlive include trees).
            if (!jfile.startsWith('/') && !jfile.includes('texlive')) {
              onOpenFile(jfile, '');
            }
          }
          jumpToLine = line;
        }}
        onCloseRequest={toggleBottom}
      />
    </div>
    <!-- Standalone Preview panel docked to the right of the editor
         column. Sibling to ChatRoom / AIChatPanel — not nested inside
         the editor split. Width is user-resizable via the bordered
         drag handle on its left edge. -->
    {#if previewable}
      {#if previewOpen}
        <div
          role="separator"
          aria-orientation="vertical"
          tabindex="0"
          class="w-1.5 cursor-col-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
          class:bg-primary={previewDragging}
          onmousedown={startPreviewDrag}
          title="Drag to resize the preview"
        ></div>
        <PreviewPane
          {ydoc} {language} {project}
          file={currentFile}
          pdfURL={artifactURL}
          width={previewWidth}
          onShowErrors={() => { bottomOpen = true; bottomTab = 'log'; }}
          onClose={togglePreview}
        />
      {:else}
        <!-- Collapsed strip — keeps the preview affordance visible
             on the RIGHT edge. Click to expand back to previewWidth.
             Mirrors VSCode's collapsed-pane strip pattern. -->
        <button
          type="button"
          class="flex-none h-full w-8 border-l border-base-300 bg-base-200 hover:bg-base-300 flex flex-col items-center justify-start py-3 gap-2 transition-colors"
          onclick={togglePreview}
          title="Expand preview"
          aria-label="Expand preview"
        >
          <!-- codicon open-preview, vertically stacked label. -->
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M2 3h11l1 1v8.5l-.5.5H8.71l-2.36 2.35L5.5 15v-2H2l-1-1V3.99L2 3zm0 8.99h4v1.3l1.29-1.3H13V4H2v7.99zM13.27 0H4.06l-.71.7-.16.71.71.7L4.05 2H14v9.24l-.04.16.7.71h.71l.7-.71V.99L14.27 0h-1z"/>
          </svg>
          <span class="text-[10px] font-mono opacity-70" style="writing-mode: vertical-rl; transform: rotate(180deg);">
            Preview
          </span>
        </button>
      {/if}
    {/if}
    <!-- Right column : single panel containing AI Assistant +
         Chat as accordions. One ActivityBar button (💬) toggles
         the whole column. Inside, the user collapses / expands
         each pane individually via its header. -->
    {#if rightColOpen}
      <div
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        class="w-1.5 cursor-col-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
        class:bg-primary={rightColDragging}
        onmousedown={startRightColDrag}
        title="Drag to resize the right column"
      ></div>
      <div
        class="flex-none flex flex-col h-full border-l border-base-300"
        style="width: {rightColWidth}px"
      >
        <!-- AI accordion : header always visible ; body fills the
             remaining flex space when expanded ; collapses to its
             36 px header otherwise. -->
        <div
          class="flex flex-col overflow-hidden"
          class:flex-1={!aiCollapsed}
          class:flex-none={aiCollapsed}
        >
          <AIChatPanel
            bind:open={aiOpen}
            {project}
            {currentFile}
            fileContent={getFileContent}
            onClose={() => (aiCollapsed = true)}
            embedded={true}
            collapsed={aiCollapsed}
            onToggleCollapsed={() => (aiCollapsed = !aiCollapsed)}
          />
        </div>
        <!-- Chat accordion : same pattern as AI. -->
        <div
          class="flex flex-col overflow-hidden border-t border-base-300"
          class:flex-1={!chatCollapsed && aiCollapsed}
          class:flex-none={chatCollapsed || !aiCollapsed}
          style={chatCollapsed || !aiCollapsed ? (chatCollapsed ? '' : `height: ${chatPaneHeight}px`) : ''}
        >
          <ChatRoom
            {ydoc}
            {awareness}
            {identity}
            bind:open={chatOpen}
            embedded={true}
            onCloseRequest={() => (chatCollapsed = true)}
            collapsed={chatCollapsed}
            onToggleCollapsed={() => (chatCollapsed = !chatCollapsed)}
          />
        </div>
      </div>
    {/if}
  </main>
  <StatusBar
    {project} {language} {connectionStatus} {ytextTick} {currentFile}
    {cursorLine} {cursorCol} {selectionLen} {wordCount}
  />

  <!-- Git config modal — opened from the sidebar's ⚙ button OR the
       "Connect a remote…" CTA when no remote is configured yet. -->
  <GitPanel
    bind:open={gitConfigOpen}
    {project}
    onClose={() => (gitConfigOpen = false)}
    onSynced={refreshExplorer}
  />
  <SettingsPanel bind:open={settingsOpen} onClose={() => (settingsOpen = false)} />
  <QuickOpen
    bind:open={quickOpenOpen}
    {project}
    onClose={() => (quickOpenOpen = false)}
    onOpen={(path) => onOpenFile(path, languageForPath(path))}
  />
  <CommandPalette
    bind:open={paletteOpen}
    {commands}
    onClose={() => (paletteOpen = false)}
  />
  <AdminPanel bind:open={adminPanelOpen} onClose={() => (adminPanelOpen = false)} />
  <ContextMenu bind:this={ctx} />
</div>
