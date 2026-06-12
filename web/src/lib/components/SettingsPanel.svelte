<script lang="ts">
  // SettingsPanel — VSCode-style preferences modal. Two top-level
  // sections :
  //
  //   1. Editor    : font · tab size · line numbers · wrap · bracket
  //                  matching · autocomplete · theme switcher
  //   2. Themes    : drop a VSCode `.json` color theme + activate it
  //   3. Locale    : same 7 langs as the MenuBar 🌐 switcher (mirror
  //                  here so the panel is the one-stop preferences hub)
  //
  // Persists to localStorage via the settings.svelte.ts store ; every
  // component that consumes `settings.current.X` reactively rerenders.

  import { settings, vscodeThemes, compileCommands, type VSCodeTheme } from '../settings.svelte';

  // Compile-command catalogue — the rows users can override. Order
  // matches the lang-suite test matrix : LaTeX + Markdown first
  // (PDF artifact languages), then the scripting + system langs.
  // Placeholder column shows the server's built-in command so the
  // user sees what they're overriding.
  const COMPILE_LANGS: Array<{ id: string; label: string; placeholder: string }> = [
    { id: 'latex',    label: 'LaTeX',    placeholder: 'pdflatex -interaction=nonstopmode -halt-on-error main.tex' },
    { id: 'markdown', label: 'Markdown', placeholder: 'marp --pdf --allow-local-files -o output.pdf <entry>' },
    { id: 'golang',   label: 'Go',       placeholder: 'sh -c "if [ -f go.mod ]; then go run ./...; else go run <entry>; fi"' },
    { id: 'python',   label: 'Python',   placeholder: 'python3 <entry>' },
    { id: 'rust',     label: 'Rust',     placeholder: 'sh -c "if [ -f Cargo.toml ]; then cargo run; else rustc <entry> -o /tmp/a.out && /tmp/a.out; fi"' },
    { id: 'node',     label: 'Node',     placeholder: 'node <entry>' },
    { id: 'cpp',      label: 'C++',      placeholder: 'sh -c "g++ <entry> -std=c++20 -o /tmp/a.out && /tmp/a.out"' },
    { id: 'c',        label: 'C',        placeholder: 'sh -c "cc <entry> -o /tmp/a.out && /tmp/a.out"' },
    { id: 'shell',    label: 'Shell',    placeholder: 'sh <entry>' },
    { id: 'ruby',     label: 'Ruby',     placeholder: 'ruby <entry>' },
    { id: 'perl',     label: 'Perl',     placeholder: 'perl <entry>' },
    { id: 'zig',      label: 'Zig',      placeholder: 'zig run <entry>' },
  ];
  import { i18n, localeNames, localeFlags, type Locale } from '../i18n.svelte';
  import { loadTheme, applyTheme, type Theme } from '../theme';
  import { BUILTIN_THEMES } from '../builtinThemes.svelte';
  import { ICON_THEMES, loadIconTheme, saveIconTheme, type IconThemeName } from '../iconThemes';

  const AVAILABLE_THEMES: Theme[] = ['light', 'dark', 'auto'];

  // File-type icon theme — combo below the editor color theme.
  // saveIconTheme dispatches a window event so the FileExplorer's
  // iconForPath() callers pick the new glyphs on the next render
  // (Svelte's runes track `activeIconTheme` here ; the explorer
  // listens via the same `weft-loom-icon-theme-change` event).
  let activeIconTheme = $state<IconThemeName>(loadIconTheme());
  function setIconTheme(name: IconThemeName) {
    activeIconTheme = name;
    saveIconTheme(name);
  }

  // Built-in editor themes the user can pick from a dropdown without
  // having to upload a JSON. The first entry ("Default (daisyUI)")
  // unloads any active VSCode theme so the editor falls back to the
  // app's daisyUI palette.
  function pickBuiltin(name: string) {
    if (name === 'Default (daisyUI)') {
      vscodeThemes.setActive(null);
      return;
    }
    const t = BUILTIN_THEMES.find((b) => b.name === name);
    if (!t) return;
    vscodeThemes.add(t);
    vscodeThemes.setActive(t.name);
  }

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open = $bindable(), onClose }: Props = $props();

  // Bind daisyUI theme via the existing theme.ts helpers so we don't
  // diverge from ThemeSwitcher's behaviour.
  let daisyTheme = $state<Theme>(loadTheme());

  function setDaisyTheme(t: Theme) {
    daisyTheme = t;
    applyTheme(t);
    settings.set('theme', t);
  }

  // Local copies for binding ; sync back to the store on change so
  // every editor component picks them up without two-way binding
  // gymnastics with the class-state singleton.
  function bindFont<K extends 'size' | 'lineHeight'>(key: K) {
    return {
      get: () => settings.current.font[key],
      set: (v: number) => settings.setFont({ [key]: v } as Partial<typeof settings.current.font>),
    };
  }
  function bind<K extends 'tabSize' | 'insertSpaces' | 'lineNumbers' | 'wordWrap' | 'bracketMatching' | 'autocomplete' | 'minimap'>(key: K) {
    return {
      get: () => settings.current[key],
      set: (v: typeof settings.current[K]) => settings.set(key, v),
    };
  }

  // VSCode theme import : <input type=file> + FileReader → JSON parse.
  // Tolerates the two common VSCode theme shapes : the bare theme
  // object OR the `{name, themes:[…]}` extension wrapper.
  let importErr = $state<string | null>(null);
  async function onPickThemeFile(ev: Event) {
    importErr = null;
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const theme: VSCodeTheme = Array.isArray(parsed?.themes) ? parsed.themes[0] : parsed;
      if (!theme || typeof theme !== 'object' || !theme.colors) {
        throw new Error('not a VSCode color theme (no `colors` field)');
      }
      if (!theme.name) theme.name = file.name.replace(/\.json$/i, '');
      vscodeThemes.add(theme);
      vscodeThemes.setActive(theme.name);
    } catch (e) {
      importErr = String(e);
    } finally {
      input.value = '';
    }
  }

  // Drag state — the modal-box is offset from its centered position
  // via an inline transform that the header's mousedown handler
  // updates as the cursor moves. The offset persists in localStorage
  // so reopening the panel lands at the user's previous spot.
  let dragOffsetX = $state<number>(0);
  let dragOffsetY = $state<number>(0);
  let dragging = $state(false);
  // Load saved position on mount.
  try {
    const sx = Number(localStorage.getItem('weft-loom-settings-x'));
    const sy = Number(localStorage.getItem('weft-loom-settings-y'));
    if (!Number.isNaN(sx)) dragOffsetX = sx;
    if (!Number.isNaN(sy)) dragOffsetY = sy;
  } catch {}

  function startHeaderDrag(ev: MouseEvent) {
    // Don't hijack clicks that landed on a button inside the header.
    if ((ev.target as HTMLElement).closest('button, input, a')) return;
    ev.preventDefault();
    dragging = true;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startOX = dragOffsetX;
    const startOY = dragOffsetY;
    function move(e: MouseEvent) {
      dragOffsetX = startOX + (e.clientX - startX);
      dragOffsetY = startOY + (e.clientY - startY);
    }
    function up() {
      dragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try {
        localStorage.setItem('weft-loom-settings-x', String(dragOffsetX));
        localStorage.setItem('weft-loom-settings-y', String(dragOffsetY));
      } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
</script>

<dialog class="modal" class:modal-open={open}>
  <div
    class="modal-box max-w-3xl p-0 overflow-hidden border border-base-300"
    style="transform: translate({dragOffsetX}px, {dragOffsetY}px); {dragging ? 'transition: none;' : ''}"
  >
    <!-- Title bar : VSCode-style header with a contrasting background
         + bottom border so the user can SEE where to grab. Drag any
         non-button area to move the modal ; position persists in
         localStorage so the panel reopens where the user last left
         it. The grip dots on the left signal the affordance. -->
    <h3
      class="text-base font-semibold flex items-center gap-2 select-none px-4 py-2 bg-base-200 border-b border-base-300"
      class:cursor-grabbing={dragging}
      class:cursor-grab={!dragging}
      onmousedown={startHeaderDrag}
    >
      <span class="opacity-30 font-mono text-xs" title="Drag to move">⋮⋮</span>
      <span>⚙ Settings</span>
      <span class="text-xs opacity-50 font-normal">{i18n.t('app.tagline')}</span>
      <button class="ml-auto btn btn-ghost btn-sm" onclick={() => { open = false; onClose(); }} aria-label="Close">✕</button>
    </h3>

    <div class="p-5 overflow-y-auto max-h-[70vh]">
    <!-- Editor section -->
    <section class="mb-4">
      <h4 class="font-semibold text-sm mb-2">Editor</h4>
      <div class="grid grid-cols-2 gap-3">
        <label class="form-control">
          <span class="label-text text-xs uppercase opacity-70 mb-1">Font family</span>
          <input
            class="input input-bordered input-sm font-mono"
            value={settings.current.font.family}
            oninput={(e) => settings.setFont({ family: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label class="form-control">
          <span class="label-text text-xs uppercase opacity-70 mb-1">Font size · {settings.current.font.size}px</span>
          <input
            type="range"
            class="range range-xs"
            min="10"
            max="22"
            value={settings.current.font.size}
            oninput={(e) => settings.setFont({ size: Number((e.target as HTMLInputElement).value) })}
          />
        </label>
        <label class="form-control">
          <span class="label-text text-xs uppercase opacity-70 mb-1">Line height · {settings.current.font.lineHeight.toFixed(2)}</span>
          <input
            type="range"
            class="range range-xs"
            min="1.0"
            max="2.0"
            step="0.05"
            value={settings.current.font.lineHeight}
            oninput={(e) => settings.setFont({ lineHeight: Number((e.target as HTMLInputElement).value) })}
          />
        </label>
        <label class="form-control">
          <span class="label-text text-xs uppercase opacity-70 mb-1">Tab size</span>
          <input
            type="number"
            min="1"
            max="8"
            class="input input-bordered input-sm font-mono"
            value={settings.current.tabSize}
            oninput={(e) => settings.set('tabSize', Number((e.target as HTMLInputElement).value))}
          />
        </label>
        <label class="form-control col-span-2">
          <div class="flex items-center gap-4 flex-wrap">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={settings.current.insertSpaces}
                onchange={(e) => settings.set('insertSpaces', (e.target as HTMLInputElement).checked)}
              />
              <span class="text-sm">Insert spaces on Tab</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={settings.current.lineNumbers}
                onchange={(e) => settings.set('lineNumbers', (e.target as HTMLInputElement).checked)}
              />
              <span class="text-sm">Line numbers</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={settings.current.wordWrap}
                onchange={(e) => settings.set('wordWrap', (e.target as HTMLInputElement).checked)}
              />
              <span class="text-sm">Word wrap</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={settings.current.minimap}
                onchange={(e) => settings.set('minimap', (e.target as HTMLInputElement).checked)}
              />
              <span class="text-sm">Minimap</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={settings.current.bracketMatching}
                onchange={(e) => settings.set('bracketMatching', (e.target as HTMLInputElement).checked)}
              />
              <span class="text-sm">Bracket matching</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={settings.current.autocomplete}
                onchange={(e) => settings.set('autocomplete', (e.target as HTMLInputElement).checked)}
              />
              <span class="text-sm">Autocomplete</span>
            </label>
          </div>
        </label>
      </div>
    </section>

    <!-- daisyUI theme -->
    <section class="mb-4">
      <h4 class="font-semibold text-sm mb-2">UI theme</h4>
      <select
        class="select select-bordered select-sm w-full font-mono"
        value={daisyTheme}
        onchange={(e) => setDaisyTheme((e.target as HTMLSelectElement).value as Theme)}
      >
        {#each AVAILABLE_THEMES as t}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </section>

    <!-- File icon theme -->
    <section class="mb-4">
      <h4 class="font-semibold text-sm mb-2">File icon theme</h4>
      <select
        class="select select-bordered select-sm w-full font-mono"
        value={activeIconTheme}
        onchange={(e) => setIconTheme((e.target as HTMLSelectElement).value as IconThemeName)}
      >
        {#each Object.values(ICON_THEMES) as t}
          <option value={t.key}>{t.byExt.tex ?? t.defaultFile}  {t.name}</option>
        {/each}
      </select>
      <p class="text-[10px] opacity-50 italic mt-1">
        Applies to the file explorer, quick-open, breadcrumb. Nerd-glyphs need a Nerd Font installed in the browser.
      </p>
    </section>

    <!-- Built-in editor color themes -->
    <section class="mb-4">
      <h4 class="font-semibold text-sm mb-2">Editor color theme</h4>
      <select
        class="select select-bordered select-sm w-full font-mono"
        value={vscodeThemes.active ?? 'Default (daisyUI)'}
        onchange={(e) => pickBuiltin((e.target as HTMLSelectElement).value)}
      >
        {#each BUILTIN_THEMES as t}
          <option value={t.name}>{t.name}</option>
        {/each}
        {#each vscodeThemes.themes.filter((tt) => !BUILTIN_THEMES.find((b) => b.name === tt.name)) as t}
          <option value={t.name}>{t.name} (imported)</option>
        {/each}
      </select>
    </section>

    <!-- VSCode-imported themes -->
    <section class="mb-4">
      <h4 class="font-semibold text-sm mb-2">Import VSCode color theme (JSON)</h4>
      <div class="flex items-center gap-2 mb-2 text-xs">
        <input
          type="file"
          accept="application/json,.json"
          class="file-input file-input-bordered file-input-xs"
          onchange={onPickThemeFile}
        />
        <span class="opacity-60">Drop a VSCode theme JSON to load it into the editor.</span>
      </div>
      {#if importErr}
        <div class="alert alert-error text-xs mb-2">{importErr}</div>
      {/if}
      {#if vscodeThemes.themes.length === 0}
        <p class="text-xs opacity-50 italic">No themes loaded yet.</p>
      {:else}
        <ul class="text-xs">
          {#each vscodeThemes.themes as t}
            <li class="flex items-center gap-2 py-1 border-b border-base-300/50">
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                class:btn-active={vscodeThemes.active === t.name}
                onclick={() => vscodeThemes.setActive(vscodeThemes.active === t.name ? null : t.name)}
              >
                {vscodeThemes.active === t.name ? '● ' : '○ '}
                {t.name}
              </button>
              <span class="badge badge-ghost badge-xs">{t.type}</span>
              <button
                type="button"
                class="ml-auto btn btn-ghost btn-xs text-error"
                onclick={() => vscodeThemes.remove(t.name)}
                aria-label="Remove theme"
              >✕</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Compile commands : per-language verbatim override. Empty
         input falls back to the server's built-in command shown as
         placeholder. The override is sent on every Run via
         CompileSpec.command, then the server runs `sh -c <command>`
         inside the workspace μVM. -->
    <section class="mb-4">
      <h4 class="font-semibold text-sm mb-2">Compile commands</h4>
      <p class="text-xs opacity-70 mb-2">
        Override the command run for each file type on
        <span class="kbd kbd-xs">Run</span>. Leave empty to use the
        built-in default (shown as placeholder).
      </p>
      <div class="grid grid-cols-[6rem_1fr_auto] gap-x-2 gap-y-1 items-center">
        {#each COMPILE_LANGS as l (l.id)}
          <label for="cmd-{l.id}" class="text-xs font-semibold opacity-80">{l.label}</label>
          <input
            id="cmd-{l.id}"
            type="text"
            class="input input-bordered input-xs font-mono"
            placeholder={l.placeholder}
            value={compileCommands.current[l.id] ?? ''}
            oninput={(e) => compileCommands.set(l.id, (e.currentTarget as HTMLInputElement).value)}
          />
          {#if compileCommands.current[l.id]}
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              title="Reset to built-in default"
              onclick={() => compileCommands.set(l.id, '')}
            >reset</button>
          {:else}
            <span class="w-12"></span>
          {/if}
        {/each}
      </div>
      {#if Object.keys(compileCommands.current).length > 0}
        <button
          type="button"
          class="btn btn-ghost btn-xs mt-2"
          onclick={() => compileCommands.clear()}
        >Clear all overrides</button>
      {/if}
    </section>

    <!-- Locale -->
    <section>
      <h4 class="font-semibold text-sm mb-2">Language · {localeNames[i18n.current]}</h4>
      <div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {#each Object.entries(localeNames) as [code, name]}
          <button
            type="button"
            class="btn btn-sm"
            class:btn-primary={i18n.current === code}
            onclick={() => i18n.set(code as Locale)}
          >
            <span class="text-base">{localeFlags[code as Locale]}</span>
            <span>{name}</span>
          </button>
        {/each}
      </div>
    </section>

    </div>

    <div class="px-5 py-2 border-t border-base-300 bg-base-200/60 flex items-center justify-end gap-2">
      <button class="btn btn-ghost btn-sm" onclick={() => settings.reset()}>Reset to defaults</button>
      <button class="btn btn-primary btn-sm" onclick={() => { open = false; onClose(); }}>Close</button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop">
    <button onclick={onClose}>close</button>
  </form>
</dialog>
