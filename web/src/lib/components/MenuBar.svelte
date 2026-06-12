<script lang="ts">
  // MenuBar — VSCode-style top menu bar. Sits above the Navbar at the
  // very top of the window. daisyUI `dropdown` for each menu : hover
  // OR click opens, ESC / outside-click closes. Items hand off to the
  // parent via callbacks rather than mutating state inline so the
  // menu stays presentational.
  //
  // Layout (left → right) :
  //   🧶 weft-loom · Sovereign Collaborative Edition │ File ... │ 🌐
  //
  // The logo sits on the far left at full size (20 px) on a base-100
  // background so the dark navy SVG strokes always stand out. The
  // tagline ("Sovereign Collaborative Edition") is i18n-driven via
  // `t('app.tagline')` ; the 🌐 locale switcher on the right lets
  // the user pick from EN / FR / ES / DE / ZH / IT / JA.

  import { i18n, localeNames, localeFlags, type Locale } from '../i18n.svelte';

  interface Props {
    onNewFile: () => void;
    onSwitchProject: () => void;
    onToggleExplorer: () => void;
    onToggleShell: () => void;
    onToggleDoctor: () => void;
    onToggleAI: () => void;
    onToggleChat: () => void;
    onToggleCollab: () => void;
    onCompile: () => void;
    onExportPDF: () => void;
    onRevisionMode: () => void;
    onOpenSettings: () => void;
  }

  let {
    onNewFile,
    onSwitchProject,
    onToggleExplorer,
    onToggleShell,
    onToggleDoctor,
    onToggleAI,
    onToggleChat,
    onToggleCollab,
    onCompile,
    onExportPDF,
    onRevisionMode,
    onOpenSettings,
  }: Props = $props();

  // Item type declared after `menus` above so the inline `as Item[]`
  // can reference it without forward-decl noise.

  // $derived so every locale switch rerenders the dropdowns. The
  // string keys map straight into `dict[locale]`.
  const menus = $derived(
    [
      {
        nameKey: 'menubar.file',
        items: [
          { kind: 'item', labelKey: 'menu.file.new', shortcut: 'Cmd+N', action: onNewFile },
          { kind: 'divider' },
          { kind: 'item', labelKey: 'menu.file.switchProject', shortcut: 'Cmd+P', action: onSwitchProject },
          { kind: 'divider' },
          { kind: 'item', labelKey: 'menu.file.settings', shortcut: 'Cmd+,', action: onOpenSettings },
        ] as Item[],
      },
      {
        nameKey: 'menubar.edit',
        items: [
          { kind: 'item', labelKey: 'menu.edit.undo', shortcut: 'Cmd+Z', action: () => document.execCommand('undo') },
          { kind: 'item', labelKey: 'menu.edit.redo', shortcut: 'Shift+Cmd+Z', action: () => document.execCommand('redo') },
        ] as Item[],
      },
      {
        nameKey: 'menubar.selection',
        items: [
          { kind: 'item', labelKey: 'menu.selection.toggleRevision', action: onRevisionMode },
        ] as Item[],
      },
      {
        nameKey: 'menubar.view',
        items: [
          { kind: 'item', labelKey: 'menu.view.toggleExplorer', shortcut: 'Cmd+B', action: onToggleExplorer },
          { kind: 'item', labelKey: 'menu.view.toggleShell', shortcut: 'Ctrl+`', action: onToggleShell },
          { kind: 'item', labelKey: 'menu.view.toggleDoctor', action: onToggleDoctor },
          { kind: 'divider' },
          { kind: 'item', labelKey: 'menu.view.toggleAI', action: onToggleAI },
          { kind: 'item', labelKey: 'menu.view.toggleChat', action: onToggleChat },
          { kind: 'item', labelKey: 'menu.view.toggleCollab', action: onToggleCollab },
        ] as Item[],
      },
      {
        nameKey: 'menubar.run',
        items: [
          { kind: 'item', labelKey: 'menu.run.compile', shortcut: 'Cmd+Enter', action: onCompile },
          { kind: 'item', labelKey: 'menu.run.exportPDF', action: onExportPDF },
        ] as Item[],
      },
      {
        nameKey: 'menubar.help',
        items: [
          {
            kind: 'item',
            labelKey: 'menu.help.about',
            action: () =>
              alert(
                'weft-loom — ' +
                  i18n.t('app.tagline') +
                  '\n\nCodeMirror + Yjs editor with sandboxed compile via Apptainer in workspace μVMs.',
              ),
          },
          {
            kind: 'item',
            labelKey: 'menu.help.github',
            action: () => window.open('https://github.com/openweft', '_blank'),
          },
        ] as Item[],
      },
    ],
  );

  type Item =
    | { kind: 'item'; labelKey: string; shortcut?: string; action: () => void }
    | { kind: 'divider' };
