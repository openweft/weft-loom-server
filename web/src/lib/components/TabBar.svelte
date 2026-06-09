<script lang="ts">
  // TabBar — VSCode-ish tab strip above the editor. The parent App
  // owns the openFiles[] state ; this component just renders it and
  // calls back on activate / close.
  import { iconForPath } from '../theme';

  interface Props {
    files: string[];
    active: string;
    onActivate: (path: string) => void;
    onClose: (path: string) => void;
  }

  let { files, active, onActivate, onClose }: Props = $props();

  function basename(p: string): string {
    const i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }
</script>

{#if files.length > 0}
  <div
    role="tablist"
    class="flex items-stretch bg-base-200 border-b border-base-300 overflow-x-auto"
  >
    {#each files as f (f)}
      <div
        role="tab"
        tabindex="0"
        class="group flex items-center gap-1 px-3 py-1 border-r border-base-300 cursor-pointer hover:bg-base-100 text-xs font-mono whitespace-nowrap"
        class:bg-base-100={f === active}
        class:border-b-2={f === active}
        class:border-b-primary={f === active}
        onclick={() => onActivate(f)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onActivate(f); }}
        title={f}
      >
        <span class="text-base leading-none">{iconForPath(f)}</span>
        <span>{basename(f)}</span>
        <button
          type="button"
          class="ml-1 opacity-50 group-hover:opacity-100 hover:text-error"
          title="Close (Cmd+W)"
          aria-label="Close {basename(f)}"
          onclick={(ev) => { ev.stopPropagation(); onClose(f); }}
        >✕</button>
      </div>
    {/each}
  </div>
{/if}
