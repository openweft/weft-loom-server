<script lang="ts">
  // V0.5 track-changes history : timeline of per-file text snapshots
  // captured server-side after each writeFile (debounced 30 s). Click
  // an entry to preview ; click Restore to set the live file (which
  // broadcasts via Yjs to every peer).

  import { onMount } from 'svelte';
  import { logError } from '../logbus';

  interface Entry {
    ts: string;
    author: string;
    size: number;
  }
  interface SnapshotPayload {
    ts: string;
    author: string;
    size: number;
    content: string;
  }
  interface Props {
    project: string;
    file: string;
  }
  let { project, file }: Props = $props();

  let entries = $state<Entry[]>([]);
  let loading = $state(false);
  let loadError = $state<string | undefined>();
  let selectedTs = $state<string | undefined>();
  let preview = $state<SnapshotPayload | undefined>();
  let restoring = $state(false);
  let restoreError = $state<string | undefined>();
  let lastRefresh = $state(0);

  function url(path: string): string {
    return '/api/projects/' + encodeURIComponent(project) + path;
  }

  async function refresh() {
    if (!project || !file) return;
    loading = true;
    loadError = undefined;
    try {
      const r = await fetch(url('/history?file=' + encodeURIComponent(file)));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      entries = Array.isArray(data?.entries) ? data.entries : [];
      lastRefresh = Date.now();
    } catch (e) {
      loadError = String(e);
      logError('history', 'list-failed', e);
    } finally {
      loading = false;
    }
  }

  async function loadSnapshot(ts: string) {
    selectedTs = ts;
    preview = undefined;
    try {
      const r = await fetch(url('/history/snapshot?file=' + encodeURIComponent(file) + '&at=' + encodeURIComponent(ts)));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      preview = await r.json();
    } catch (e) {
      logError('history', 'snapshot-failed', e);
    }
  }

  async function restore(ts: string) {
    if (!confirm('Restore the file to this version ? Unsaved changes will be lost (peers will see the rollback too).')) return;
    restoring = true;
    restoreError = undefined;
    try {
      const r = await fetch(url('/history/restore'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, at: ts }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // The writeFile path will broadcast via Yjs. Local view picks
      // it up on the next file load. Force a refresh so the new
      // snapshot entry (from the restore-write) appears.
      await refresh();
    } catch (e) {
      restoreError = String(e);
      logError('history', 'restore-failed', e);
    } finally {
      restoring = false;
    }
  }

  function shortTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString();
    return d.toLocaleString();
  }

  function shortAuthor(a: string): string {
    if (!a) return 'unknown';
    if (a.length > 20) return a.slice(0, 18) + '…';
    return a;
  }

  function humanBytes(n: number): string {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  onMount(refresh);
  // Refresh whenever the file prop changes.
  $effect(() => { file; project; void refresh(); });
</script>

<div class="h-full w-full flex flex-col bg-base-100 text-sm">
  <header class="flex items-center justify-between px-3 py-2 border-b border-base-300 bg-base-200">
    <div class="flex items-center gap-2">
      <span class="font-semibold">History</span>
      <span class="opacity-60">{file || '(no file)'}</span>
    </div>
    <button
      type="button"
      class="btn btn-xs btn-ghost"
      onclick={refresh}
      disabled={loading || !file}
      aria-label="Refresh history"
      title="Refresh"
    >⟳</button>
  </header>

  {#if loadError}
    <div class="px-3 py-2 text-error">{loadError}</div>
  {/if}
  {#if restoreError}
    <div class="px-3 py-2 text-error">Restore failed : {restoreError}</div>
  {/if}

  <div class="flex-1 overflow-hidden flex">
    <!-- Timeline list -->
    <ul class="w-64 flex-none border-r border-base-300 overflow-y-auto" role="list" aria-label="History timeline">
      {#if loading && entries.length === 0}
        <li class="px-3 py-2 opacity-50">Loading…</li>
      {:else if entries.length === 0}
        <li class="px-3 py-3 opacity-50 text-xs">
          No history yet. Snapshots are captured after each save (debounced 30 s).
        </li>
      {:else}
        {#each entries as e (e.ts)}
          <li>
            <button
              type="button"
              class="w-full px-3 py-2 text-left hover:bg-base-200 border-b border-base-200/50 flex flex-col gap-0.5"
              class:bg-base-300={e.ts === selectedTs}
              onclick={() => loadSnapshot(e.ts)}
              aria-current={e.ts === selectedTs ? 'true' : undefined}
            >
              <span class="font-mono text-xs">{shortTime(e.ts)}</span>
              <span class="text-xs opacity-70">{shortAuthor(e.author)} · {humanBytes(e.size)}</span>
            </button>
          </li>
        {/each}
      {/if}
    </ul>

    <!-- Preview pane -->
    <div class="flex-1 flex flex-col overflow-hidden">
      {#if !preview}
        <div class="flex-1 flex items-center justify-center text-base-content/50 text-xs">
          Select a snapshot to preview it.
        </div>
      {:else}
        <div class="flex items-center justify-between px-3 py-2 border-b border-base-300 bg-base-200/50">
          <span class="font-mono text-xs">{shortTime(preview.ts)} · {shortAuthor(preview.author)}</span>
          <button
            type="button"
            class="btn btn-xs btn-warning"
            onclick={() => restore(preview!.ts)}
            disabled={restoring}
            aria-label="Restore this version"
          >{restoring ? 'Restoring…' : 'Restore this version'}</button>
        </div>
        <pre class="flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-words">{preview.content}</pre>
      {/if}
    </div>
  </div>

  <footer class="px-3 py-1 text-xs opacity-60 border-t border-base-300">
    Last refreshed : {lastRefresh ? shortTime(new Date(lastRefresh).toISOString()) : '—'}
    · {entries.length} snapshot{entries.length === 1 ? '' : 's'}
  </footer>
</div>
