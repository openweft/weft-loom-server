<script lang="ts">
  import Editor from './lib/components/Editor.svelte';
  import Navbar from './lib/components/Navbar.svelte';
  import CompileDrawer from './lib/components/CompileDrawer.svelte';

  // V0.1 single-project demo : everything points at the "demo" room.
  // V0.2 reads /api/projects and shows a project switcher in the navbar.
  const project = $state('demo');
  const language = $state<string>('markdown');
  const compileOpen = $state({ open: false });

  let connectionStatus = $state<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );
</script>

<div class="flex h-screen flex-col bg-base-200">
  <Navbar
    {project}
    {language}
    {connectionStatus}
    onCompile={() => (compileOpen.open = true)}
  />
  <main class="flex-1 overflow-hidden">
    <Editor
      {project}
      {language}
      onStatus={(s) => (connectionStatus = s)}
    />
  </main>
  <CompileDrawer
    bind:open={compileOpen.open}
    {project}
    {language}
  />
</div>
