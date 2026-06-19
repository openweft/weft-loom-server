<script lang="ts">
  // SaveIndicator — Overleaf-style transient "Saved at HH:MM:SS"
  // chip in the navbar. Listens to the `weft-loom-autosave-completed`
  // window event Editor.svelte dispatches after a debounced
  // writeFile() succeeds. Fades out after 3 s via opacity transition
  // then drops out of the layout (display:none) so the navbar
  // doesn't keep a stale stamp visible across long idle stretches.
  //
  // No reactive Y-binding here — autosave is a global event ; the
  // component is project-agnostic and just narrates the most-recent
  // write across whichever editor instance owns the active file.

  import { i18n } from '../i18n.svelte';

  // Time formatter is locale-aware via Intl.DateTimeFormat — the
  // user's chosen language picks 24h vs 12h + the right separator
  // (e.g. ":" vs "." in some locales). Cached at module scope so
  // every burst-save doesn't allocate a fresh formatter.
  const fmt = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  // visible drives the opacity transition + the display:none after
  // the fade completes. `label` holds the formatted time + `tooltip`
  // surfaces the file path from the event detail payload so hovering
  // the chip discloses which file was written without bloating the
  // visible badge text.
  let label = $state<string>('');
  let tooltip = $state<string>('');
  let visible = $state<boolean>(false);
  let mounted = $state<boolean>(false);

  $effect(() => {
    let fadeTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onSaved = (ev: Event) => {
      const ce = ev as CustomEvent<{ project?: string; file?: string; language?: string }>;
      const file = ce.detail?.file ?? '';
      label = fmt.format(new Date());
      tooltip = file ? i18n.t('save.tooltipPrefix') + ' ' + file : i18n.t('save.tooltipNoFile');
      mounted = true;
      // Force the transition to replay even if we were mid-fade :
      // flip visible off then on in the next microtask so the
      // opacity-0 → opacity-100 transition fires again.
      visible = false;
      if (fadeTimer) clearTimeout(fadeTimer);
      if (hideTimer) clearTimeout(hideTimer);
      queueMicrotask(() => { visible = true; });
      // After 3 s fade out, then drop from layout once the 500 ms
      // CSS transition has had a chance to play.
      fadeTimer = setTimeout(() => { visible = false; }, 3000);
      hideTimer = setTimeout(() => { mounted = false; }, 3000 + 600);
    };
    window.addEventListener('weft-loom-autosave-completed', onSaved);
    return () => {
      window.removeEventListener('weft-loom-autosave-completed', onSaved);
      if (fadeTimer) clearTimeout(fadeTimer);
      if (hideTimer) clearTimeout(hideTimer);
    };
  });
</script>

{#if mounted}
  <span
    class="badge badge-ghost text-xs transition-opacity duration-500"
    class:opacity-0={!visible}
    class:opacity-100={visible}
    title={tooltip}
    aria-live="polite"
  >
    {i18n.t('save.at')} {label}
  </span>
{/if}
