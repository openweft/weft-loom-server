<script lang="ts">
  // CollaboratorList — render every Yjs awareness state currently in
  // the room as a chip with the user's name in their distinctive
  // color. The local user always appears first (with a "(you)"
  // suffix) so they can pick their name out at a glance. Clicking
  // the local chip opens a name-edit popover.
  //
  // Yjs awareness is the same source y-codemirror.next uses for
  // remote cursor coloring ; sharing the colors keeps the navbar
  // chips + the in-buffer cursors consistent.
  import { onDestroy } from 'svelte';
  import type { Awareness } from 'y-protocols/awareness';
  import { saveName, type Identity } from '../identity';

  interface Props {
    awareness: Awareness | undefined;
    self: Identity;
    onRename: (identity: Identity) => void;
  }

  let { awareness, self, onRename }: Props = $props();

  interface Peer {
    clientID: number;
    name: string;
    color: string;
    self: boolean;
  }

  let peers = $state<Peer[]>([]);
  let editing = $state(false);
  let draftName = $state('');

  function snapshot() {
    if (!awareness) {
      peers = [];
      return;
    }
    const out: Peer[] = [];
    const states = awareness.getStates();
    const selfID = awareness.clientID;
    states.forEach((state, clientID) => {
      const user = (state as { user?: { name?: string; color?: string } }).user;
      if (!user || !user.name) return;
      out.push({
        clientID,
        name: user.name,
        color: user.color ?? 'hsl(0, 0%, 60%)',
        self: clientID === selfID,
      });
    });
    // Put the local user first ; everyone else alphabetical.
    out.sort((a, b) => {
      if (a.self !== b.self) return a.self ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    peers = out;
  }

  let observer: (() => void) | undefined;
  $effect(() => {
    if (observer && awareness) awareness.off('change', observer);
    observer = undefined;
    if (!awareness) return;
    snapshot();
    observer = () => snapshot();
    awareness.on('change', observer);
  });

  onDestroy(() => {
    if (observer && awareness) awareness.off('change', observer);
  });

  function startEdit() {
    draftName = self.name;
    editing = true;
  }

  function commit() {
    onRename(saveName(draftName));
    editing = false;
  }
</script>

<div class="flex items-center gap-1">
  {#each peers as p}
    {#if p.self && editing}
      <input
        type="text"
        class="input input-xs w-32 font-mono"
        bind:value={draftName}
        onkeydown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') editing = false;
        }}
        onblur={commit}
      />
    {:else}
      <button
        type="button"
        class="badge badge-sm border-none text-white"
        style="background-color: {p.color}"
        title={p.self ? 'Click to rename' : p.name}
        onclick={p.self ? startEdit : undefined}
      >
        {p.name}{p.self ? ' (you)' : ''}
      </button>
    {/if}
  {/each}
  {#if peers.length === 0 && awareness}
    <!-- "connecting…" only makes sense when a Yjs provider exists but
         the WS isn't fully up yet. With the editor not mounted at all,
         awareness is undefined and the chip area stays empty. -->
    <span class="text-xs opacity-40 italic">connecting…</span>
  {/if}
</div>
