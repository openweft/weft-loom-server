<script lang="ts">
  // PublicShareDialog — issue / revoke a public read-only link for a
  // project. The owner copies the URL out of this dialog and pastes
  // it anywhere ; recipients open it in a browser with no login and
  // see the project's files (read-only). Comments, compile, shell
  // and write APIs are intentionally NOT exposed on the public path.
  //
  // Wire :
  //   GET    /api/projects/{name}/public-share → 200 { token, url, created } | 404
  //   POST   /api/projects/{name}/public-share → 200 { token, url, created }
  //   DELETE /api/projects/{name}/public-share → 204
  //
  // The dialog is dumb : every mount fetches state, every button
  // mutates the server then re-renders. No optimistic local state —
  // the server is the source of truth and the round-trip is one
  // call away.

  interface Props {
    project: string;
    onClose: () => void;
  }

  let { project, onClose }: Props = $props();

  // Wire-shape mirrored from api_publicshare.go : both URL fields come
  // back from the server so the SPA doesn't have to guess the path
  // prefix.
  type ShareRecord = { token: string; url: string; created: string };

  let share = $state<ShareRecord | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let err = $state<string | null>(null);
  let copied = $state(false);

  // Build the publicly shareable URL : the API returns "/public/<token>",
  // the SPA prefixes the current origin so the user can paste anywhere.
  const shareURL = $derived.by((): string => {
    if (!share) return '';
    if (typeof window === 'undefined') return share.url;
    return window.location.origin + share.url;
  });

  async function load() {
    loading = true;
    err = null;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project)}/public-share`);
      if (r.status === 404) {
        share = null;
      } else if (r.ok) {
        share = (await r.json()) as ShareRecord;
      } else {
        err = `GET ${r.status}`;
      }
    } catch (e) {
      err = String(e);
    } finally {
      loading = false;
    }
  }

  async function generate() {
    busy = true;
    err = null;
    copied = false;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project)}/public-share`, {
        method: 'POST',
      });
      if (!r.ok) {
        err = `POST ${r.status}`;
        return;
      }
      share = (await r.json()) as ShareRecord;
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }

  async function revoke() {
    busy = true;
    err = null;
    copied = false;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project)}/public-share`, {
        method: 'DELETE',
      });
      if (r.status !== 204 && !r.ok) {
        err = `DELETE ${r.status}`;
        return;
      }
      share = null;
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }

  async function copyURL() {
    if (!shareURL) return;
    try {
      await navigator.clipboard.writeText(shareURL);
      copied = true;
      setTimeout(() => { copied = false; }, 1500);
    } catch (e) {
      err = String(e);
    }
  }

  // Initial fetch on mount.
  $effect(() => { void load(); });
</script>

<dialog class="modal modal-open" data-testid="public-share-dialog">
  <div class="card bg-base-200 shadow-xl border border-base-300 modal-box max-w-xl">
    <div class="card-body p-4">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-semibold">
          Public read-only link
          <span class="opacity-50 text-xs">({project})</span>
        </h3>
        <button
          class="btn btn-ghost btn-xs"
          onclick={onClose}
          aria-label="Close"
        >×</button>
      </div>

      <p class="text-xs opacity-60 italic mb-3">
        Anyone with this link can view the project's files in their
        browser, no login required. They cannot edit, comment, compile,
        or run shell commands.
      </p>

      {#if loading}
        <div class="flex items-center gap-2 text-xs opacity-60 p-2">
          <span class="loading loading-spinner loading-xs"></span>
          Loading…
        </div>
      {:else if share}
        <div class="border border-base-300 rounded p-2 bg-base-100">
          <div class="text-[10px] opacity-60 mb-1">Shareable URL</div>
          <div class="flex gap-1 items-center">
            <input
              class="input input-bordered input-xs w-full font-mono"
              readonly
              value={shareURL}
              data-testid="public-share-url"
            />
            <button
              class="btn btn-primary btn-xs"
              onclick={copyURL}
              disabled={busy}
              data-testid="public-share-copy"
            >{copied ? 'Copied!' : 'Copy'}</button>
          </div>
          <div class="text-[10px] opacity-50 mt-1">
            Created {share.created}
          </div>
        </div>

        <div class="modal-action">
          <button
            class="btn btn-error btn-sm"
            onclick={revoke}
            disabled={busy}
            data-testid="public-share-revoke"
          >
            {#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
            Revoke link
          </button>
          <button class="btn btn-sm" onclick={onClose}>Close</button>
        </div>
      {:else}
        <div class="text-xs opacity-60 p-2">
          No public link exists for this project yet.
        </div>
        <div class="modal-action">
          <button
            class="btn btn-primary btn-sm"
            onclick={generate}
            disabled={busy}
            data-testid="public-share-generate"
          >
            {#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
            Generate public link
          </button>
          <button class="btn btn-sm" onclick={onClose}>Cancel</button>
        </div>
      {/if}

      {#if err}
        <div class="alert alert-error alert-sm mt-3 text-xs" data-testid="public-share-error">{err}</div>
      {/if}
    </div>
  </div>
  <button
    type="button"
    class="modal-backdrop"
    onclick={onClose}
    aria-label="Close"
  ></button>
</dialog>
