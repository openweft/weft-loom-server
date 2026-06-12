<script lang="ts">
  // CollaboratorsSidebar — right-edge panel listing every peer
  // connected to this project's Yjs room, with their distinctive
  // colour, a "(you)" affordance for the local user, and a toggle
  // for the editor's Revision Mode (author-tinted background).
  //
  // Single source of truth : provider.awareness.getStates(). Same
  // map the editor's yCollab extension reads for cursor / selection
  // colouring, the navbar's CollaboratorList used to render before
  // we moved the live list here, and the authorship.ts extension
  // uses to map clientID → user.color when revision-mode is on.
  import { onDestroy } from 'svelte';
  import type { Awareness } from 'y-protocols/awareness';
  import { saveAvatar, saveColor, saveName, type Identity } from '../identity';
  import Avatar from './Avatar.svelte';
  import ColorPickerPopover from './ColorPickerPopover.svelte';

  interface Props {
    awareness: Awareness | undefined;
    self: Identity;
    revisionMode: boolean;
    onRename: (identity: Identity) => void;
    onRevisionToggle: (on: boolean) => void;
    onClose: () => void;
  }

  let {
    awareness,
    self,
    revisionMode = $bindable(),
    onRename,
    onRevisionToggle,
    onClose,
  }: Props = $props();

  interface Peer {
    clientID: number;
    name: string;
    color: string;
    avatar?: string;
    self: boolean;
  }

  let peers = $state<Peer[]>([]);
  let editing = $state(false);
  let draftName = $state('');
  let pickerOpen = $state(false);
  // awarenessTick counts every awareness change event we receive, both
  // local and remote. Surfaced as a tiny badge in the header so you can
  // confirm the WS is actually broadcasting peer updates (count goes
  // up when the other browser changes its name / color / cursor).
  let awarenessTick = $state(0);

  function snapshot() {
    if (!awareness) {
      peers = [];
      return;
    }
    const out: Peer[] = [];
    const states = awareness.getStates();
    const selfID = awareness.clientID;
    states.forEach((state, clientID) => {
      const user = (state as { user?: { name?: string; color?: string; avatar?: string } }).user;
      if (!user || !user.name) return;
      out.push({
        clientID,
        name: user.name,
        color: user.color ?? 'hsl(0, 0%, 60%)',
        avatar: user.avatar,
        self: clientID === selfID,
      });
    });
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
    if (!awareness) {
      peers = [];
      return;
    }
    snapshot();
    observer = () => {
      awarenessTick++;
      snapshot();
    };
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

  function onColor(hex: string) {
    // The picker emits the hex value the user dragged to. Persist +
    // re-broadcast via onRename (which downstream pushes the new
    // identity into awareness.setLocalStateField). Re-using the
    // rename callback keeps the App.svelte wiring single-path.
    onRename(saveColor(hex, self.name));
  }

  function onResetColor() {
    // Drop the override → back to name-hash colour.
    onRename(saveColor(null, self.name));
  }

  function onAvatar(url: string | null) {
    onRename(saveAvatar(url, self.name));
  }

  // file → data URL for inline avatar storage. Keeps things simple
  // without a server upload endpoint ; for production a real
  // upload to /api/profile/avatar would be cleaner.
  function onAvatarFile(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onAvatar(reader.result);
    };
    reader.readAsDataURL(f);
  }

  function toggleRevision() {
    revisionMode = !revisionMode;
    onRevisionToggle(revisionMode);
  }
</script>