</script>

<div
  class="flex-none flex items-center bg-base-300 border-b border-base-200 h-8 px-1 text-xs select-none"
  aria-label="Menu bar"
>
  <!-- Logo block + visible tagline. Background uses base-100 so the
       dark navy SVG strokes always stand out, regardless of the
       active daisyUI theme. Tagline is i18n-driven ; switching the
       locale via the 🌐 picker (right) flips it in-place. -->
  <span
    class="flex items-center gap-2 px-2 py-0.5 mr-1 rounded bg-base-100"
    title={'weft-loom — ' + i18n.t('app.tagline')}
  >
    <img src="/favicon.svg" alt="weft-loom" width="20" height="20" class="block" />
    <span class="font-semibold">weft-loom</span>
  </span>

  {#each menus as menu}
    <div class="dropdown dropdown-bottom dropdown-start">
      <button
        type="button"
        tabindex="0"
        class="btn btn-xs btn-ghost px-2 normal-case font-normal"
      >{i18n.t(menu.nameKey)}</button>
      <ul
        class="dropdown-content menu z-50 p-1 shadow-lg bg-base-100 rounded-md w-56 border border-base-300 mt-0.5"
      >
        {#each menu.items as item}
          {#if item.kind === 'divider'}
            <li class="border-t border-base-300 my-1"></li>
          {:else}
            <li>
              <button
                type="button"
                class="flex justify-between"
                onclick={() => {
                  item.action();
                  (document.activeElement as HTMLElement | null)?.blur();
                }}
              >
                <span>{i18n.t(item.labelKey)}</span>
                {#if item.shortcut}
                  <span class="text-xs opacity-60 font-mono">{item.shortcut}</span>
                {/if}
              </button>
            </li>
          {/if}
        {/each}
      </ul>
    </div>
  {/each}

  <span class="ml-auto"></span>
  <!-- Locale switcher : daisyUI dropdown listing the 7 shipped langs.
       Sticking it in the MenuBar (vs Status bar) matches VSCode where
       Language defaults sit under Help — discoverable but unobtrusive. -->
  <div class="dropdown dropdown-bottom dropdown-end">
    <button
      type="button"
      tabindex="0"
      class="btn btn-xs btn-ghost px-2 normal-case"
      title="Language · {localeNames[i18n.current]}"
      aria-label="Language picker"
    >{localeFlags[i18n.current]} {i18n.current.toUpperCase()}</button>
    <ul class="dropdown-content menu z-50 p-1 shadow-lg bg-base-100 rounded-md w-44 border border-base-300 mt-0.5">
      {#each Object.entries(localeNames) as [code, name]}
        <li>
          <button
            type="button"
            class="flex items-center gap-2"
            class:menu-active={i18n.current === code}
            onclick={() => {
              i18n.set(code as Locale);
              (document.activeElement as HTMLElement | null)?.blur();
            }}
          >
            <span class="text-base">{localeFlags[code as Locale]}</span>
            <span class="flex-1 text-left">{name}</span>
            <span class="text-xs opacity-50 font-mono">{code}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
</div>
