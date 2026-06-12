<script lang="ts">
  // AdminPanel — modal that surfaces operator-facing status :
  // currently the per-language OCI image health (ok / missing /
  // unauthorized / unreachable). Polls /api/admin/oci-images ;
  // refresh button forces a fresh probe via `?force=1`.
  //
  // Future tabs : workspace μVM status, NATS subjects, compile
  // job history. For now a single "Images" pane keeps the surface
  // tiny + actionable.

  interface OciStatus {
    language: string;
    image: string;
    status: 'ok' | 'missing' | 'unauthorized' | 'unreachable';
    last_checked_unix: number;
    detail?: string;
  }

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open = $bindable(), onClose }: Props = $props();

  let images = $state<OciStatus[]>([]);
  let loading = $state(false);
  let err = $state<string | null>(null);

  async function refresh(force = false) {
    loading = true;
    err = null;
    try {
      const r = await fetch('/api/admin/oci-images' + (force ? '?force=1' : ''));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      images = (j.images as OciStatus[]) ?? [];
    } catch (e) {
      err = String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (open) refresh();
  });

  function statusBadge(s: OciStatus['status']): { cls: string; label: string } {
    switch (s) {
      case 'ok':           return { cls: 'badge-success', label: 'published' };
      case 'missing':      return { cls: 'badge-error',   label: 'not published' };
      case 'unauthorized': return { cls: 'badge-warning', label: 'private (auth required)' };
      case 'unreachable':  return { cls: 'badge-ghost',   label: 'unreachable' };
    }
  }

  function fmtAgo(unix: number): string {
    if (!unix) return '—';
    const seconds = Math.max(0, Math.round(Date.now() / 1000 - unix));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    return Math.round(seconds / 3600) + 'h ago';
  }
</script>

<dialog class="modal" class:modal-open={open}>
  <div class="modal-box max-w-4xl p-0 overflow-hidden border border-base-300">
    <h3 class="text-base font-semibold flex items-center gap-2 select-none px-4 py-2 bg-base-200 border-b border-base-300">
      <!-- codicon `tools` for the admin / operator surface. -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M3.75 2.5C3.061 2.5 2.5 3.06 2.5 3.75v8.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25v-8.5C13.5 3.06 12.94 2.5 12.25 2.5h-8.5zM1 3.75A2.75 2.75 0 0 1 3.75 1h8.5A2.75 2.75 0 0 1 15 3.75v8.5A2.75 2.75 0 0 1 12.25 15h-8.5A2.75 2.75 0 0 1 1 12.25v-8.5zM7 5h2v6H7V5z"/>
      </svg>
      <span>Admin · Compile images</span>
      <span class="text-xs opacity-50 font-normal">Operator visibility for the per-language OCI images</span>
      <button class="ml-auto btn btn-ghost btn-sm" onclick={() => refresh(true)} disabled={loading} title="Re-probe registry now">
        {#if loading}<span class="loading loading-spinner loading-xs"></span>{:else}↻{/if}
        Refresh
      </button>
      <button class="btn btn-ghost btn-sm" onclick={() => { open = false; onClose(); }} aria-label="Close">✕</button>
    </h3>

    <div class="p-4 overflow-y-auto max-h-[60vh]">
      {#if err}
        <div class="alert alert-error text-xs mb-2">{err}</div>
      {/if}
      {#if images.length === 0 && !loading}
        <p class="opacity-60 italic">No images probed yet.</p>
      {:else}
        <table class="table table-sm w-full font-mono">
          <thead>
            <tr>
              <th>Language</th>
              <th>Image</th>
              <th>Status</th>
              <th>Last checked</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {#each images as it (it.language)}
              {@const b = statusBadge(it.status)}
              <tr>
                <td class="font-semibold">{it.language}</td>
                <td class="text-xs truncate max-w-xs" title={it.image}>{it.image}</td>
                <td><span class="badge badge-xs {b.cls}">{b.label}</span></td>
                <td class="text-xs opacity-70">{fmtAgo(it.last_checked_unix)}</td>
                <td class="text-xs opacity-70 truncate max-w-xs" title={it.detail}>{it.detail || '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if images.some((i) => i.status !== 'ok')}
          <div class="alert alert-warning text-xs mt-3">
            <span>
              Some images are not published. Operators can either set
              <code class="font-mono">WEFT_LOOM_IMAGE_&lt;LANG&gt;</code>
              env vars to point at private registry mirrors, or trigger
              the CI workflow in the matching <code>openweft/weft-loom-&lt;lang&gt;</code> repo
              to publish a tagged release. Until then, the workspace μVM's
              pkgx fallback wrappers (<code>go</code>, <code>python3</code>,
              <code>node</code>) serve as the runtime path.
            </span>
          </div>
        {/if}
      {/if}
    </div>

    <div class="px-5 py-2 border-t border-base-300 bg-base-200/60 flex items-center justify-end gap-2">
      <button class="btn btn-primary btn-sm" onclick={() => { open = false; onClose(); }}>Close</button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop">
    <button onclick={onClose}>close</button>
  </form>
</dialog>
