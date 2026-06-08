<script lang="ts">
  import Editor from './lib/components/Editor.svelte';
  import Navbar from './lib/components/Navbar.svelte';
  import CompileDrawer from './lib/components/CompileDrawer.svelte';

  // V0.2 reads /api/projects via the ProjectSwitcher dropdown in
  // the navbar ; switching invalidates the editor key so the
  // CodeMirror instance + Yjs room recreate cleanly. "demo" is the
  // initial fallback when the user lands without picking yet.
  let project = $state('demo');
  let language = $state<string>('markdown');
  let compileOpen = $state({ open: false });

  let connectionStatus = $state<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );

  function onSwitch(name: string, lang: string) {
    project = name;
    language = lang;
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
  <main class="flex-1 overflow-hidden">
    {#key project}
      <Editor
        {project}
        {language}
        onStatus={(s) => (connectionStatus = s)}
      />
    {/key}
  </main>
  <CompileDrawer
    bind:open={compileOpen.open}
    {project}
    {language}
  />
</div>
