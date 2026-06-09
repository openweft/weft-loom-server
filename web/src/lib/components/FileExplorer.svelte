<script lang="ts">
  // FileExplorer — left sidebar listing every file in the current
  // project (via /api/projects/{name}/files). Clicking one swaps the
  // editor's per-file Yjs ytext key so collaborators on the same file
  // see each other's edits, while collaborators on different files
  // share the same provider (one WS per project) without cross-talk.
  //
  // The active file's extension drives the editor language via
  // languageForPath() : opening main.tex auto-switches the editor +
  // PreviewPane to LaTeX, opening notes.md back to Markdown.
  import { onMount } from 'svelte';
  import { listFiles, type File } from '../api';
  import { languageForPath } from '../theme';

  interface Props {
    project: string;
    currentFile: string;
    onOpen: (path: string, language: string) => void;
  }

  let { project, currentFile, onOpen }: Props = $props();

  let files = $state<File[]>([]);
  let loadError = $state<string | null>(null);
  let loading = $state(false);

  async function refresh() {
    loading = true;
    loadError = null;
    try {
      files = await listFiles(project);
    } catch (e) {
      loadError = String(e);
    } finally {
      loading = false;
    }
  }

  // Re-list when the active project changes.
  $effect(() => {
    if (project) refresh();
  });

  onMount(refresh);

  function open(f: File) {
    if (f.dir) return;
    onOpen(f.path, languageForPath(f.path));
  }

  // Sort: directories first, alphabetical inside each group.
  const sorted = $derived(
    files.slice().sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.path.localeCompare(b.path);
    }),
  );
</script>

<aside class="w-56 bg-base-100 border-r border-base-300 flex flex-col overflow-hidden">
  <header class="flex items-center justify-between px-3 py-2 border-b border-base-300">
    <span class="text-xs font-semibold uppercase opacity-60">Files</span>
    <button
      type="button"
      class="btn btn-ghost btn-xs"
      title="Refresh file list"
      aria-label="Refresh"
      onclick={refresh}
    >
      ⟳
    </button>
  </header>
  <ul class="menu menu-sm flex-1 overflow-y-auto p-1">
    {#if loading}
      <li class="px-2 py-1">
        <span class="loading loading-spinner loading-xs"></span>
        <span class="ml-2 text-xs opacity-60">loading…</span>
      </li>
    {:else if loadError}
      <li class="px-2 py-1 text-error text-xs">{loadError}</li>
    {:else if sorted.length === 0}
      <li class="px-2 py-1 text-xs opacity-60">
        Empty project. Use the API or another client to add files.
      </li>
    {:else}
      {#each sorted as f}
        <li>
          <button
            type="button"
            onclick={() => open(f)}
            class:menu-active={!f.dir && f.path === currentFile}
            disabled={f.dir}
          >
            <span class="font-mono text-xs">
              {f.dir ? '📁' : '📄'} {f.path}
            </span>
          </button>
        </li>
      {/each}
    {/if}
  </ul>
</aside>
