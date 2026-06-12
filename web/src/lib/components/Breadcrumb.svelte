<script lang="ts">
  // Breadcrumb — VSCode-style file-path strip between the TabBar and
  // the editor. Splits the current file path on '/' + renders each
  // segment as a click-target separated by chevrons. The last segment
  // (the file name itself) gets the file icon.
  //
  // Click a parent segment → onPickDir(path) so the explorer can
  // navigate / scroll there. The actual file click is a no-op (the
  // file is already open).

  import { iconForPath } from '../theme';

  interface Props {
    project: string;
    file: string;
  }
  let { project, file }: Props = $props();

  const segments = $derived(
    file ? file.split('/').filter((s) => s.length > 0) : [],
  );
</script>

<nav
  class="flex-none flex items-center gap-1 px-3 py-1 border-b border-base-300 bg-base-100 text-[11px] font-mono select-none overflow-x-auto"
  aria-label="Breadcrumb"
>
  <span class="opacity-60">📁</span>
  <span class="opacity-80 hover:opacity-100">{project}</span>
  {#each segments as seg, i (i)}
    <span class="opacity-40">›</span>
    {#if i === segments.length - 1}
      <span class="font-mono">{iconForPath(seg)} {seg}</span>
    {:else}
      <span class="opacity-80 hover:opacity-100 cursor-default">{seg}</span>
    {/if}
  {/each}
  {#if segments.length === 0}
    <span class="opacity-50 italic">no file open</span>
  {/if}
</nav>
