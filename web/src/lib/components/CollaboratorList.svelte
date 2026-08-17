<script lang="ts">
  // CollaboratorList — render everybody the session says is currently in
  // the room as a chip with the user's name in their distinctive
  // color. The local user always appears first (with a "(you)"
  // suffix) so they can pick their name out at a glance. Clicking
  // the local chip opens a name-edit popover.
  //
  // The session is the same source the editor paints peer carets from, so
  // remote cursor coloring ; sharing the colors keeps the navbar
  // chips + the in-buffer cursors consistent.
  import { onDestroy } from 'svelte';
  import { watchPeers, type Session } from '../collab';
  import { saveName, type Identity } from '../identity';

  interface Props {
    session: Session | undefined;
    self: Identity;
    onRename: (identity: Identity) => void;
  }

  let { session, self, onRename }: Props = $props();

  interface Peer {
    clientID: string;
    name: string;
    color: string;
    self: boolean;
  }

  let peers = $state<Peer[]>([]);
  let editing = $state(false);
  let draftName = $state('');

  function snapshot() {
    if (!session) {
      peers = [];
      return;
    }
    const out: Peer[] = [];
    // peers() includes this participant, where an awareness map excluded it —
    // and this list wants it, marked as itself and put first.
    const selfSite = session.site;
    for (const peer of session.peers()) {
      const name = peer.meta?.name;
      if (!name) continue;
      out.push({
        clientID: peer.site,
        name,
        color: peer.meta?.color ?? 'hsl(0, 0%, 60%)',
        self: peer.site === selfSite,
      });
    }
    // Put the local user first ; everyone else alphabetical.
    out.sort((a, b) => {
      if (a.self !== b.self) return a.self ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    peers = out;
  }

  let unwatch: (() => void) | undefined;
  $effect(() => {
    const live = session;
    unwatch?.();
    unwatch = undefined;
    if (!live) {
      peers = [];
      return;
    }
    snapshot();
    let stopped = false;
    void watchPeers(live, snapshot)
      .then((off) => (stopped ? off() : (unwatch = off)))
      .catch((err) => console.error('collab: watching who is here', err));
    return () => {
      stopped = true;
      unwatch?.();
      unwatch = undefined;
    };
  });

  onDestroy(() => {
    unwatch?.();
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
  {#if peers.length === 0 && session}
    <!-- "connecting…" only makes sense once a session exists and nobody has
         published yet. With no session at all the chip area stays empty. -->
    <span class="text-xs opacity-40 italic">connecting…</span>
  {/if}
</div>
