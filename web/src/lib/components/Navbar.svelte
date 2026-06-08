<script lang="ts">
  interface Props {
    project: string;
    language: string;
    connectionStatus: 'connecting' | 'connected' | 'disconnected';
    onCompile: () => void;
  }

  let { project, language, connectionStatus, onCompile }: Props = $props();

  // daisyUI badge variant maps to the y-websocket lifecycle state.
  const statusBadge = $derived(
    connectionStatus === 'connected'
      ? 'badge-success'
      : connectionStatus === 'connecting'
        ? 'badge-warning'
        : 'badge-error',
  );
</script>

<div class="navbar bg-base-100 border-base-300 border-b shadow-sm">
  <div class="flex-1">
    <span class="btn btn-ghost text-xl normal-case">
      weft-loom
      <span class="ml-2 text-xs opacity-60 font-normal">collaborative editor</span>
    </span>
  </div>
  <div class="flex-none gap-2">
    <span class="text-sm opacity-70">
      <span class="font-mono">{project}</span>
    </span>
    <div class="divider divider-horizontal mx-0"></div>
    <span class="text-sm opacity-70">
      lang : <span class="font-mono">{language}</span>
    </span>
    <div class="divider divider-horizontal mx-0"></div>
    <div class="badge {statusBadge} badge-sm gap-1">
      <span class="status status-sm"></span>
      {connectionStatus}
    </div>
    <button class="btn btn-primary btn-sm" onclick={onCompile}>
      Compile
    </button>
  </div>
</div>
