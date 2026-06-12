<script lang="ts">
  // ShellTabs — VSCode-style multi-terminal harness. Holds N session
  // instances of ShellPanel ; one is visible at a time, the rest are
  // hidden via CSS (NOT unmounted) so their xterm + WebSocket stays
  // alive across tab switches.
  //
  // The sub-tab strip on the right of the panel matches VSCode's
  // "terminal sessions" list :
  //   • Terminal 1
  //   • Terminal 2       ← active
  //   • Terminal 3
  //   [ + ]              ← new terminal
  //
  // Each session can be renamed by double-click ; the × button on
  // each row closes the matching ShellPanel (deallocates xterm + WS).

  import ShellPanel from './ShellPanel.svelte';
  import { iconForPath } from '../theme';
  import ContextMenu, { type ContextEntry } from './ContextMenu.svelte';

  // Right-click context menu — replaces the per-row ✕ button so the
  // user can't accidentally kill a long-running session with one
  // mis-click. Bind:this exposes imperative open/close.
  let rowCtx: { open: (x: number, y: number, items: ContextEntry[]) => void; close: () => void } | undefined = $state();

  function openSessionContext(ev: MouseEvent, session: Session) {
    ev.preventDefault();
    ev.stopPropagation();
    const items: ContextEntry[] = [
      { kind: 'item', label: 'Activate', action: () => (activeId = session.id) },
      { kind: 'item', label: 'Rename…', shortcut: 'dbl-click', action: () => renameTerminal(session.id) },
      { kind: 'divider' },
      {
        kind: 'item',
        label: 'Close terminal',
        danger: true,
        action: () => closeTerminal(session.id),
      },
    ];
    rowCtx?.open(ev.clientX, ev.clientY, items);
  }

  // Track icon-theme changes so the shell glyph re-renders when the
  // user picks a different file-icon theme.
  let iconBump = $state(0);
  $effect(() => {
    const h = () => (iconBump++);
    window.addEventListener('weft-loom-icon-theme-change', h);
    return () => window.removeEventListener('weft-loom-icon-theme-change', h);
  });
  // Shell glyph follows the active file-icon theme (sh extension).
  // The iconBump >= 0 read introduces the reactive dependency
  // without using the comma operator (whose unused-LHS warning
  // svelte-check now flags).
  const shellIcon = $derived(iconBump >= 0 ? iconForPath('foo.sh') : '');

  interface Session {
    id: number;
    label: string;
    open: boolean;
  }

  interface Props {
    project: string;
    open: boolean;
    onCloseRequest: () => void;
  }

  let { project, open = $bindable(), onCloseRequest }: Props = $props();

  // Auto-increment so closed-then-reopened slots get fresh IDs ;
  // the WS subject the loom-server picks is keyed by the session id
  // implicitly (a fresh WS = fresh PTY).
  let nextId = 1;
  let sessions = $state<Session[]>([{ id: 0, label: 'bash 1', open: true }]);
  let activeId = $state<number>(0);

  function newTerminal() {
    const id = nextId++;
    sessions = [...sessions, { id, label: 'bash ' + (sessions.length + 1), open: true }];
    activeId = id;
  }

  function closeTerminal(id: number) {
    const i = sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    sessions = sessions.filter((s) => s.id !== id);
    if (activeId === id && sessions.length > 0) {
      activeId = sessions[Math.max(0, i - 1)].id;
    }
    if (sessions.length === 0) {
      // Last terminal closed → collapse the bottom panel back. The
      // user clicks the activity-bar 🖥 icon again to spawn a new
      // session ; we don't auto-respawn (that would loop forever
      // if the WS keeps failing).
      onCloseRequest();
    }
  }

  function renameTerminal(id: number) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    const name = prompt('Rename terminal', s.label);
    if (name && name.trim()) {
      sessions = sessions.map((x) => (x.id === id ? { ...x, label: name.trim() } : x));
    }
  }
</script>

<!-- Shell area : sub-tab strip on the right + active terminal body
     on the left. The flex split (1fr / 8rem) mirrors VSCode's split
     where the body keeps the breathing room + the right strip is
     barely wider than the longest "Terminal N" label. -->
<div class="flex h-full bg-base-100" class:hidden={!open}>
  <div class="flex-1 overflow-hidden relative">
    {#each sessions as session (session.id)}
      <div
        class="absolute inset-0 overflow-hidden"
        class:hidden={session.id !== activeId}
      >
        <ShellPanel
          {project}
          bind:open={session.open}
        />
      </div>
    {/each}
    {#if sessions.length === 0}
      <div class="h-full flex items-center justify-center text-xs opacity-60">
        No terminals open — click + to start a session.
      </div>
    {/if}
  </div>

  <!-- Sessions strip — right-anchored, narrow. -->
  <aside
    class="flex-none w-36 border-l border-base-300 bg-base-200/40 flex flex-col text-xs"
    aria-label="Terminal sessions"
  >
    <header class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200">
      <span class="opacity-70 font-semibold">Terminals</span>
      <button
        type="button"
        class="ml-auto btn btn-ghost btn-xs"
        onclick={newTerminal}
        title="New terminal"
        aria-label="New terminal"
      >+</button>
    </header>
    <ul class="flex-1 overflow-auto py-1">
      {#each sessions as session (session.id)}
        <li
          class="group flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-base-200"
          class:bg-base-300={session.id === activeId}
        >
          <!-- Single button : click activates, dbl-click renames,
               right-click pops the context menu (Close terminal +
               Rename). The misclick-prone ✕ is gone. -->
          <button
            type="button"
            class="flex-1 text-left truncate font-mono"
            ondblclick={() => renameTerminal(session.id)}
            onclick={() => (activeId = session.id)}
            oncontextmenu={(ev) => openSessionContext(ev, session)}
            title={'Right-click for actions · double-click to rename · ' + session.label}
          >{shellIcon} {session.label}</button>
        </li>
      {/each}
    </ul>
    <ContextMenu bind:this={rowCtx} />
  </aside>
</div>
