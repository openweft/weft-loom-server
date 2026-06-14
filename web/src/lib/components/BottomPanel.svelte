<script lang="ts">
  // BottomPanel — unified bottom drawer that hosts the compile-log
  // tab + the shell-terminal tab + future bottom-aligned tabs. Owns
  // the shared height + drag handle so the two children don't fight
  // over the same vertical space, and remembers which tab was last
  // active across reloads.
  import { onMount } from 'svelte';
  import CompileLogPanel from './CompileLogPanel.svelte';
  import ShellTabs from './ShellTabs.svelte';
  import DoctorPanel from './DoctorPanel.svelte';
  import HistoryPanel from './HistoryPanel.svelte';

  type Tab = 'log' | 'shell' | 'doctor' | 'history';

  interface Props {
    project: string;
    language: string;
    // entry is the currently-active file path within the project ;
    // we thread it into the compile request so the workspace μVM
    // runs the user's actual file, not a hardcoded `main.<ext>`.
    // Empty string falls back to per-language defaults.
    entry?: string;
    open: boolean;
    // activeTab is bindable so the parent (App.svelte) can switch
    // tabs in response to navbar clicks ("🖥 Shell" button) — used
    // to flow into existing without a forced remount.
    activeTab?: Tab;
    onArtifact?: (url: string) => void;
    onJump?: (line: number, file: string | null) => void;
    onDiagnostic?: (d: { severity: 'error' | 'warning'; file: string | null; line: number | null; message: string }) => void;
    onCompileReset?: () => void;
    onCloseRequest: () => void;
  }

  let { project, language, entry = '', open = $bindable(), activeTab = $bindable<Tab>('shell'), onArtifact, onJump, onDiagnostic, onCompileReset, onCloseRequest }: Props = $props();
  // Each child still renders its own body, but we suppress their
  // headers + drag handles by hiding them with class flags. Their
  // open prop is true so the body mounts ; their onCloseRequest
  // forwards to BottomPanel.
  let logChildOpen = $state(true);
  let shellChildOpen = $state(false);
  let doctorChildOpen = $state(false);
  let historyChildOpen = $state(false);
  let height = $state<number>(280);
  let dragging = $state(false);

  onMount(() => {
    const h = localStorage.getItem('weft-loom-bottom-height');
    if (h) {
      const n = Number(h);
      if (!Number.isNaN(n) && n >= 120 && n <= 800) height = n;
    }
  });

  // Reactive sync : whenever activeTab changes (parent updated it,
  // or a tab strip click below), flip the per-child open prop +
  // persist to localStorage. Replaces the onMount one-shot read.
  $effect(() => {
    logChildOpen = activeTab === 'log';
    shellChildOpen = activeTab === 'shell';
    doctorChildOpen = activeTab === 'doctor';
    historyChildOpen = activeTab === 'history';
    try { localStorage.setItem('weft-loom-bottom-tab-v2', activeTab); } catch {}
  });

  function pickTab(t: Tab) {
    activeTab = t;
  }

  function startDrag(ev: MouseEvent) {
    ev.preventDefault();
    dragging = true;
    const startY = ev.clientY;
    const startH = height;
    function move(e: MouseEvent) {
      const next = Math.max(120, Math.min(800, startH + (startY - e.clientY)));
      height = next;
    }
    function up() {
      dragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-bottom-height', String(height)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
</script>

{#if open}
  <!-- Mobile (< md) : the bottom drawer takes the full available
       height of the column so the user actually sees the shell /
       compile log on a phone screen — a 280 px drawer is most of
       the viewport but still feels cramped, and resizing via the
       drag handle is fiddly on touch. The `.weft-bottom-panel-mobile-full`
       class drops the inline px height and switches to flex-1
       under (max-width: 767px) ; desktop keeps the resizable px
       height untouched. -->
  <div
    class="flex flex-col border-t border-base-300 bg-base-100 flex-none weft-bottom-panel-mobile-full"
    style="height: {height}px"
  >
    <!-- Shared drag handle — desktop only ; on mobile the drawer
         takes the full column height so resizing is moot AND the
         1.5 px strip is a fiddly touch target. -->
    <div
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      class="hidden md:block h-1.5 cursor-row-resize bg-base-300 hover:bg-primary/50 transition-colors"
      class:bg-primary={dragging}
      onmousedown={startDrag}
    ></div>

    <!-- Tab strip — Terminal first (most-used), Compile log second,
         Doctor (diagnostics) last. Matches the user's mental model :
         shell is the everyday tool ; compile is per-language. -->
    <div role="tablist" class="flex items-stretch h-9 border-b border-base-300 bg-base-200">
      <button
        role="tab"
        class="px-4 h-9 text-xs font-semibold hover:bg-base-100 flex items-center gap-1"
        class:border-b-2={activeTab === 'shell'}
        class:border-b-primary={activeTab === 'shell'}
        class:bg-base-100={activeTab === 'shell'}
        onclick={() => pickTab('shell')}
      ><svg viewBox="0 0 24 24" width="14" height="14" class="" fill="currentColor" aria-hidden="true">
        <!-- codicon `terminal`. -->
        <path d="M18.75 1.5H5.25C3.1815 1.5 1.5 3.183 1.5 5.25V18.75C1.5 20.8185 3.1815 22.5 5.25 22.5H18.75C20.8185 22.5 22.5 20.8185 22.5 18.75V5.25C22.5 3.183 20.8185 1.5 18.75 1.5ZM21 18.75C21 19.9905 19.9905 21 18.75 21H5.25C4.0095 21 3 19.9905 3 18.75V5.25C3 4.0095 4.0095 3 5.25 3H18.75C19.9905 3 21 4.0095 21 5.25V18.75ZM10.281 13.281L5.781 17.781C5.634 17.928 5.442 18 5.25 18C5.058 18 4.866 17.9265 4.719 17.781C4.4265 17.4885 4.4265 17.013 4.719 16.7205L8.688 12.7515L4.719 8.7825C4.4265 8.49 4.4265 8.0145 4.719 7.722C5.0115 7.4295 5.487 7.4295 5.7795 7.722L10.2795 12.222C10.572 12.5145 10.572 12.99 10.2795 13.2825L10.281 13.281ZM19.5 17.25C19.5 17.664 19.164 18 18.75 18H11.25C10.836 18 10.5 17.664 10.5 17.25C10.5 16.836 10.836 16.5 11.25 16.5H18.75C19.164 16.5 19.5 16.836 19.5 17.25Z"/>
      </svg>Shell</button>
      <button
        role="tab"
        class="px-4 h-9 text-xs font-semibold hover:bg-base-100 flex items-center gap-1"
        class:border-b-2={activeTab === 'log'}
        class:border-b-primary={activeTab === 'log'}
        class:bg-base-100={activeTab === 'log'}
        onclick={() => pickTab('log')}
      ><svg viewBox="0 0 16 16" width="14" height="14" class="" fill="currentColor" aria-hidden="true">
        <!-- codicon `output` : two horizontal log lines in a box. -->
        <path d="M14 4H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zM2 13V5h12v8H2zm10-2h-1v-1h1v1zm0-2h-1V8h1v1zm0-2h-1V6h1v1z"/>
      </svg>Compile log</button>
      <button
        role="tab"
        class="px-4 h-9 text-xs font-semibold hover:bg-base-100 flex items-center gap-1"
        class:border-b-2={activeTab === 'doctor'}
        class:border-b-primary={activeTab === 'doctor'}
        class:bg-base-100={activeTab === 'doctor'}
        onclick={() => pickTab('doctor')}
      ><svg viewBox="0 0 16 16" width="14" height="14" class="" fill="currentColor" aria-hidden="true">
        <!-- codicon `pulse` (ECG line). -->
        <path d="M5.76 2.5C5.98.5 6.17 2.65 6.23 2.86l2.29 8.33 1.75-5.84c.06-.2.24-.34.45-.36.21 0 .41.13.49.32l1.12 2.69H14a.5.5 0 0 1 0 1h-2c-.2 0-.38-.12-.46-.31l-.71-1.7-1.85 6.16c-.06.21-.26.36-.48.36-.22 0-.42-.15-.48-.37l-2.3-8.37-1.24 3.89a.5.5 0 0 1-.48.35H2a.5.5 0 0 1 0-1h1.63L5.27 2.85a.5.5 0 0 1 .48-.35z"/>
      </svg>Doctor</button>
      <button
        role="tab"
        class="px-4 h-9 text-xs font-semibold hover:bg-base-100 flex items-center gap-1"
        class:border-b-2={activeTab === 'history'}
        class:border-b-primary={activeTab === 'history'}
        class:bg-base-100={activeTab === 'history'}
        onclick={() => pickTab('history')}
      ><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <!-- codicon `history` : clock arrow. -->
        <path d="M13.507 12.324a7 7 0 0 0-.785-8.435 7.998 7.998 0 0 0-8.92-1.654 8 8 0 0 0-2.435 1.59A8 8 0 0 0 0 9.732V14h4.235l.027.001A8 8 0 0 0 13.507 12.324zM8 14a6 6 0 1 1 0-12 6 6 0 0 1 0 12zM8.5 3v4.299l3.46 1.998-.499.866L7.5 7.876V3h1z"/>
      </svg>History</button>
      <button
        class="btn btn-ghost btn-xs ml-auto mr-2 self-center"
        onclick={onCloseRequest}
        title="Hide panel"
        aria-label="Close"
      >✕</button>
    </div>

    <!-- Tab bodies -->
    <div class="flex-1 overflow-hidden flex flex-col">
      <div class="flex-1 overflow-hidden" class:hidden={!logChildOpen}>
        <CompileLogPanel
          {project}
          {language}
          {entry}
          bind:open={logChildOpen}
          {onArtifact}
          {onJump}
          {onDiagnostic}
          {onCompileReset}
          onCloseRequest={onCloseRequest}
        />
      </div>
      <div class="flex-1 overflow-hidden" class:hidden={!shellChildOpen}>
        <ShellTabs
          {project}
          bind:open={shellChildOpen}
          onCloseRequest={onCloseRequest}
        />
      </div>
      <div class="flex-1 overflow-hidden" class:hidden={!doctorChildOpen}>
        <DoctorPanel {project} bind:open={doctorChildOpen} />
      </div>
      <div class="flex-1 overflow-hidden" class:hidden={!historyChildOpen}>
        <HistoryPanel {project} file={entry} />
      </div>
    </div>
  </div>
{/if}
