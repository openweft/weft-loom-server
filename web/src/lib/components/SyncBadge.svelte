<script lang="ts">
  // SyncBadge — small navbar chip showing the project's git sync
  // state. Polls /git/status every 10s ; cheap GET, server reads
  // .git-config.json + computes go-git status from the working tree.
  //
  //   no badge        project isn't git-configured
  //   synced 3s ago   in sync (green)
  //   1 ahead         pending changes (warning)
  //   1 behind        upstream advanced (warning)
  //   error           git operation failed (red)
  import { onDestroy } from 'svelte';
  import { getStatus, type GitStatus } from '../git';

  interface Props {
    project: string;
  }

  let { project }: Props = $props();

  let status = $state<GitStatus | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    if (!project) return;
    try {
      status = await getStatus(project);
    } catch {
      status = null;
    }
  }

  $effect(() => {
    refresh();
    if (timer) clearInterval(timer);
    if (project) {
      // 10s pulse is rare enough to be cheap, frequent enough that
      // the user sees the chip clear within a moment of the
      // auto-push completing.
      timer = setInterval(refresh, 10_000);
    }
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  function ago(unix: number): string {
    if (!unix) return '';
    const d = Math.max(0, Math.floor(Date.now() / 1000 - unix));
    if (d < 5) return 'just now';
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }
</script>

{#if status?.configured}
  {#if status.last_error}
    <span class="badge badge-error badge-sm" title={status.last_error}>
      ⎇ error
    </span>
  {:else if status.ahead > 0 || status.behind > 0 || status.changes.length > 0}
    <span class="badge badge-warning badge-sm" title="{status.ahead} ahead · {status.behind} behind · {status.changes.length} changes">
      ⎇
      {#if status.ahead > 0}{status.ahead} ahead{/if}
      {#if status.behind > 0}{status.behind} behind{/if}
      {#if status.ahead === 0 && status.behind === 0 && status.changes.length > 0}{status.changes.length} pending{/if}
    </span>
  {:else}
    <span class="badge badge-success badge-sm" title="last sync : {status.last_sync_unix ? new Date(status.last_sync_unix * 1000).toLocaleString() : 'unknown'}">
      ⎇ synced{#if status.last_sync_unix} {ago(status.last_sync_unix)}{/if}
    </span>
  {/if}
{/if}
