<script lang="ts">
  import { onMount } from 'svelte';
  import * as Y from 'yjs';
  import type { Awareness } from 'y-protocols/awareness';
  import Editor from './lib/components/Editor.svelte';
  import Navbar from './lib/components/Navbar.svelte';
  import CompileDrawer from './lib/components/CompileDrawer.svelte';
  import PreviewPane from './lib/components/PreviewPane.svelte';
  import FileExplorer from './lib/components/FileExplorer.svelte';
  import { loadIdentity, type Identity } from './lib/identity';
  import { applyTheme, loadTheme, languageForPath } from './lib/theme';
  import { pull as gitPull } from './lib/git';

  // Restore the previously-picked theme synchronously so the first
  // paint doesn't flash the wrong palette. Identity is local to this
  // browser ; it doesn't ride the WS until the editor mounts.
  let identity = $state<Identity>(loadIdentity());

  onMount(() => {
    applyTheme(loadTheme());
  });

  // V0.2 reads /api/projects via the ProjectSwitcher dropdown in
  // the navbar ; switching invalidates the editor key so the
  // CodeMirror instance + Yjs room recreate cleanly. "demo" is the
  // initial fallback when the user lands without picking yet.
  let project = $state('demo');
  let currentFile = $state('');
  let language = $state<string>('markdown');
  let compileOpen = $state({ open: false });
  let ydoc = $state<Y.Doc | undefined>();
  let awareness = $state<Awareness | undefined>();
  // artifactURL : the URL the CompileDrawer received from the SSE
  // 'result' event. Piped into PreviewPane so the compiled PDF
  // shows inline (browser <embed>, not download). Cleared on project
  // or file switch so a stale PDF from another file doesn't linger.
  let artifactURL = $state<string | undefined>(undefined);
  let showPreview = $derived(language === 'markdown' || language === 'latex');

  let connectionStatus = $state<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );

  function onSwitch(name: string, lang: string) {
    project = name;
    currentFile = '';
    language = lang;
    ydoc = undefined;
    awareness = undefined;
    artifactURL = undefined;
    // V0.3 : git is the source of truth. Silently fire a pull when
    // a project opens so the working tree reflects whatever
    // collaborators pushed in a previous session. Unconfigured
    // projects 400 with "git not configured" — caught + ignored.
    silentPull(name);
  }

  async function silentPull(name: string) {
    if (!name) return;
    try {
      await gitPull(name);
    } catch {
      // Project may not be git-configured ; that's fine. The
      // GitPanel surfaces hard errors when the user opens it.
    }
  }

  function onOpenFile(path: string, lang: string) {
    currentFile = path;
    language = lang;
    artifactURL = undefined; // drop stale PDF when switching files
  }

  function onLanguageChange(lang: string) {
    language = lang;
  }

  function onRename(next: Identity) {
    identity = next;
    awareness?.setLocalStateField('user', {
      name: next.name,
      color: next.color,
    });
  }
</script>

<div class="flex h-screen flex-col bg-base-200">
  <Navbar
    {project}
    {language}
    {connectionStatus}
    {awareness}
    {identity}
    onCompile={() => (compileOpen.open = true)}
    {onSwitch}
    {onLanguageChange}
    {onRename}
  />
  <main class="flex flex-1 overflow-hidden">
    <FileExplorer
      {project}
      currentFile={currentFile}
      onOpen={onOpenFile}
    />
    <div class="flex-1 overflow-hidden border-r border-base-300">
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
    {#if showPreview}
      <div class="flex-1 overflow-hidden">
        <PreviewPane {ydoc} {language} file={currentFile} pdfURL={artifactURL} />
      </div>
    {/if}
  </main>
  <CompileDrawer
    bind:open={compileOpen.open}
    {project}
    {language}
    onArtifact={(url) => (artifactURL = url)}
  />
</div>
