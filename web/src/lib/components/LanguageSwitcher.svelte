<script lang="ts">
  // LanguageSwitcher — daisyUI dropdown that lets the user pick the
  // CodeMirror language pack. The default is auto-detected from the
  // current file's extension (see ../theme.ts::languageForPath) but
  // the user can override at any time. The choice flows back through
  // the onChange callback so the parent App swaps the editor's
  // language prop.
  import { clickOutside } from '../actions';

  interface Props {
    current: string;
    onChange: (language: string) => void;
  }

  let { current, onChange }: Props = $props();

  const LANGUAGES = [
    { id: 'markdown', label: 'Markdown' },
    { id: 'latex', label: 'LaTeX' },
    { id: 'go', label: 'Go' },
    { id: 'cpp', label: 'C / C++' },
    { id: 'python', label: 'Python' },
    { id: 'rust', label: 'Rust' },
    { id: 'javascript', label: 'JS / TS' },
  ];

  let open = $state(false);
  const label = $derived(
    LANGUAGES.find((l) => l.id === current)?.label ?? current,
  );

  function pick(id: string) {
    onChange(id);
    open = false;
  }
</script>

<div
  class="dropdown dropdown-end"
  class:dropdown-open={open}
  use:clickOutside={() => (open = false)}
>
  <button type="button" class="btn btn-ghost btn-sm w-40 justify-between" onclick={() => (open = !open)}>
    <span class="flex items-center gap-1 min-w-0">
      <span class="text-xs opacity-60">lang :</span>
      <span class="font-mono truncate">{label}</span>
    </span>
    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
    </svg>
  </button>
  {#if open}
    <ul class="menu dropdown-content bg-base-100 border-base-300 z-10 mt-2 w-56 rounded-box border p-2 shadow">
      <li class="menu-title px-2 pb-1 text-xs">Editor language</li>
      {#each LANGUAGES as l}
        <li>
          <button
            type="button"
            onclick={() => pick(l.id)}
            class:menu-active={l.id === current}
          >
            <span>{l.label}</span>
            <span class="font-mono ml-auto text-xs opacity-50">{l.id}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
