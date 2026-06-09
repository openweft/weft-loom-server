<script lang="ts">
  import * as Y from 'yjs';
  import Editor from './lib/components/Editor.svelte';
  import Navbar from './lib/components/Navbar.svelte';
  import CompileDrawer from './lib/components/CompileDrawer.svelte';
  import PreviewPane from './lib/components/PreviewPane.svelte';

  // V0.2 reads /api/projects via the ProjectSwitcher dropdown in
  // the navbar ; switching invalidates the editor key so the
  // CodeMirror instance + Yjs room recreate cleanly. "demo" is the
  // initial fallback when the user lands without picking yet.
  let project = $state('demo');
  let language = $state<string>('markdown');
  let compileOpen = $state({ open: false });
  // The Editor binds the shared Yjs doc here so PreviewPane can
  // attach an observer to the same ytext — every keystroke updates
  // the right pane within ~100ms (debounced).
  let ydoc = $state<Y.Doc | undefined>();
  // showPreview is on when the language has a meaningful inline
  // rendering (markdown, latex). Other languages get a 100% editor
  // pane — no useless empty preview taking screen real estate.
  let showPreview = $derived(language === 'markdown' || language === 'latex');

  let connectionStatus = $state<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );

  function onSwitch(name: string, lang: string) {
    project = name;
    language = lang;
    ydoc = undefined; // Editor key change rebuilds the doc ; observer rebinds.
    // Editor.svelte is keyed on `project` ; the change triggers
    // onMount/onDestroy so the WebsocketProvider reconnects to the
    // new room.
  }
</script>

<div class="flex h-screen flex-col bg-base-200">
  <Navbar
    {project}
    {language}
    {connectionStatus}
    onCompile={() => (compileOpen.open = true)}
    {onSwitch}
  />
  <main class="flex flex-1 overflow-hidden">
    <div class="flex-1 overflow-hidden border-r border-base-300">
      {#key project}
        <Editor
          {project}
          {language}
          onStatus={(s) => (connectionStatus = s)}
          onYDoc={(d) => (ydoc = d)}
        />
      {/key}
    </div>
    {#if showPreview}
      <div class="flex-1 overflow-hidden">
        <PreviewPane {ydoc} {language} />
      </div>
    {/if}
  </main>
  <CompileDrawer
    bind:open={compileOpen.open}
    {project}
    {language}
  />
</div>
