<script lang="ts">
  // CompileLogPanel — collapsible bottom panel that holds the compile
  // output (log lines + result + Run button). Persistent across compile
  // runs ; unlike the old modal-based CompileDrawer the user can keep
  // it open while editing so log lines stream in live without taking
  // their hands off the editor.
  import { onMount, onDestroy } from 'svelte';
  import { startCompile } from '../api';

  interface Props {
    project: string;
    language: string;
    open: boolean;
    onArtifact?: (url: string) => void;
    onCloseRequest?: () => void;
  }

  let { project, language, open = $bindable(), onArtifact, onCloseRequest }: Props = $props();

  interface LogLine {
    kind: 'log' | 'result' | 'error';
    text: string;
    ts: number;
  }

  let lines = $state<LogLine[]>([]);
  let inFlight = $state(false);
  let resultURL = $state<string | null>(null);
  let activeTab = $state<'log' | 'errors'>('log');
  let height = $state<number>(220);
  let dragging = $state(false);

  // Persist panel height + open state across reloads.
  onMount(() => {
    const h = localStorage.getItem('weft-loom-logpanel-height');
    if (h) {
      const n = Number(h);
      if (!Number.isNaN(n) && n >= 100 && n <= 600) height = n;
    }
  });

  function push(line: LogLine) {
    lines = [...lines, line];
  }

  async function run() {
    lines = [];
    resultURL = null;
    inFlight = true;
    push({ kind: 'log', text: `running compile (${language})…`, ts: Date.now() });
    try {
      const id = await startCompile(project, { language });
      push({ kind: 'log', text: `job ${id} started`, ts: Date.now() });
      const es = new EventSource(
        `/api/projects/${encodeURIComponent(project)}/compile/${id}`,
      );
      es.addEventListener('log', (e) => {
        const ev = e as MessageEvent;
        try {
          const { line } = JSON.parse(ev.data);
          push({ kind: 'log', text: line, ts: Date.now() });
        } catch {
          push({ kind: 'log', text: ev.data, ts: Date.now() });
        }
      });
      es.addEventListener('result', (e) => {
        const ev = e as MessageEvent;
        try {
          const r = JSON.parse(ev.data);
          push({
            kind: r.success ? 'result' : 'error',
            text: r.success
              ? `compiled in ${r.duration_ms} ms`
              : (r.message || 'compile failed'),
            ts: Date.now(),
          });
          if (r.artifact) {
            resultURL = r.artifact;
            onArtifact?.(r.artifact);
          }
        } catch {
          push({ kind: 'result', text: ev.data, ts: Date.now() });
        }
        es.close();
        inFlight = false;
      });
      es.addEventListener('error', () => {
        push({ kind: 'error', text: 'stream interrupted', ts: Date.now() });
        es.close();
        inFlight = false;
      });
    } catch (e) {
      push({ kind: 'error', text: String(e), ts: Date.now() });
      inFlight = false;
    }
  }

  // Errors tab : filtered view over `lines` keeping only lines flagged
  // as errors PLUS any line containing a LaTeX-like ! Error / Warning
  // prefix. Pure derivation — no extra state to keep in sync.
  const errorLines = $derived(
    lines.filter(
      (l) =>
        l.kind === 'error' ||
        /^!|error|warning/i.test(l.text),
    ),
  );

  function clear() {
    lines = [];
    resultURL = null;
  }

  // Resize handle on top of the panel : drag up/down to grow/shrink.
  function startDrag(ev: MouseEvent) {
    ev.preventDefault();
    dragging = true;
    const startY = ev.clientY;
    const startH = height;
    function move(e: MouseEvent) {
      if (!dragging) return;
      const delta = startY - e.clientY;
      const next = Math.max(100, Math.min(600, startH + delta));
      height = next;
    }
    function up() {
      dragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try {
        localStorage.setItem('weft-loom-logpanel-height', String(height));
      } catch {
        /* localStorage full / denied */
      }
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  onDestroy(() => {
    dragging = false;
  });

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour12: false });
  }
</script>

{#if open}
  <div
    class="flex flex-col border-t border-base-300 bg-base-100 flex-none"
    style="height: {height}px"
  >
    <!-- Drag handle -->
    <div
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      class="h-1.5 cursor-row-resize bg-base-300 hover:bg-primary/50 transition-colors"
      class:bg-primary={dragging}
      onmousedown={startDrag}
    ></div>

    <!-- Tab bar + actions -->
    <div class="flex items-center px-2 py-1 border-b border-base-300 bg-base-200">
      <div role="tablist" class="tabs tabs-sm">
        <button
          role="tab"
          class="tab"
          class:tab-active={activeTab === 'log'}
          onclick={() => (activeTab = 'log')}
        >
          📜 Log
          <span class="ml-2 badge badge-xs badge-ghost">{lines.length}</span>
        </button>
        <button
          role="tab"
          class="tab"
          class:tab-active={activeTab === 'errors'}
          onclick={() => (activeTab = 'errors')}
        >
          ⚠ Errors
          <span class="ml-2 badge badge-xs" class:badge-error={errorLines.length > 0}>
            {errorLines.length}
          </span>
        </button>
      </div>
      <div class="ml-auto flex gap-1">
        <button
          class="btn btn-primary btn-xs"
          disabled={inFlight}
          onclick={run}
          title="Run compile ({language})"
        >
          {#if inFlight}
            <span class="loading loading-spinner loading-xs"></span>
          {:else}
            ▶
          {/if}
          Run
        </button>
        <button
          class="btn btn-ghost btn-xs"
          onclick={clear}
          title="Clear log"
        >
          🧹
        </button>
        {#if resultURL}
          <a class="btn btn-ghost btn-xs" href={resultURL} download title="Download artifact">
            ⬇
          </a>
        {/if}
        <button
          class="btn btn-ghost btn-xs"
          onclick={() => onCloseRequest?.()}
          title="Hide panel"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- Log content -->
    <div class="flex-1 overflow-auto p-2 font-mono text-xs bg-base-300/30">
      {#if activeTab === 'log'}
        {#if lines.length === 0}
          <div class="opacity-50 italic">
            No output yet. Click <span class="font-semibold">Run</span> to compile.
          </div>
        {/if}
        {#each lines as l}
          <div
            class="whitespace-pre-wrap leading-snug"
            class:text-success={l.kind === 'result'}
            class:text-error={l.kind === 'error'}
          >
            <span class="opacity-40">{fmtTime(l.ts)}</span>
            {l.text}
          </div>
        {/each}
      {:else}
        {#if errorLines.length === 0}
          <div class="opacity-50 italic">No errors.</div>
        {/if}
        {#each errorLines as l}
          <div class="whitespace-pre-wrap leading-snug text-error">
            <span class="opacity-40">{fmtTime(l.ts)}</span>
            {l.text}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}
