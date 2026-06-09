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
  }

  function onOpenFile(path: string, lang: string) {
    currentFile = path;
    language = lang;
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
        <PreviewPane {ydoc} {language} file={currentFile} />
      </div>
    {/if}
  </main>
  <CompileDrawer
    bind:open={compileOpen.open}
    {project}
    {language}
  />
</div>