<aside class="h-full w-full flex flex-col bg-base-100 overflow-hidden">
  <header class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200">
    <span class="font-semibold text-sm flex items-center gap-1">
      <!-- codicon `organization` (two figures) — matches the
           ActivityBar Collab icon so the panel + button read as a
           pair. -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M6.002 4a2 2 0 1 1 3.996 0A2 2 0 0 1 6 4zm2-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM11 4.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zM12.5 4a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1zm-9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM3 4.5a.5.5 0 1 1 1 0 .5.5 0 0 1-1 0zM4.27 7a3 3 0 0 0-.27 1H2v2.5a1.5 1.5 0 0 0 2.59 1.05c.07.33.19.65.34.94A2.5 2.5 0 0 1 1 10.5V8a1 1 0 0 1 1-1h2.27zm7.29 5.82a2.5 2.5 0 0 0 1.44 0c.29.12.5.18.7.18A2.5 2.5 0 0 0 15 10.5V8a1 1 0 0 0-1-1h-2.27c.17.31.27.66.27 1h2v2.5a1.5 1.5 0 0 1-1.5 1.5c-.21 0-.42-.04-.6-.12-.07.33-.19.65-.34.94zM6 7a1 1 0 0 0-1 1v3a3 3 0 1 0 6 0V8a1 1 0 0 0-1-1H6zm0 1h4v3a2 2 0 1 1-4 0V8z"/>
      </svg>
      Collaborators
    </span>
    <span class="ml-2 badge badge-ghost badge-sm">{peers.length}</span>
    <span class="ml-1 text-[10px] opacity-40 font-mono" title="Awareness change events received">↻{awarenessTick}</span>
    <button
      class="btn btn-ghost btn-xs ml-auto"
      title="Hide collaborators panel"
      onclick={onClose}
      aria-label="Close"
    >✕</button>
  </header>

  <!-- Profile : avatar upload + URL paste. Click the picture to
       pick a colour ; click "set photo" to upload an image
       (rendered as data URL → propagated via awareness). -->
  <details class="border-b border-base-300">
    <summary class="px-3 py-2 cursor-pointer text-xs select-none flex items-center gap-2">
      <Avatar name={self.name} color={self.color} avatar={self.avatar} size={20} />
      <span class="font-semibold">Profile</span>
      <span class="opacity-50 ml-auto truncate font-mono text-[10px]">{self.name}</span>
    </summary>
    <div class="px-3 pb-2 space-y-2">
      <div class="flex items-center gap-2">
        <Avatar name={self.name} color={self.color} avatar={self.avatar} size={40} />
        <div class="flex-1 flex flex-col gap-1">
          <label class="btn btn-ghost btn-xs justify-start">
            📷 Set photo…
            <input
              type="file"
              accept="image/*"
              class="hidden"
              onchange={onAvatarFile}
            />
          </label>
          {#if self.avatar}
            <button class="btn btn-ghost btn-xs justify-start" onclick={() => onAvatar(null)}>
              ✕ Remove photo
            </button>
          {/if}
        </div>
      </div>
    </div>
  </details>

  <!-- Revision-mode toggle -->
  <div class="px-3 py-2 border-b border-base-300">
    <label class="label cursor-pointer justify-between p-0">
      <span class="label-text text-xs">
        🖋 Revision mode
        <span class="block text-[10px] opacity-60 mt-0.5">
          Tint background by author
        </span>
      </span>
      <input
        type="checkbox"
        class="toggle toggle-sm toggle-primary"
        checked={revisionMode}
        onchange={toggleRevision}
      />
    </label>
  </div>

  <!-- Peer list -->
  <ul class="flex-1 overflow-y-auto py-1">
    {#if peers.length === 0}
      <li class="px-3 py-2 text-xs opacity-50 italic">
        {awareness ? 'Connecting…' : 'No room joined yet'}
      </li>
    {/if}
    {#each peers as p (p.clientID)}
      <li class="px-2 py-1">
        {#if p.self && editing}
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            bind:value={draftName}
            onkeydown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') (editing = false);
            }}
            onblur={commit}
          />
        {:else}
          <div class="flex items-center gap-2 px-2 py-1 rounded hover:bg-base-200">
            {#if p.self}
              <!-- Click the avatar to open ColorPickerPopover. The
                   `relative` wrapper anchors the popover via
                   `absolute top-full left-0`. -->
              <div class="relative">
                <button
                  type="button"
                  class="rounded-full cursor-pointer"
                  title="Pick your colour"
                  aria-label="Pick colour"
                  onclick={() => (pickerOpen = !pickerOpen)}
                >
                  <Avatar name={p.name} color={p.color} avatar={p.avatar} size={28} />
                </button>
                <ColorPickerPopover
                  bind:open={pickerOpen}
                  currentColor={p.color}
                  onPick={(c) => onColor(c)}
                  onClose={() => (pickerOpen = false)}
                />
              </div>
            {:else}
              <Avatar name={p.name} color={p.color} avatar={p.avatar} size={28} title={p.name} />
            {/if}
            <button
              type="button"
              class="flex-1 text-left font-mono text-xs truncate"
              onclick={p.self ? startEdit : undefined}
              title={p.self ? 'Click to rename' : p.name}
            >
              {p.name}{p.self ? ' (you)' : ''}
            </button>
            {#if p.self}
              <button
                class="opacity-40 hover:opacity-100 text-[10px]"
                title="Reset colour to name-derived default"
                onclick={onResetColor}
                aria-label="Reset colour"
              >↺</button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</aside>
