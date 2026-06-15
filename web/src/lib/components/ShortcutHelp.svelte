<script lang="ts">
  // ShortcutHelp — searchable cheat sheet of every keybinding wired
  // across the SPA. Opened with `Cmd+/` (matches VSCode's keymap
  // help shortcut). Closed via Escape, click-outside, or the × button.
  //
  // Every entry is maintained here as the SINGLE SOURCE OF TRUTH
  // for documentation purposes ; the actual handlers live where
  // they fire (Editor.svelte, App.svelte, BottomPanel, etc.) and
  // are referenced by the `where` field so a future audit can grep
  // for stale entries.
  //
  // Beats Overleaf : Overleaf's keymap reference is buried in their
  // help docs. This is an in-app modal one keystroke away.

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open = $bindable(), onClose }: Props = $props();

  // The {label, keys, where} triplet : label = human description,
  // keys = the shortcut as the user types it (Mod is Cmd on
  // darwin, Ctrl elsewhere — we render Cmd in the UI since the
  // majority of users are on darwin and the Editor accepts both
  // via CodeMirror's Mod- prefix), where = which file owns the
  // binding (search target only).
  interface Entry {
    label: string;
    keys: string;
    where: string;
  }
  interface Section {
    title: string;
    entries: Entry[];
  }

  const SECTIONS: Section[] = [
    {
      title: 'File',
      entries: [
        { label: 'New file…',          keys: 'Cmd+N',         where: 'MenuBar' },
        { label: 'Go to file…',        keys: 'Cmd+P',         where: 'App.svelte' },
        { label: 'Save current file',  keys: 'Cmd+S',         where: 'App.svelte' },
        { label: 'Settings…',          keys: 'Cmd+,',         where: 'App.svelte' },
        { label: 'Command palette',    keys: 'Cmd+Shift+P',   where: 'App.svelte' },
      ],
    },
    {
      title: 'View',
      entries: [
        { label: 'Toggle file explorer',  keys: 'Cmd+B',        where: 'MenuBar' },
        { label: 'Toggle shell drawer',   keys: 'Ctrl+`',       where: 'MenuBar' },
        { label: 'Keyboard shortcut help', keys: 'Cmd+/',       where: 'this dialog' },
      ],
    },
    {
      title: 'Edit',
      entries: [
        { label: 'Undo',                   keys: 'Cmd+Z',           where: 'MenuBar' },
        { label: 'Redo',                   keys: 'Cmd+Shift+Z',     where: 'MenuBar' },
        { label: 'Toggle line comment',    keys: 'Cmd+/',           where: 'Editor (in focus)' },
        { label: 'Toggle block comment',   keys: 'Cmd+Shift+/',     where: 'Editor' },
        { label: 'Indent',                 keys: 'Cmd+]',           where: 'Editor' },
        { label: 'Outdent',                keys: 'Cmd+[',           where: 'Editor' },
        { label: 'Select next occurrence', keys: 'Cmd+D',           where: 'Editor' },
        { label: 'Place additional cursor', keys: 'Alt+click',      where: 'Editor (multi-cursor)' },
        { label: 'Rectangular selection',  keys: 'Alt+drag',        where: 'Editor (multi-cursor)' },
      ],
    },
    {
      title: 'LaTeX',
      entries: [
        { label: 'Bold',          keys: 'Cmd+B',     where: 'Editor (LaTeX file)' },
        { label: 'Italic',        keys: 'Cmd+I',     where: 'Editor (LaTeX file)' },
        { label: 'Inline math',   keys: 'Cmd+M',     where: 'Editor (LaTeX file)' },
        { label: 'Insert snippet (Tab to cycle stops)', keys: 'Enter on suggestion', where: 'Editor autocomplete' },
        { label: 'Run a citation completion (\\cite{)', keys: 'auto', where: 'Editor autocomplete' },
      ],
    },
    {
      title: 'Navigation',
      entries: [
        { label: 'Go to definition',  keys: 'F12',           where: 'Editor + LSP' },
        { label: 'Go to definition',  keys: 'Cmd+Alt+D',     where: 'Editor + LSP' },
        { label: 'Jump to comment',   keys: 'click anchor',   where: 'CommentsPanel' },
        { label: 'SyncTeX forward',   keys: 'Cmd+J',         where: 'Editor (LaTeX file)' },
        { label: 'SyncTeX backward',  keys: 'click PDF',     where: 'PdfViewer' },
      ],
    },
    {
      title: 'Compile',
      entries: [
        { label: 'Compile (LaTeX / Marp)', keys: 'Cmd+Enter', where: 'MenuBar / BottomPanel' },
      ],
    },
    {
      title: 'Dialog',
      entries: [
        { label: 'Close any dialog',  keys: 'Escape', where: 'global' },
      ],
    },
  ];

  let filter = $state('');
  const matches = $derived.by(() => {
    if (!filter.trim()) return SECTIONS;
    const f = filter.toLowerCase();
    return SECTIONS
      .map((s) => ({
        title: s.title,
        entries: s.entries.filter((e) =>
          e.label.toLowerCase().includes(f)
          || e.keys.toLowerCase().includes(f)
          || s.title.toLowerCase().includes(f),
        ),
      }))
      .filter((s) => s.entries.length > 0);
  });

  function onKey(ev: KeyboardEvent) {
    if (!open) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
    }
  }

  // Render shortcut as <kbd>+</kbd> chips. Splits on '+' but keeps
  // 'Ctrl+`' and 'Shift+Cmd+Z' intact ; the chip styling is in CSS.
  function chips(keys: string): string[] {
    return keys.split('+').map((k) => k.trim()).filter((k) => k.length > 0);
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="shortcut-help-backdrop" onclick={onClose} role="button" tabindex="-1" aria-label="Close" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClose(); }}></div>
  <div
    class="shortcut-help-modal card bg-base-100 shadow-2xl border border-base-300"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shortcut-help-title"
    data-testid="shortcut-help"
  >
    <div class="card-body p-4">
      <div class="flex items-center justify-between mb-3">
        <h2 id="shortcut-help-title" class="text-base font-semibold">Keyboard shortcuts</h2>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          onclick={onClose}
          aria-label="Close"
        >×</button>
      </div>
      <input
        type="search"
        class="input input-bordered input-sm w-full mb-3"
        placeholder="Search shortcuts…"
        autofocus
        bind:value={filter}
        data-testid="shortcut-help-filter"
      />
      <div class="shortcut-help-body">
        {#each matches as section (section.title)}
          <section class="shortcut-help-section">
            <h3 class="text-xs font-semibold uppercase opacity-60 mt-1">{section.title}</h3>
            <ul>
              {#each section.entries as e (e.label + e.keys)}
                <li class="shortcut-help-row">
                  <span class="shortcut-help-label">{e.label}</span>
                  <span class="shortcut-help-keys" data-testid="shortcut-help-keys">
                    {#each chips(e.keys) as ch, i (i)}
                      <kbd class="kbd kbd-sm">{ch}</kbd>{#if i < chips(e.keys).length - 1}<span class="shortcut-help-plus">+</span>{/if}
                    {/each}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
        {#if matches.length === 0}
          <div class="opacity-50 text-xs p-2 text-center">
            No shortcut matches "{filter}".
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .shortcut-help-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 80;
    cursor: pointer;
  }
  .shortcut-help-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(90vw, 38rem);
    max-height: 80vh;
    z-index: 81;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .shortcut-help-modal :global(.card-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .shortcut-help-body {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .shortcut-help-section ul {
    list-style: none;
    padding: 0;
    margin: 0.2rem 0 0.4rem 0;
  }
  .shortcut-help-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0.4rem;
    border-radius: 0.3rem;
    font-size: 0.8rem;
  }
  .shortcut-help-row:hover {
    background: rgba(0, 100, 200, 0.06);
  }
  .shortcut-help-label {
    flex: 1;
    margin-right: 0.6rem;
  }
  .shortcut-help-keys {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.7rem;
    white-space: nowrap;
  }
  .shortcut-help-plus {
    opacity: 0.4;
    margin: 0 0.05rem;
  }
</style>
