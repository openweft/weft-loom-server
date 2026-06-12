<script lang="ts">
  // GitSidebar — VSCode-style Source Control panel that lives in the
  // left side bar (activity-bar 'scm' view). Reuses the same /api/.../git/*
  // surface as the modal GitPanel but renders in a vertical layout.
  //
  // Sections (top → bottom) :
  //   - Header : branch · provider · ahead/behind badge
  //   - Sync actions : ↓ Pull / ↑ Push
  //   - Changes : list of FileChange rows, status icon + path
  //   - Footer : last sync time + ⚙ Configure (opens modal)
  //
  // Polls status every 15 s when visible. Pull / Push update inline.

  import { onMount, onDestroy } from 'svelte';
  import {
    getStatus,
    pull,
    push,
    providerLabel,
    webURL,
    type GitStatus,
  } from '../git';
  import SourceGraph from './SourceGraph.svelte';
  import { i18n } from '../i18n.svelte';

  interface Props {
    project: string;
    onOpenConfigModal: () => void;
    onSynced: () => void;
  }

  let { project, onOpenConfigModal, onSynced }: Props = $props();

  let status = $state<GitStatus | null>(null);
  let loading = $state(false);
  let busy = $state<'idle' | 'pulling' | 'pushing'>('idle');
  let err = $state<string | null>(null);
  let poll: ReturnType<typeof setInterval> | undefined;

  // Graph pane height (px) : resizable via the drag handle above
  // the SourceGraph header. localStorage persists across sessions.
  let graphHeight = $state<number>(
    (() => {
      try {
        const v = Number(localStorage.getItem('weft-loom-graph-height'));
        if (!Number.isNaN(v) && v >= 80 && v <= 800) return v;
      } catch {}
      return 240;
    })(),
  );
  let graphDragging = $state<boolean>(false);
  function startGraphDrag(ev: MouseEvent) {
    ev.preventDefault();
    graphDragging = true;
    const startY = ev.clientY;
    const startH = graphHeight;
    function move(e: MouseEvent) {
      // Inverted : drag UP grows the graph (it docks at the bottom
      // of the sidebar, anchored to the Changes pane above).
      const next = Math.max(80, Math.min(800, startH + (startY - e.clientY)));
      graphHeight = next;
    }
    function up() {
      graphDragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-graph-height', String(graphHeight)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  async function refresh() {
    loading = true;
    err = null;
    try {
      status = await getStatus(project);
    } catch (e) {
      err = String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    refresh();
    poll = setInterval(refresh, 15_000);
  });
  onDestroy(() => {
    if (poll) clearInterval(poll);
  });

  // Reload when the active project changes.
  $effect(() => {
    project;
    refresh();
  });

  async function doPull() {
    busy = 'pulling';
    err = null;
    try {
      status = await pull(project);
      onSynced();
    } catch (e) {
      err = String(e);
    } finally {
      busy = 'idle';
    }
  }

  async function doPush() {
    busy = 'pushing';
    err = null;
    try {
      status = await push(project);
    } catch (e) {
      err = String(e);
    } finally {
      busy = 'idle';
    }
  }

  // Map a status string to a single-char icon + tailwind colour, à la
  // VSCode's SCM (M=Modified yellow, A=Added green, D=Deleted red,
  // ?=Untracked grey, R=Renamed blue).
  function statusIcon(s: string): { ch: string; cls: string; label: string } {
    switch (s) {
      case 'modified':
        return { ch: 'M', cls: 'text-warning', label: 'Modified' };
      case 'staged':
        return { ch: 'A', cls: 'text-success', label: 'Staged' };
      case 'deleted':
        return { ch: 'D', cls: 'text-error', label: 'Deleted' };
      case 'renamed':
        return { ch: 'R', cls: 'text-info', label: 'Renamed' };
      case 'untracked':
        return { ch: '?', cls: 'opacity-60', label: 'Untracked' };
      default:
        return { ch: '·', cls: 'opacity-60', label: s };
    }
  }

  const aheadBehind = $derived.by(() => {
    if (!status) return '';
    const parts: string[] = [];
    if (status.ahead > 0) parts.push(`↑${status.ahead}`);
    if (status.behind > 0) parts.push(`↓${status.behind}`);
    return parts.join(' ') || '=';
  });
</script>

<div class="h-full flex flex-col bg-base-100 text-sm">
  <header class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200 gap-2">
    <span class="font-semibold text-sm flex items-center gap-1">
      <!-- codicon `source-control` — same as ActivityBar so the
           panel + button read as a pair. -->
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M21 8.25C21 6.18 19.32 4.5 17.25 4.5S13.5 6.18 13.5 8.25c0 1.77 1.24 3.25 2.9 3.64-.28.93-1.13 1.61-2.15 1.61H9.75c-.85 0-1.62.29-2.25.77V7.42c1.71-.35 3-1.86 3-3.67C10.5 1.68 8.82 0 6.75 0S3 1.68 3 3.75c0 1.81 1.29 3.33 3 3.67v9.16c-1.71.35-3 1.86-3 3.67C3 22.32 4.68 24 6.75 24S10.5 22.32 10.5 20.25c0-1.77-1.24-3.26-2.9-3.64.28-.93 1.13-1.61 2.15-1.61h4.5c1.83 0 3.36-1.33 3.68-3.07C19.67 11.61 21 10.08 21 8.25z"/>
      </svg>
      Source Control
    </span>
    <span class="ml-auto text-xs opacity-60 font-mono truncate">{project}</span>
  </header>

  {#if loading && !status}
    <div class="p-3 flex items-center gap-2 text-xs">
      <span class="loading loading-spinner loading-xs"></span>
      loading status…
    </div>
  {:else if err}
    <div class="m-2 alert alert-error text-xs">
      <span>{err}</span>
      <button class="btn btn-xs" onclick={refresh}>retry</button>
    </div>
  {:else if status && !status.configured}
    <div class="p-3 space-y-2">
      <p class="text-xs opacity-70">
        This project isn't linked to a Git remote.
      </p>
      <button class="btn btn-primary btn-xs btn-block" onclick={onOpenConfigModal}>
        ⚙ Connect a remote…
      </button>
    </div>
  {:else if status}
    <!-- Branch + sync state -->
    <div class="px-3 py-2 border-b border-base-300 space-y-1">
      <div class="flex items-center gap-2">
        <span class="font-mono text-xs opacity-60">branch</span>
        <span class="font-mono">{status.branch}</span>
        <span
          class="ml-auto badge badge-xs font-mono"
          class:badge-success={status.ahead === 0 && status.behind === 0}
          class:badge-warning={status.ahead > 0 || status.behind > 0}
        >{aheadBehind}</span>
      </div>
      <div class="flex items-center gap-2 text-xs opacity-60">
        <span>{providerLabel(status.provider)}</span>
        <span>·</span>
        <a
          class="link link-hover truncate font-mono"
          href={webURL(status.provider, status.remote_url)}
          target="_blank"
          rel="noopener"
        >{status.remote_url}</a>
      </div>
    </div>

    <!-- Sync buttons -->
    <div class="px-3 py-2 border-b border-base-300 flex gap-1">
      <button
        type="button"
        class="btn btn-xs btn-ghost flex-1"
        onclick={doPull}
        disabled={busy !== 'idle'}
        title="git pull"
      >
        {#if busy === 'pulling'}<span class="loading loading-spinner loading-xs"></span>{/if}
        ↓ Pull
      </button>
      <button
        type="button"
        class="btn btn-xs btn-ghost flex-1"
        onclick={doPush}
        disabled={busy !== 'idle' || status.ahead === 0}
        title="git push"
      >
        {#if busy === 'pushing'}<span class="loading loading-spinner loading-xs"></span>{/if}
        ↑ Push
      </button>
    </div>

    <!-- Changes -->
    <div class="px-3 py-2 text-xs opacity-60 uppercase">
      Changes
      <span class="badge badge-ghost badge-xs ml-1">{status.changes?.length ?? 0}</span>
    </div>
    <div class="flex-1 overflow-auto px-2">
      {#if !status.changes || status.changes.length === 0}
        <p class="px-2 py-3 text-xs opacity-50 italic">No changes.</p>
      {:else}
        <ul class="space-y-0.5">
          {#each status.changes as ch}
            {@const it = statusIcon(ch.status)}
            <li
              class="flex items-center gap-2 px-2 py-1 rounded hover:bg-base-200"
              title={it.label + ' · ' + ch.path}
            >
              <span class="w-4 text-center font-mono font-bold {it.cls}">{it.ch}</span>
              <span class="truncate font-mono">{ch.path}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- VSCode-style two-pane layout : Changes (above) + Source
         Control Graph (below) ALWAYS both visible. Resizable
         vertical split with a drag handle ; the graph height
         persists via localStorage so the user's preferred ratio
         sticks. -->
    <div
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      class="h-1.5 cursor-row-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
      class:bg-primary={graphDragging}
      onmousedown={startGraphDrag}
      title="Drag to resize the Source Control Graph"
    ></div>
    <div class="flex-none flex flex-col" style="height: {graphHeight}px">
      <header class="px-3 py-1.5 text-xs uppercase opacity-60 border-b border-base-300 flex items-center gap-2 select-none">
        <span>⌥ {i18n.t('scm.history')}</span>
        <span class="ml-auto opacity-40 font-mono text-[10px]">drag ↕</span>
      </header>
      <div class="flex-1 overflow-hidden">
        <SourceGraph {project} />
      </div>
    </div>

    <!-- Footer -->
    <footer class="border-t border-base-300 px-3 py-1.5 flex items-center gap-2 text-[10px] opacity-60">
      {#if status.last_sync_unix && status.last_sync_unix > 0}
        <span title="Last sync">
          {new Date(status.last_sync_unix * 1000).toLocaleString()}
        </span>
      {:else}
        <span class="italic">never synced</span>
      {/if}
      <button
        type="button"
        class="ml-auto btn btn-ghost btn-xs"
        onclick={onOpenConfigModal}
        title="Edit remote configuration"
      >⚙</button>
    </footer>
  {/if}
</div>
