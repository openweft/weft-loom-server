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
  import { onMount, onDestroy, untrack } from 'svelte';
  import { deleteFile, type File } from '../api';
  import ContextMenu, { type ContextEntry } from './ContextMenu.svelte';
  import { languageForPath, iconForPath } from '../theme';
  import { getStatus } from '../git';
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
  // Default = ALL dirs collapsed (VSCode parity — opening a project
  // shouldn't drown the user in a fully-expanded tree). We seed the
  // set lazily after the file list arrives so every directory the
  // server returns starts closed ; user click expands.
  let collapsed = $state<Set<string>>(new Set(['.weft-loom']));
  let initialCollapseSeeded = false;

  // Git status per file. The map is keyed by repo-relative path so a
  // change like "src/main.tex" lines up with the explorer node's
  // fullPath. Polled every 15 s ; tolerates the project not being
  // configured for git (gitChanges stays empty, no badges render).
  let gitChanges = $state<Map<string, string>>(new Map());
  let gitPoll: ReturnType<typeof setInterval> | undefined;
  async function refreshGitStatus() {
    try {
      const s = await getStatus(project);
      if (!s.configured) {
        if (gitChanges.size > 0) gitChanges = new Map();
        return;
      }
      const next = new Map<string, string>();
      for (const c of s.changes ?? []) next.set(c.path, c.status);
      gitChanges = next;
    } catch {
      // Best-effort : a transient HTTP error doesn't drop the existing
      // badges (better to show stale than to flash empty).
    }
  }
  // iconTheme bump : the SettingsPanel dispatches this event on theme
  // switch. Reading `iconBump` inside the template forces Svelte to
  // re-evaluate every `iconForPath(...)` call after the user picks a
  // new icon set.
  let iconBump = $state<number>(0);
  function onIconThemeChange() { iconBump++; }
  onMount(() => {
    refreshGitStatus();
    gitPoll = setInterval(refreshGitStatus, 15_000);
    window.addEventListener('weft-loom-icon-theme-change', onIconThemeChange);
  });
  onDestroy(() => {
    if (gitPoll) clearInterval(gitPoll);
    window.removeEventListener('weft-loom-icon-theme-change', onIconThemeChange);
  });
  // Reload on project switch.
  $effect(() => {
    project;
    refreshGitStatus();
  });

  // Map a status string to a (badge char, tailwind text colour).
  // Mirrors the GitSidebar legend so the two views stay readable
  // side-by-side.
  function gitBadge(status: string | undefined): { ch: string; cls: string } | null {
    switch (status) {
      case 'modified':  return { ch: 'M', cls: 'text-warning' };
      case 'staged':    return { ch: 'A', cls: 'text-success' };
      case 'deleted':   return { ch: 'D', cls: 'text-error' };
      case 'renamed':   return { ch: 'R', cls: 'text-info' };
      case 'untracked': return { ch: 'U', cls: 'text-success/70' };
      default:          return null;
    }
  }

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
      if (mySeq === refreshSeq) {
        files = j.items ?? [];
        // First load : pre-collapse every directory so the tree
        // opens compact (VSCode parity). Subsequent reloads honour
        // whatever the user has expanded/collapsed by hand.
        if (!initialCollapseSeeded) {
          const next = new Set(collapsed);
          for (const f of files) {
            if (f.dir) next.add(f.path);
          }
          collapsed = next;
          initialCollapseSeeded = true;
        }
      }
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
    // Set on dirs that contain a `.git/` subdir : surfaces a small
    // ⎇ badge in the explorer so the user can spot nested Git repos
    // (submodules, vendored libs, side projects).
    isGitRepo?: boolean;
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

    // Mark every directory that contains a `.git/` subdir as a Git
    // repo. The project root counts too — most projects have a
    // `.git` at the top. We walk byPath for O(N) detection ; far
    // cheaper than scanning each dir on render.
    for (const [path, node] of byPath) {
      if (!node.dir) continue;
      const gitPath = path === '' ? '.git' : path + '/.git';
      if (byPath.has(gitPath)) {
        node.isGitRepo = true;
        // Also flag the root when a top-level .git exists.
        if (path !== '') root.isGitRepo = root.isGitRepo;
      }
    }
    if (byPath.has('.git')) root.isGitRepo = true;

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

  async function remove(node: Node, ev?: Event) {
    ev?.stopPropagation();
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

  // Rename : ask for new path, copy content via the files API (PUT
  // creates ; the old file gets unlinked afterwards). No dedicated
  // server endpoint yet ; this client-side dance is enough for the
  // single-tenant workflow.
  async function rename(node: Node) {
    if (node.dir) return;
    const next = prompt('Rename to', node.fullPath);
    if (!next || next === node.fullPath) return;
    try {
      // Fetch + write under new path.
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(node.fullPath),
      );
      if (!r.ok) throw new Error('read failed : ' + r.status);
      const content = await r.text();
      const w = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(next),
        { method: 'PUT', body: content, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      if (!w.ok) throw new Error('write failed : ' + w.status);
      await deleteFile(project, node.fullPath);
      if (node.fullPath === currentFile) onOpen(next, languageForPath(next));
      await refresh();
    } catch (e) {
      alert('Rename failed : ' + String(e));
    }
  }

  // Context-menu glue : right-click on a row opens our shared
  // ContextMenu with Open / Reveal / Rename / Delete actions. We
  // mount a ContextMenu instance scoped to this explorer so its
  // popover anchors near the cursor regardless of App-level state.
  let rowCtx: { open: (x: number, y: number, items: ContextEntry[]) => void; close: () => void } | undefined = $state();

  function openRowContext(ev: MouseEvent, node: Node) {
    ev.preventDefault();
    ev.stopPropagation();
    const items: ContextEntry[] = [];
    if (!node.dir) {
      items.push({ kind: 'item', label: 'Open', action: () => open(node) });
      items.push({ kind: 'divider' });
    }
    items.push({ kind: 'item', label: 'Rename…', shortcut: 'F2', disabled: node.dir, action: () => rename(node) });
    items.push({
      kind: 'item',
      label: 'Delete',
      shortcut: '⌫',
      danger: true,
      disabled: node.dir,
      action: () => remove(node),
    });
    items.push({ kind: 'divider' });
    items.push({ kind: 'item', label: 'Copy path', action: () => { navigator.clipboard?.writeText(node.fullPath); } });
    items.push({ kind: 'item', label: 'Refresh', action: () => refresh() });
    rowCtx?.open(ev.clientX, ev.clientY, items);
  }

  function onCreated(path: string, language: string) {
    refresh();
    onOpen(path, language);
  }
</script>

<aside class="w-full h-full min-h-0 bg-base-100 border-r border-base-300 flex flex-col overflow-hidden">
  <header class="flex items-center justify-between px-3 h-9 border-b border-base-300 bg-base-200">
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
  <!-- File list scrolls VERTICALLY only.
       Drop daisyUI's `menu` class : it sets `flex-flow: column
       wrap` which caps the scrollHeight at the container height
       — items beyond the fold get hidden in a "second column" with
       no scrollbar. A plain block list with `flex-1 min-h-0
       overflow-y-auto overflow-x-hidden` is the correct primitive
       for a vertical-scrollable file tree. -->
  <ul class="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden p-1 block">
    <!-- (former runtime-state debug row removed — its long
         comma-separated content was forcing the explorer into a
         horizontal scroll bar that nothing else triggered.) -->

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
        <li class="relative">
          <!-- VSCode-style indent guides : one vertical line per
               nested level. CSS gradient over a background image
               keeps the cost flat (one element, no extra DOM). -->
          {#each Array(depth) as _, lvl (lvl)}
            <span
              class="absolute top-0 bottom-0 border-l border-base-300/70 pointer-events-none"
              style="left: {lvl * 12 + 10}px"
              aria-hidden="true"
            ></span>
          {/each}
          <button
            type="button"
            class="group flex items-center w-full max-w-full relative min-w-0 overflow-hidden box-border py-1 text-left hover:bg-base-200 data-[active=true]:bg-base-300 rounded"
            style="padding-left: {depth * 12 + 4}px"
            onclick={() => open(node)}
            oncontextmenu={(ev) => openRowContext(ev, node)}
            class:menu-active={!node.dir && node.fullPath === currentFile}
          >
            {#if node.dir}
              <!-- Truncate the directory name in its own block so
                   `text-overflow:ellipsis` actually works ; the git
                   badge SVG sits next to it as a sibling flex item
                   so it can't push the name past the container.
                   The icon span carries `.seti-icon` so when the
                   Seti UI theme is active the @font-face kicks in
                   for the PUA codepoint ; other themes are
                   unaffected (their emoji are outside the seti
                   font's claimed code points). -->
              <span class="font-mono text-xs truncate min-w-0 flex-1">
                {isCollapsed ? '▸' : '▾'} <span class="seti-icon" data-bump={iconBump}>{iconForPath(node.fullPath, true)}</span> {node.name}
              </span>
              {#if node.isGitRepo}
                  <!-- codicon `git-branch` — small mono glyph next
                       to a directory that contains a `.git/`. Helps
                       spot nested repos / submodules without opening
                       them. -->
                <svg
                  viewBox="0 0 16 16"
                  width="11"
                  height="11"
                  fill="currentColor"
                  role="img"
                  aria-label="Git repository"
                  class="opacity-50 shrink-0 mr-1"
                >
                  <title>Git repository</title>
                  <path fill-rule="evenodd" clip-rule="evenodd" d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V5.5l-.005.083A3.001 3.001 0 0 1 9.5 8.5h-3c-.83 0-1.555.337-2.094.882V11.628a2.251 2.251 0 1 1-1.5 0V4.372a2.25 2.25 0 1 1 1.5 0v3.378A4.49 4.49 0 0 1 6.5 7h3a1.5 1.5 0 0 0 1.5-1.5v-.128A2.251 2.251 0 0 1 9.5 3.25zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm8.25-8.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"/>
                </svg>
              {/if}
            {:else}
              {@const badge = gitBadge(gitChanges.get(node.fullPath))}
              <!-- File row name : `truncate` requires `display:block`
                   + nowrap to ellipsis-cut long names. `min-w-0 flex-1`
                   lets it shrink inside the flex parent. -->
              <span class="font-mono text-xs truncate min-w-0 flex-1 {badge?.cls ?? ''}">
                <span class="seti-icon" data-bump={iconBump}>{iconForPath(node.fullPath)}</span> {node.name}
              </span>
              {#if badge}
                <span
                  class="ml-auto mr-1 font-mono text-[10px] font-bold {badge.cls}"
                  title={badge.ch === 'M' ? 'Modified' : badge.ch === 'A' ? 'Staged' : badge.ch === 'D' ? 'Deleted' : badge.ch === 'R' ? 'Renamed' : badge.ch === 'U' ? 'Untracked' : ''}
                >{badge.ch}</span>
              {/if}
            {/if}
            <!-- The inline ✕ delete button used to live here ; it was
                 a misclick footgun. Delete + Rename now live in the
                 right-click context menu (Rename / Delete) — see the
                 `oncontextmenu` handler bound on the row button below. -->
          </button>
        </li>
      {/each}
    {/if}
  </ul>
  <ContextMenu bind:this={rowCtx} />
</aside>

<NewFileDialog bind:open={newOpen} {project} onClose={() => (newOpen = false)} onCreated={onCreated} />
<GitPanel bind:open={gitOpen} {project} onClose={() => (gitOpen = false)} onSynced={refresh} />
