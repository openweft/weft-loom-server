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
  import { untrack } from 'svelte';
  import { listFiles, deleteFile, type File } from '../api';
  import { languageForPath, iconForPath } from '../theme';
  import NewFileDialog from './NewFileDialog.svelte';
  import GitPanel from './GitPanel.svelte';

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
  let gitOpen = $state(false);
  // collapsed: paths of directories the user has explicitly collapsed.
  // Default = expanded (rooted on initial mount).
  let collapsed = $state<Set<string>>(new Set());

  let refreshSeq = 0;
  // Debug counters tracing exactly which await step locks up
  let stepBefore = $state(0);
  let stepAfter = $state(0);
  let stepJSON = $state(0);
  let stepCommit = $state(0);

  async function refresh() {
    const mySeq = ++refreshSeq;
    loading = true;
    loadError = null;
    try {
      const url = '/api/projects/' + encodeURIComponent(project) + '/files';
      stepBefore++;
      const resp = await fetch(url);
      stepAfter++;
      if (!resp.ok) {
        if (mySeq === refreshSeq) loadError = 'HTTP ' + resp.status;
        return;
      }
      const j = await resp.json();
      stepJSON++;
      if (mySeq === refreshSeq) files = j.items ?? [];
      stepCommit++;
    } catch (e) {
      if (mySeq === refreshSeq) loadError = 'fetch-err: ' + String(e);
    } finally {
      if (mySeq === refreshSeq) loading = false;
    }
  }

  // Refresh trigger : $effect fires on initial mount AND on every
  // subsequent project change. The body uses untrack() around the
  // refresh() call so reactive reads + writes INSIDE refresh don't
  // become effect dependencies — otherwise the $state debug counters
  // we increment for tracing (stepBefore++) and the loading/error
  // writes form a tight loop where the effect re-runs every time
  // refresh modifies state. Empirically observed seq=1000 within
  // milliseconds of mount when this guard was missing.
  $effect(() => {
    const p = project;
    untrack(() => {
      if (p) refresh();
    });
  });

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

  // flatRows : walk the tree depth-first into a flat (node, depth)
  // list that the template can iterate without recursive snippets.
  // Svelte 5 self-referencing snippets work in principle but were
  // empirically locking the FileExplorer on first paint when the
  // tree had nested directories ; flattening sidesteps that path
  // entirely and gives an O(N) iteration that's easier to reason
  // about.
  interface FlatRow {
    node: Node;
    depth: number;
  }
  function flatten(root: Node): FlatRow[] {
    const out: FlatRow[] = [];
    function walk(n: Node, depth: number) {
      if (n !== root) out.push({ node: n, depth });
      if (n.dir && !collapsed.has(n.fullPath)) {
        for (const c of n.children) walk(c, n === root ? 0 : depth + 1);
      }
    }
    walk(root, 0);
    return out;
  }
  const rows = $derived(flatten(tree));

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

<aside class="w-full h-full bg-base-100 border-r border-base-300 flex flex-col overflow-hidden">
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
        title="Git sync (GitHub / GitLab / Forgejo)"
        aria-label="Git sync"
        onclick={() => (gitOpen = true)}
      >
        ⎇
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
    <!-- temp debug : surface the FileExplorer's runtime state to the
         user-visible UI so we can see why the loading state is stuck.
         Remove once the cause is identified. -->
    <li class="px-2 py-1 text-[10px] opacity-80 font-mono border-b border-base-200 mb-1 leading-tight">
      proj={project || '∅'} seq={refreshSeq} ld={loading?1:0}
      <br/>
      pre={stepBefore} aft={stepAfter} json={stepJSON} cmt={stepCommit}
      <br/>
      n={files.length} {#if loadError}err={loadError}{/if}
    </li>

    {#if loading}
      <li class="px-2 py-1">
        <span class="loading loading-spinner loading-xs"></span>
        <span class="ml-2 text-xs opacity-60">loading…</span>
      </li>
    {:else if loadError}
      <li class="px-2 py-1 text-error text-xs">{loadError}</li>
    {:else if rows.length === 0}
      <li class="px-2 py-1 text-xs opacity-60">
        Empty project. Click <span class="font-mono">+</span> to add a file.
      </li>
    {:else}
      {#each rows as row (row.node.fullPath)}
        {@const node = row.node}
        {@const depth = row.depth}
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
                {isCollapsed ? '▸' : '▾'} {iconForPath(node.fullPath, true)} {node.name}
              </span>
            {:else}
              <span class="font-mono text-xs">{iconForPath(node.fullPath)} {node.name}</span>
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
        </li>
      {/each}
    {/if}
  </ul>
</aside>

<NewFileDialog bind:open={newOpen} {project} onClose={() => (newOpen = false)} onCreated={onCreated} />
<GitPanel bind:open={gitOpen} {project} onClose={() => (gitOpen = false)} onSynced={refresh} />
