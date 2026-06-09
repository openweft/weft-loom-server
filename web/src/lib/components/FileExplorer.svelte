<script lang="ts">
  // FileExplorer — left sidebar : an arborescent view of every file
  // in the current project (GET /api/projects/{name}/files) +
  // a "+" button that opens NewFileDialog to create from a template.
  //
  // The flat path list returned by the API is folded into a tree
  // before render so paths like "src/sub/foo.tex" appear as nested
  // disclosure triangles. Each file click rebinds the editor to the
  // per-file Yjs ytext key ; openinng a different file in the same
  // project doesn't reconnect the WS provider.
  import { onMount } from 'svelte';
  import { listFiles, deleteFile, type File } from '../api';
  import { languageForPath } from '../theme';
  import NewFileDialog from './NewFileDialog.svelte';

  interface Props {
    project: string;
    currentFile: string;
    onOpen: (path: string, language: string) => void;
  }

  let { project, currentFile, onOpen }: Props = $props();

  let files = $state<File[]>([]);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let newOpen = $state(false);
  // collapsed: paths of directories the user has explicitly collapsed.
  // Default = expanded (rooted on initial mount).
  let collapsed = $state<Set<string>>(new Set());

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

  $effect(() => {
    if (project) refresh();
  });

  onMount(refresh);

  // ---- Tree building --------------------------------------------
  // From a flat list of paths build a hierarchical structure suitable
  // for recursive rendering. Directories appear even when not in the
  // raw list (synthesised from intermediate path segments).

  interface Node {
    name: string;        // leaf name (last segment)
    fullPath: string;    // path from root
    dir: boolean;
    children: Node[];    // ordered : dirs first, alphabetical inside
  }

  function buildTree(list: File[]): Node {
    const root: Node = { name: '', fullPath: '', dir: true, children: [] };
    // Index by parent path so we can attach intermediate dirs lazily.
    const byPath = new Map<string, Node>();
    byPath.set('', root);

    function ensureDir(parts: string[]): Node {
      let cur = root;
      let acc = '';
      for (const p of parts) {
        acc = acc === '' ? p : acc + '/' + p;
        let node = byPath.get(acc);
        if (!node) {
          node = { name: p, fullPath: acc, dir: true, children: [] };
          byPath.set(acc, node);
          cur.children.push(node);
        }
        cur = node;
      }
      return cur;
    }

    for (const f of list) {
      const segs = f.path.split('/').filter((s) => s !== '');
      if (segs.length === 0) continue;
      if (f.dir) {
        ensureDir(segs);
        continue;
      }
      const parent = segs.length === 1 ? root : ensureDir(segs.slice(0, -1));
      const leaf: Node = {
        name: segs[segs.length - 1],
        fullPath: f.path,
        dir: false,
        children: [],
      };
      parent.children.push(leaf);
    }

    // Recursively order : directories first, alphabetical inside each
    // group. Mutates in place ; the input root tree is small enough
    // that allocation overhead is irrelevant.
    function sort(node: Node) {
      node.children.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const c of node.children) sort(c);
    }
    sort(root);
    return root;
  }

  const tree = $derived(buildTree(files));

  function open(node: Node) {
    if (node.dir) {
      // toggle collapse
      const next = new Set(collapsed);
      if (next.has(node.fullPath)) next.delete(node.fullPath);
      else next.add(node.fullPath);
      collapsed = next;
      return;
    }
    onOpen(node.fullPath, languageForPath(node.fullPath));
  }

  async function remove(node: Node, ev: Event) {
    ev.stopPropagation();
    if (node.dir) return;
    if (!confirm(`Delete ${node.fullPath} ?`)) return;
    try {
      await deleteFile(project, node.fullPath);
      // If we just deleted the file the user was editing, swap them
      // off it ; otherwise stay where we are.
      if (node.fullPath === currentFile) onOpen('', 'markdown');
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  }

  function onCreated(path: string, language: string) {
    refresh();
    onOpen(path, language);
  }
</script>

<aside class="w-56 bg-base-100 border-r border-base-300 flex flex-col overflow-hidden">
  <header class="flex items-center justify-between px-3 py-2 border-b border-base-300">
    <span class="text-xs font-semibold uppercase opacity-60">Files</span>
    <div class="flex gap-1">
      <button
        type="button"
        class="btn btn-ghost btn-xs"
        title="New file from template"
        aria-label="New file"
        onclick={() => (newOpen = true)}
      >
        +
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-xs"
        title="Refresh file list"
        aria-label="Refresh"
        onclick={refresh}
      >
        ⟳
      </button>
    </div>
  </header>
  <ul class="menu menu-sm flex-1 overflow-y-auto p-1">
    {#if loading}
      <li class="px-2 py-1">
        <span class="loading loading-spinner loading-xs"></span>
        <span class="ml-2 text-xs opacity-60">loading…</span>
      </li>
    {:else if loadError}
      <li class="px-2 py-1 text-error text-xs">{loadError}</li>
    {:else if tree.children.length === 0}
      <li class="px-2 py-1 text-xs opacity-60">
        Empty project. Click <span class="font-mono">+</span> to add a file.
      </li>
    {:else}
      {#each tree.children as node (node.fullPath)}
        {@render renderNode(node, 0)}
      {/each}
    {/if}
  </ul>
</aside>

{#snippet renderNode(node: Node, depth: number)}
  {@const isCollapsed = collapsed.has(node.fullPath)}
  <li>
    <button
      type="button"
      class="group flex items-center w-full"
      style="padding-left: {depth * 12 + 4}px"
      onclick={() => open(node)}
      class:menu-active={!node.dir && node.fullPath === currentFile}
    >
      {#if node.dir}
        <span class="font-mono text-xs">
          {isCollapsed ? '▸' : '▾'} 📁 {node.name}
        </span>
      {:else}
        <span class="font-mono text-xs">📄 {node.name}</span>
      {/if}
      {#if !node.dir}
        <span
          role="button"
          tabindex="0"
          aria-label="Delete {node.fullPath}"
          class="ml-auto opacity-0 group-hover:opacity-100 hover:text-error text-xs px-1 cursor-pointer"
          onclick={(ev) => remove(node, ev)}
          onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') remove(node, ev); }}
        >
          ✕
        </span>
      {/if}
    </button>
    {#if node.dir && !isCollapsed && node.children.length > 0}
      <ul>
        {#each node.children as child (child.fullPath)}
          {@render renderNode(child, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<NewFileDialog bind:open={newOpen} {project} onClose={() => (newOpen = false)} onCreated={onCreated} />
