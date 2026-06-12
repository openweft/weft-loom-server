<script lang="ts">
  import { onMount } from 'svelte';
  import { listProjects, type Project } from '../api';
  import CloneProjectDialog from './CloneProjectDialog.svelte';
  import { clickOutside } from '../actions';

  interface Props {
    current: string;
    onSwitch: (name: string, language: string) => void;
    // Bindable open state so the MenuBar's "Switch project…" item
    // can pop the dropdown without owning the project listing.
    open?: boolean;
  }

  let { current, onSwitch, open = $bindable(false) }: Props = $props();

  let projects = $state<Project[]>([]);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let cloneOpen = $state(false);

  async function refresh() {
    loading = true;
    loadError = null;
    try {
      projects = await listProjects();
    } catch (e) {
      loadError = String(e);
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  function selectProject(p: Project) {
    onSwitch(p.name, p.language ?? 'markdown');
    open = false;
  }

  function onCloned(name: string) {
    refresh();
    onSwitch(name, 'markdown');
  }

  function toggle() {
    open = !open;
    if (open) refresh();
  }
</script>

<div
  class="dropdown dropdown-end"
  class:dropdown-open={open}
  use:clickOutside={() => (open = false)}
>
  <button type="button" class="btn btn-ghost btn-sm" onclick={toggle}>
    <span class="font-mono">{current}</span>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fill-rule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
        clip-rule="evenodd"
      />
    </svg>
  </button>
  {#if open}
    <ul
      class="menu dropdown-content bg-base-100 border-base-300 z-10 mt-2 w-64 rounded-box border p-2 shadow"
    >
      <li class="menu-title px-2 pb-1 text-xs">Projects</li>
      {#if loading}
        <li class="px-2 py-1">
          <span class="loading loading-spinner loading-xs"></span>
          loading…
        </li>
      {:else if loadError}
        <li class="px-2 py-1 text-error text-xs">{loadError}</li>
      {:else if projects.length === 0}
        <li class="px-2 py-1 text-xs opacity-60">
          No projects yet. Clone a repo below to create one.
        </li>
      {:else}
        {#each projects as p}
          <li>
            <button
              type="button"
              onclick={() => selectProject(p)}
              class:menu-active={p.name === current}
            >
              <span class="font-mono">{p.name}</span>
              {#if p.language}
                <span class="badge badge-ghost badge-xs ml-auto">{p.language}</span>
              {/if}
            </button>
          </li>
        {/each}
      {/if}
      <li class="mt-1 border-t pt-1">
        <button type="button" onclick={() => { cloneOpen = true; open = false; }} class="text-xs">
          <span class="opacity-80">⎇ Clone repo…</span>
        </button>
      </li>
      <li>
        <button type="button" onclick={refresh} class="text-xs">
          <span class="opacity-60">⟳ refresh</span>
        </button>
      </li>
    </ul>
  {/if}
</div>

<CloneProjectDialog bind:open={cloneOpen} onClose={() => (cloneOpen = false)} onCreated={onCloned} />
