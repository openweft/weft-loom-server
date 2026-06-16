<script lang="ts">
  // SharingPanel — modal-style ACL editor for a project.
  //
  // Mounts when the user picks "Share…" from the project menu. Fetches
  // the current shares from GET /api/projects/{project}/sharing, lets
  // the owner add (POST) / remove (DELETE) entries. Server-side authz
  // is the source of truth — this UI is purely a convenience layer.
  //
  // Roles : editor (read + write), commenter (read + comment, no
  // file writes), viewer (read-only). The names mirror common SaaS
  // editor conventions so they're self-documenting in the UI.

  import { listSharing, upsertShare, deleteShare, type Share, type ShareRole } from '../api';

  interface Props {
    project: string;
    onClose: () => void;
  }
  let { project, onClose }: Props = $props();

  let shares = $state<Share[]>([]);
  let inviteUser = $state('');
  let inviteRole = $state<ShareRole>('editor');
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      shares = await listSharing(project);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Network error loading shares.';
      shares = [];
    } finally {
      loading = false;
    }
  }

  // Initial fetch on mount + when the project prop changes.
  $effect(() => {
    void load();
  });

  async function addShare() {
    const user = inviteUser.trim();
    if (!user || busy) return;
    busy = true;
    error = null;
    try {
      shares = await upsertShare(project, user, inviteRole);
      inviteUser = '';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Network error adding share.';
    } finally {
      busy = false;
    }
  }

  async function removeShare(user: string) {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await deleteShare(project, user);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Network error removing share.';
    } finally {
      busy = false;
    }
  }

  function onBackdrop(ev: MouseEvent) {
    if (ev.target === ev.currentTarget) onClose();
  }
  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="sharing-backdrop"
  role="presentation"
  onclick={onBackdrop}
  data-testid="sharing-backdrop"
>
  <div
    class="card bg-base-200 shadow-xl border border-base-300 sharing-card"
    role="dialog"
    aria-modal="true"
    aria-label="Share project"
    data-testid="sharing-panel"
  >
    <div class="card-body p-4">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-semibold">
          Share <span class="opacity-70">{project}</span>
        </div>
        <button
          class="btn btn-ghost btn-xs"
          onclick={onClose}
          aria-label="Close"
        >×</button>
      </div>

      <!-- Invite row -->
      <div class="invite border border-base-300 rounded p-2 mb-3 bg-base-100">
        <div class="text-[10px] opacity-60 mb-1">
          Invite by email — editor / commenter / viewer.
        </div>
        <div class="flex gap-1">
          <input
            type="email"
            class="input input-bordered input-sm flex-1"
            placeholder="name@example.com"
            bind:value={inviteUser}
            disabled={busy}
            data-testid="sharing-invite-user"
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addShare();
              }
            }}
          />
          <select
            class="select select-bordered select-sm"
            bind:value={inviteRole}
            disabled={busy}
            data-testid="sharing-invite-role"
          >
            <option value="editor">editor</option>
            <option value="commenter">commenter</option>
            <option value="viewer">viewer</option>
          </select>
          <button
            class="btn btn-primary btn-sm"
            onclick={() => void addShare()}
            disabled={!inviteUser.trim() || busy}
            data-testid="sharing-invite-add"
          >Add</button>
        </div>
      </div>

      {#if error}
        <div class="alert alert-error py-2 text-xs mb-2" data-testid="sharing-error">
          {error}
        </div>
      {/if}

      <!-- Shares list -->
      <div class="sharing-list">
        {#if loading}
          <div class="opacity-50 text-xs p-2 text-center">Loading…</div>
        {:else if shares.length === 0}
          <div class="opacity-50 text-xs p-2 text-center">
            Not shared with anyone yet. Invite a collaborator above.
          </div>
        {:else}
          {#each shares as s (s.user)}
            <div class="share-row" data-testid="sharing-row" data-user={s.user}>
              <div class="share-user">{s.user}</div>
              <div class="badge badge-ghost badge-sm">{s.role}</div>
              <button
                class="btn btn-ghost btn-xs text-error ml-auto"
                onclick={() => void removeShare(s.user)}
                disabled={busy}
                aria-label={`Remove ${s.user}`}
                data-testid="sharing-remove"
              >Remove</button>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .sharing-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .sharing-card {
    width: min(32rem, 92vw);
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .sharing-card :global(.card-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .sharing-list {
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .share-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border-radius: 0.4rem;
    background: rgba(0, 0, 0, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.08);
    font-size: 0.8rem;
  }
  .share-user {
    font-weight: 500;
    word-break: break-all;
  }
</style>
