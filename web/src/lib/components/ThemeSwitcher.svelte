<script lang="ts">
  // ThemeSwitcher — a 3-state toggle (light · auto · dark) that
  // drives daisyUI 5's data-theme attribute on <html>. The "auto"
  // state removes the attribute so the app.css's
  // `themes: light --default, dark --prefersdark` directive picks
  // based on the OS prefers-color-scheme query.
  import { onMount } from 'svelte';
  import { applyTheme, loadTheme, type Theme } from '../theme';

  let theme = $state<Theme>('auto');

  onMount(() => {
    theme = loadTheme();
    applyTheme(theme);
  });

  function set(next: Theme) {
    theme = next;
    applyTheme(next);
  }
</script>

<div class="join">
  <button
    type="button"
    class="join-item btn btn-xs"
    class:btn-active={theme === 'light'}
    title="Light theme"
    aria-label="Light theme"
    onclick={() => set('light')}
  >
    ☀
  </button>
  <button
    type="button"
    class="join-item btn btn-xs"
    class:btn-active={theme === 'auto'}
    title="Follow OS"
    aria-label="Auto theme"
    onclick={() => set('auto')}
  >
    ◐
  </button>
  <button
    type="button"
    class="join-item btn btn-xs"
    class:btn-active={theme === 'dark'}
    title="Dark theme"
    aria-label="Dark theme"
    onclick={() => set('dark')}
  >
    ☾
  </button>
</div>
