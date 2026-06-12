<script lang="ts">
  // DoctorPanel — third tab in BottomPanel ; tails /api/events SSE
  // and shows server+client events live. Operators get a single
  // pane to see what's happening across the WS sync, seed claims,
  // shell spawns, compile jobs, AND the SPA's own self-reports
  // (editor mounts, seed completions, fetch failures).
  //
  // No backend writes from this UI — it's read-only observability.
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    open: boolean;
    project: string;
  }

  let { open = $bindable(), project }: Props = $props();

  interface DoctorEvent {
    ts: string;
    source: 'server' | 'client';
    component: string;
    verb: string;
    level: string;
    message?: string;
    fields?: Record<string, unknown>;
    project?: string;
  }

  let events = $state<DoctorEvent[]>([]);
  let filter = $state('');
  let sourceFilter = $state<'all' | 'server' | 'client'>('all');
  let levelFilter = $state<'all' | 'info' | 'warn' | 'error'>('all');
  let projectScope = $state<boolean>(true);
  let sse: EventSource | undefined;
  let paused = $state(false);
  let scroll: HTMLDivElement | undefined = $state();

  function connect() {
    if (sse) sse.close();
    sse = new EventSource('/api/events');
    sse.onmessage = (msg) => {
      if (paused) return;
      try {
        const ev = JSON.parse(msg.data) as DoctorEvent;
        events.push(ev);
        // Cap memory — keep the most recent 2 000 events. Older
        // ones get dropped from the head of the array.
        if (events.length > 2000) events.splice(0, events.length - 2000);
      } catch {
        /* malformed SSE payload — skip */
      }
      if (scroll) {
        // Auto-scroll only when user is near the bottom already.
        const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
        if (nearBottom) {
          requestAnimationFrame(() => {
            if (scroll) scroll.scrollTop = scroll.scrollHeight;
          });
        }
      }
    };
    sse.onerror = () => {
      // Browser will auto-reconnect ; we just visually flag it.
    };
  }

  onMount(() => connect());
  onDestroy(() => sse?.close());

  const filtered = $derived.by(() => {
    const f = filter.trim().toLowerCase();
    return events.filter((e) => {
      if (projectScope && e.project && project && e.project !== project) return false;
      if (sourceFilter !== 'all' && e.source !== sourceFilter) return false;
      if (levelFilter !== 'all' && e.level !== levelFilter) return false;
      if (!f) return true;
      const blob = `${e.component} ${e.verb} ${e.message ?? ''} ${JSON.stringify(e.fields ?? {})}`.toLowerCase();
      return blob.includes(f);
    });
  });

  function clear() { events = []; }
  function togglePause() { paused = !paused; }

  function levelClass(l: string): string {
    if (l === 'error') return 'text-error';
    if (l === 'warn') return 'text-warning';
    if (l === 'debug') return 'opacity-50';
    return '';
  }

  function fmtTime(ts: string): string {
    try {
      return new Date(ts).toLocaleTimeString(undefined, { hour12: false }) + '.' + new Date(ts).getMilliseconds().toString().padStart(3, '0');
    } catch { return ts; }
  }
</script>

<!-- See ShellPanel.svelte header : `open` toggles CSS hidden, not
     a #if unmount, so the SSE buffer + event stream stay alive
     across tab switches. -->
<div class="flex flex-col h-full bg-base-100" class:hidden={!open}>
    <div class="flex items-center gap-2 px-2 py-1 border-b border-base-300 bg-base-200">
      <input
        type="text"
        bind:value={filter}
        placeholder="filter…"
        class="input input-bordered input-xs w-48 font-mono"
      />
      <select bind:value={sourceFilter} class="select select-bordered select-xs">
        <option value="all">all</option>
        <option value="server">server</option>
        <option value="client">client</option>
      </select>
      <select bind:value={levelFilter} class="select select-bordered select-xs">
        <option value="all">all levels</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
      <label class="label cursor-pointer gap-1 p-0">
        <input type="checkbox" class="checkbox checkbox-xs" bind:checked={projectScope} />
        <span class="text-xs">this project only</span>
      </label>
      <span class="badge badge-ghost badge-sm ml-2">{filtered.length}/{events.length}</span>
      <div class="ml-auto flex gap-1">
        <button class="btn btn-ghost btn-xs" onclick={togglePause} title="Pause / resume">
          {paused ? '▶' : '⏸'}
        </button>
        <button class="btn btn-ghost btn-xs" onclick={clear} title="Clear buffer">🧹</button>
      </div>
    </div>
    <div bind:this={scroll} class="flex-1 overflow-y-auto font-mono text-xs">
      {#if filtered.length === 0}
        <div class="px-3 py-2 opacity-50">No events match the current filters.</div>
      {/if}
      {#each filtered as e (e.ts + e.source + e.component + e.verb)}
        <div class="px-2 py-0.5 border-b border-base-200 flex gap-2 leading-snug {levelClass(e.level)}">
          <span class="opacity-50 flex-none">{fmtTime(e.ts)}</span>
          <span class="badge badge-xs flex-none {e.source === 'server' ? 'badge-info' : 'badge-secondary'}">{e.source}</span>
          <span class="font-semibold flex-none">{e.component}.{e.verb}</span>
          {#if e.message}<span class="opacity-80">{e.message}</span>{/if}
          {#if e.fields && Object.keys(e.fields).length > 0}
            <span class="opacity-60 truncate">{JSON.stringify(e.fields)}</span>
          {/if}
        </div>
      {/each}
    </div>
  </div>
