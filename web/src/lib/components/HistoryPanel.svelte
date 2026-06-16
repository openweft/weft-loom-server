<script lang="ts">
  // V0.5 track-changes history : timeline of per-file text snapshots
  // captured server-side after each writeFile (debounced 30 s). Click
  // an entry to preview ; click Restore to set the live file (which
  // broadcasts via Yjs to every peer).

  import { onMount } from 'svelte';
  import { logError } from '../logbus';
  import {
    listHistory,
    getHistorySnapshot,
    diffHistory,
    setHistoryLabel,
    restoreHistory,
    type HistoryEntry,
    type HistorySnapshot,
    type HistoryDiff,
  } from '../api';

  type Entry = HistoryEntry;
  type SnapshotPayload = HistorySnapshot;
  type DiffPayload = HistoryDiff;
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
  // View mode for the right pane :
  //   'content' = full snapshot text (V0.5)
  //   'diff'    = unified diff snapshot ↔ live file
  let viewMode = $state<'content' | 'diff'>('diff');
  let diff = $state<DiffPayload | undefined>();
  let diffError = $state<string | undefined>();
  // Diff target : 'live' compares the selected snapshot against the
  // current file ; a TS string compares against that other snapshot.
  let diffTarget = $state<string>('live');
  // Inline label editing — keyed by ts. Empty string means not
  // currently editing that entry.
  let editingLabelTs = $state<string | null>(null);
  let labelDraft = $state<string>('');

  async function refresh() {
    if (!project || !file) return;
    loading = true;
    loadError = undefined;
    try {
      entries = await listHistory(project, file);
      lastRefresh = Date.now();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      logError('history', 'list-failed', e);
    } finally {
      loading = false;
    }
  }

  async function loadSnapshot(ts: string) {
    selectedTs = ts;
    preview = undefined;
    diff = undefined;
    diffError = undefined;
    // Kick off BOTH in parallel — the user can toggle the view mode
    // without an extra round-trip.
    const snapP = getHistorySnapshot(project, file, ts)
      .then((s) => { preview = s; })
      .catch((e) => { logError('history', 'snapshot-failed', e); });
    const diffP = fetchDiff(ts, diffTarget);
    await Promise.allSettled([snapP, diffP]);
  }

  async function fetchDiff(fromTs: string, toRef: string) {
    diff = undefined;
    diffError = undefined;
    try {
      diff = await diffHistory(project, file, fromTs, toRef);
    } catch (e) {
      diffError = e instanceof Error ? e.message : String(e);
      logError('history', 'diff-failed', e);
    }
  }

  async function saveLabel(ts: string, label: string) {
    try {
      await setHistoryLabel(project, file, ts, label);
      // Refresh so the label surfaces on the timeline immediately.
      await refresh();
    } catch (e) {
      logError('history', 'label-failed', e);
    }
  }

  function startEditLabel(e: Entry) {
    editingLabelTs = e.ts;
    labelDraft = e.label ?? '';
  }
  function commitLabel() {
    if (!editingLabelTs) return;
    void saveLabel(editingLabelTs, labelDraft.trim());
    editingLabelTs = null;
  }
  function cancelLabel() {
    editingLabelTs = null;
    labelDraft = '';
  }

  // When the diff-target dropdown changes, re-fetch diff with the
  // currently-selected from snapshot.
  $effect(() => {
    if (selectedTs) void fetchDiff(selectedTs, diffTarget);
  });

  async function restore(ts: string) {
    if (!confirm('Restore the file to this version ? Unsaved changes will be lost (peers will see the rollback too).')) return;
    restoring = true;
    restoreError = undefined;
    try {
      await restoreHistory(project, file, ts);
      // The writeFile path will broadcast via Yjs. Local view picks
      // it up on the next file load. Force a refresh so the new
      // snapshot entry (from the restore-write) appears.
      await refresh();
    } catch (e) {
      restoreError = e instanceof Error ? e.message : String(e);
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
            <div
              class="group w-full px-3 py-2 text-left hover:bg-base-200 border-b border-base-200/50 flex flex-col gap-0.5"
              class:bg-base-300={e.ts === selectedTs}
              data-testid="hist-entry"
              data-ts={e.ts}
            >
              <button
                type="button"
                class="w-full text-left"
                onclick={() => loadSnapshot(e.ts)}
                aria-current={e.ts === selectedTs ? 'true' : undefined}
              >
                <span class="font-mono text-xs">{shortTime(e.ts)}</span>
                {#if e.label}
                  <span class="badge badge-primary badge-xs ml-1 align-middle" data-testid="hist-label">{e.label}</span>
                {/if}
                <span class="block text-xs opacity-70">{shortAuthor(e.author)} · {humanBytes(e.size)}</span>
              </button>
              {#if editingLabelTs === e.ts}
                <div class="flex gap-1 items-center mt-1" data-testid="hist-label-editor">
                  <input
                    type="text"
                    class="input input-xs input-bordered flex-1"
                    placeholder="Label this version…"
                    bind:value={labelDraft}
                    maxlength="80"
                    onkeydown={(ev) => {
                      if (ev.key === 'Enter') { ev.preventDefault(); commitLabel(); }
                      else if (ev.key === 'Escape') { ev.preventDefault(); cancelLabel(); }
                    }}
                    data-testid="hist-label-input"
                  />
                  <button class="btn btn-xs btn-primary" onclick={commitLabel} data-testid="hist-label-save">Save</button>
                  <button class="btn btn-xs btn-ghost" onclick={cancelLabel}>×</button>
                </div>
              {:else}
                <button
                  type="button"
                  class="text-xs underline opacity-0 group-hover:opacity-60 hover:opacity-100 self-start mt-0.5"
                  onclick={() => startEditLabel(e)}
                  data-testid="hist-label-edit"
                  aria-label="Edit label"
                >{e.label ? 'Rename label' : 'Add label'}</button>
              {/if}
            </div>
          </li>
        {/each}
      {/if}
    </ul>

    <!-- Preview pane : header + (diff | content) body -->
    <div class="flex-1 flex flex-col overflow-hidden">
      {#if !preview && !diff}
        <div class="flex-1 flex items-center justify-center text-base-content/50 text-xs">
          Select a snapshot to preview it.
        </div>
      {:else}
        <div class="flex items-center justify-between px-3 py-2 border-b border-base-300 bg-base-200/50 gap-2">
          <span class="font-mono text-xs">
            {shortTime(preview?.ts ?? selectedTs ?? '')}
            · {shortAuthor(preview?.author ?? '')}
            {#if diff?.summary}
              <span class="ml-2 text-success" data-testid="diff-added">+{diff.summary.added}</span>
              <span class="text-error" data-testid="diff-removed">−{diff.summary.removed}</span>
            {/if}
          </span>
          <div class="flex items-center gap-1">
            {#if viewMode === 'diff'}
              <select
                class="select select-xs select-bordered"
                aria-label="Compare against"
                bind:value={diffTarget}
                data-testid="hist-diff-target"
              >
                <option value="live">vs live file</option>
                {#each entries as e (e.ts)}
                  {#if e.ts !== selectedTs}
                    <option value={e.ts}>vs {e.label ? e.label + ' (' + shortTime(e.ts) + ')' : shortTime(e.ts)}</option>
                  {/if}
                {/each}
              </select>
            {/if}
            <div role="tablist" class="join" aria-label="View mode">
              <button
                role="tab"
                type="button"
                class="join-item btn btn-xs"
                class:btn-active={viewMode === 'diff'}
                onclick={() => (viewMode = 'diff')}
                aria-selected={viewMode === 'diff'}
                data-testid="hist-view-diff"
              >Diff</button>
              <button
                role="tab"
                type="button"
                class="join-item btn btn-xs"
                class:btn-active={viewMode === 'content'}
                onclick={() => (viewMode = 'content')}
                aria-selected={viewMode === 'content'}
                data-testid="hist-view-content"
              >Content</button>
            </div>
            <button
              type="button"
              class="btn btn-xs btn-warning"
              onclick={() => preview && restore(preview.ts)}
              disabled={restoring || !preview}
              aria-label="Restore this version"
            >{restoring ? 'Restoring…' : 'Restore this version'}</button>
          </div>
        </div>
        {#if viewMode === 'diff'}
          <div class="flex-1 overflow-auto" data-testid="hist-diff-body">
            {#if diffError}
              <div class="px-3 py-2 text-error text-xs">{diffError}</div>
            {:else if !diff}
              <div class="px-3 py-2 opacity-50 text-xs">Loading diff…</div>
            {:else if diff.hunks.length === 0}
              <div class="px-3 py-3 opacity-60 text-xs">No differences vs the live file.</div>
            {:else}
              <table class="font-mono text-xs w-full border-collapse">
                <tbody>
                  {#each diff.hunks as h, hi (hi)}
                    {#if hi > 0}
                      <tr class="bg-base-200/70 text-base-content/60">
                        <td colspan="3" class="px-3 py-1 text-center">⋯</td>
                      </tr>
                    {/if}
                    {#each h.lines as l, li (hi + ':' + li)}
                      <tr
                        class="border-b border-base-200/40"
                        class:bg-success={l.kind === 'add'}
                        class:bg-error={l.kind === 'remove'}
                        class:bg-opacity-10={l.kind !== 'context'}
                      >
                        <td class="w-12 text-right pr-2 select-none text-base-content/40">
                          {l.oldLineNum > 0 ? l.oldLineNum : ''}
                        </td>
                        <td class="w-12 text-right pr-2 select-none text-base-content/40">
                          {l.newLineNum > 0 ? l.newLineNum : ''}
                        </td>
                        <td class="px-2 whitespace-pre-wrap break-words">
                          <span class="text-base-content/40 mr-1 select-none">{l.kind === 'add' ? '+' : l.kind === 'remove' ? '−' : ' '}</span>{l.text}
                        </td>
                      </tr>
                    {/each}
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
        {:else}
          <pre class="flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-words" data-testid="hist-content-body">{preview?.content ?? ''}</pre>
        {/if}
      {/if}
    </div>
  </div>

  <footer class="px-3 py-1 text-xs opacity-60 border-t border-base-300">
    Last refreshed : {lastRefresh ? shortTime(new Date(lastRefresh).toISOString()) : '—'}
    · {entries.length} snapshot{entries.length === 1 ? '' : 's'}
  </footer>
</div>
