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
  import CompileLogPanel from './lib/components/CompileLogPanel.svelte';
  import Editor from './lib/components/Editor.svelte';
  import Resizer from './lib/components/Resizer.svelte';
  import TabBar from './lib/components/TabBar.svelte';
  import AIChatPanel from './lib/components/AIChatPanel.svelte';
  import { loadIdentity, type Identity } from './lib/identity';
  import { applyTheme, loadTheme, languageForPath } from './lib/theme';

  let identity = $state<Identity>(loadIdentity());

  onMount(() => {
    applyTheme(loadTheme());
  });

  let project = $state('demo');
  let currentFile = $state('');
  let language = $state<string>('markdown');
  // openFiles[] : the multi-tab editor list, ordered left → right.
  // Adding a file that's already open just activates it.
  let openFiles = $state<string[]>([]);
  let aiOpen = $state<boolean>(false);
  onMount(() => {
    const a = localStorage.getItem('weft-loom-ai-open');
    if (a === '1') aiOpen = true;
  });
  function toggleAI() {
    aiOpen = !aiOpen;
    try { localStorage.setItem('weft-loom-ai-open', aiOpen ? '1' : '0'); } catch {}
  }
  function getFileContent(): string {
    // Best-effort : the Editor binds the ytext via onYDoc. We pull
    // the current file's ytext string for the chat panel context.
    if (!ydoc || !currentFile) return '';
    return ydoc.getText('file:' + currentFile).toString();
  }
  let ydoc = $state<Y.Doc | undefined>();
  let awareness = $state<Awareness | undefined>();
  let connectionStatus = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
  let logOpen = $state<boolean>(true);
  let artifactURL = $state<string | undefined>();
  onMount(() => {
    const v = localStorage.getItem('weft-loom-logpanel-open');
    if (v === '0') logOpen = false;
  });
  function toggleLog() {
    logOpen = !logOpen;
    try { localStorage.setItem('weft-loom-logpanel-open', logOpen ? '1' : '0'); } catch {}
  }

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
    logOpen = true;
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
  let showPreview = $derived(language === 'markdown' || language === 'latex');
  // splitPct controls the editor/preview width balance ; restored from
  // localStorage on mount so the user's last drag survives reloads.
  let splitPct = $state<number>(50);
  onMount(() => {
    const v = localStorage.getItem('weft-loom-split-pct');
    if (v) {
      const n = Number(v);
      if (!Number.isNaN(n) && n >= 15 && n <= 85) splitPct = n;
    }
  });

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
    awareness?.setLocalStateField('user', { name: next.name, color: next.color });
  }
</script>

<div class="flex h-screen flex-col bg-base-200">
  <Navbar
    {project}
    {language}
    {connectionStatus}
    {awareness}
    {identity}
    onCompile={toggleLog}
    onExportPDF={exportPDF}
    onToggleAI={toggleAI}
    {onSwitch}
    {onLanguageChange}
    {onRename}
  />
  <main class="flex flex-1 overflow-hidden">
    <div style="width: {sidebarWidth}px" class="flex-none overflow-hidden">
      <FileExplorer {project} currentFile={currentFile} onOpen={onOpenFile} />
    </div>
    <div
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      class="w-1.5 cursor-col-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
      class:bg-primary={sidebarDragging}
      onmousedown={startSidebarDrag}
      title="Drag to resize the file explorer"
    ></div>
    <div
      class="overflow-hidden flex flex-col"
      style={showPreview ? `flex: 0 0 ${splitPct}%` : 'flex: 1'}
    >
      <TabBar
        files={openFiles}
        active={currentFile}
        onActivate={onActivateTab}
        onClose={onCloseTab}
      />
      <div class="flex-1 overflow-hidden">
        {#key project + '|' + currentFile}
          <Editor
            {project}
            {language}
            file={currentFile}
            {identity}
            onStatus={(s) => (connectionStatus = s)}
            onYDoc={(d) => (ydoc = d)}
            onAwareness={(a) => (awareness = a)}
          />
        {/key}
      </div>
    </div>
    {#if showPreview}
      <Resizer bind:splitPct storageKey="weft-loom-split-pct" />
      <div class="overflow-hidden" style="flex: 1 1 auto">
        <PreviewPane {ydoc} {language} file={currentFile} pdfURL={artifactURL} />
      </div>
    {/if}
    <AIChatPanel
      bind:open={aiOpen}
      {project}
      {currentFile}
      fileContent={getFileContent}
      onClose={toggleAI}
    />
  </main>
  <CompileLogPanel
    bind:open={logOpen}
    {project}
    {language}
    onArtifact={(url) => (artifactURL = url)}
    onCloseRequest={toggleLog}
  />
</div>
