<script lang="ts">
  // StatusBar — VSCode-style narrow strip at the very bottom of the
  // window. Surfaces session-wide state that doesn't fit in the
  // editor or side panels :
  //
  //   left  : project name • language • connection sync
  //   right : Y.Text tick counter (collaboration heartbeat) • file
  //
  // All user-visible text flows through i18n.t() so the strip flips
  // language when the user changes the MenuBar 🌐 picker.

  import { i18n } from '../i18n.svelte';

  interface Props {
    project: string;
    language: string;
    connectionStatus: 'connecting' | 'connected' | 'disconnected';
    ytextTick: number;
    currentFile: string;
    // Cursor + selection stats forwarded by Editor.svelte. Empty
    // strings while no editor is mounted so the bar slots stay
    // collapsed instead of showing "Ln 0, Col 0".
    cursorLine?: number;
    cursorCol?: number;
    selectionLen?: number;
    wordCount?: number;
  }

  let { project, language, connectionStatus, ytextTick, currentFile, cursorLine, cursorCol, selectionLen, wordCount }: Props = $props();

  const dot = $derived(
    connectionStatus === 'connected'
      ? 'bg-success'
      : connectionStatus === 'connecting'
        ? 'bg-warning'
        : 'bg-error',
  );
  const connText = $derived(i18n.t('status.' + connectionStatus));
</script>

<div
  class="flex-none flex items-center gap-3 px-2 h-6 text-xs bg-primary text-primary-content border-t border-base-300 font-mono select-none overflow-hidden"
>
  <span class="flex items-center gap-1" title="Connection status">
    <span class="inline-block w-2 h-2 rounded-full {dot}"></span>
    {connText}
  </span>
  <span class="opacity-80">|</span>
  <span title="Active project">📁 {project}</span>
  <span class="opacity-80">|</span>
  <span title="Editor language">{language}</span>
  <span class="opacity-80">|</span>
  <span class="truncate" title={currentFile}>{currentFile || i18n.t('status.noFile')}</span>
  <span class="flex-1"></span>
  {#if cursorLine != null && cursorCol != null}
    <span title="Cursor position">Ln {cursorLine}, Col {cursorCol}</span>
    {#if selectionLen != null && selectionLen > 0}
      <span class="opacity-80">|</span>
      <span title="Selected characters">({selectionLen} selected)</span>
    {/if}
    <span class="opacity-80">|</span>
  {/if}
  {#if wordCount != null && wordCount > 0}
    <span title="Word count">{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
    <span class="opacity-80">|</span>
  {/if}
  <span title="Y.Text updates observed (local + remote)">↻ {ytextTick}</span>
  <span class="opacity-80">|</span>
  <span title={'weft-loom · ' + i18n.t('app.tagline')}>weft-loom</span>
</div>
