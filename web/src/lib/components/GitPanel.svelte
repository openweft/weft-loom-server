<script lang="ts">
  // GitPanel — daisyUI modal that lets the user configure + sync the
  // current project against a GitHub / GitLab / Forgejo / generic
  // remote. The shape of the API is in ../git.ts ; today the server
  // returns canned data so the UI scaffold is testable end-to-end
  // while the go-git wiring lands separately.
  //
  // Status view shows ahead / behind + the list of file-level changes
  // since the last sync. Pull / Push buttons drive the verbs.
  // The cog opens a sub-form to configure (or update) the remote
  // URL + branch + access token.
  import { onMount } from 'svelte';
  import {
    getStatus,
    saveConfig,
    pull,
    push,
    cloneFromRemote,
    providerLabel,
    webURL,
    type GitConfig,
    type GitProvider,
    type GitStatus,
  } from '../git';

  interface Props {
    open: boolean;
    project: string;
    onClose: () => void;
    onSynced: () => void; // FileExplorer re-lists after pull / clone.
  }

  let { open = $bindable(), project, onClose, onSynced }: Props = $props();

  let status = $state<GitStatus | null>(null);
  let loadErr = $state<string | null>(null);
  let busy = $state<'idle' | 'loading' | 'pulling' | 'pushing' | 'cloning' | 'saving'>('idle');

  // Config form state. Pre-populated from the live status when
  // available so users don't have to re-type the URL.
  let provider = $state<GitProvider>('github');
  let remoteURL = $state('');
  let branch = $state('main');
  let token = $state('');
  let editing = $state(false);
  let actionErr = $state<string | null>(null);

  async function refresh() {
    if (!project) return;
    busy = 'loading';
    loadErr = null;
    try {
      status = await getStatus(project);
      if (status.configured) {
        provider = status.provider;
        remoteURL = status.remote_url;
        branch = status.branch || 'main';
      }
    } catch (e) {
      loadErr = String(e);
    } finally {
      busy = 'idle';
    }
  }

  $effect(() => {
    if (open) refresh();
  });

  onMount(refresh);

  async function doPull() {
    busy = 'pulling';
    actionErr = null;
    try {
      status = await pull(project);
      onSynced();
    } catch (e) {
      actionErr = String(e);
    } finally {
      busy = 'idle';
    }
  }

  async function doPush() {
    busy = 'pushing';
    actionErr = null;
    try {
      status = await push(project);
    } catch (e) {
      actionErr = String(e);
    } finally {
      busy = 'idle';
    }
  }

  async function doSave() {
    if (!remoteURL) {
      actionErr = 'Remote URL is required';
      return;
    }
    const cfg: GitConfig = { provider, remote_url: remoteURL, branch: branch || 'main', token };
    busy = 'saving';
    actionErr = null;
    try {
      await saveConfig(project, cfg);
      editing = false;
      token = ''; // Don't echo the token back into the field.
      await refresh();
    } catch (e) {
      actionErr = String(e);
    } finally {
      busy = 'idle';
    }
  }

  async function doClone() {
    if (!remoteURL) {
      actionErr = 'Remote URL is required';
      return;
    }
    const cfg: GitConfig = { provider, remote_url: remoteURL, branch: branch || 'main', token };
    busy = 'cloning';
    actionErr = null;
    try {
      status = await cloneFromRemote(project, cfg);
      editing = false;
      token = '';
      onSynced();
    } catch (e) {
      actionErr = String(e);
    } finally {
      busy = 'idle';
    }
  }

  const aheadBehind = $derived.by(() => {
    if (!status) return '';
    const parts: string[] = [];
    if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
    if (status.behind > 0) parts.push(`${status.behind} behind`);
    return parts.join(' · ') || 'in sync';
  });
</script>

<dialog class="modal" class:modal-open={open}>
  <div class="modal-box max-w-2xl">
    <h3 class="text-lg font-bold mb-3 flex items-center gap-2">
      Git sync
      <span class="text-xs opacity-50 font-mono">{project}</span>
    </h3>

    {#if busy === 'loading'}
      <div class="py-6 flex items-center gap-2">
        <span class="loading loading-spinner loading-sm"></span>
        <span class="text-sm opacity-60">loading status…</span>
      </div>
    {:else if loadErr}
      <div class="alert alert-error text-xs">{loadErr}</div>
    {:else if status && !status.configured}
      <!-- Not configured yet : show the connect form -->
      <div class="alert alert-info text-xs mb-3">
        This project isn't connected to a remote yet. Configure it below
        to enable pull / push.
      </div>
      {@render configForm()}
      <div class="modal-action">
        <button class="btn btn-sm" onclick={() => { open = false; onClose(); }}>Cancel</button>
        <button class="btn btn-ghost btn-sm" disabled={busy !== 'idle'} onclick={doSave}>
          Save config only
        </button>
        <button class="btn btn-primary btn-sm" disabled={busy !== 'idle'} onclick={doClone}>
          {#if busy === 'cloning'}<span class="loading loading-spinner loading-xs"></span>{/if}
          Save & clone
        </button>
      </div>
    {:else if status}
      <!-- Configured : show status + sync actions -->
      <div class="bg-base-200 rounded-box p-3 text-sm space-y-1">
        <div>
          <span class="opacity-50 text-xs uppercase">remote</span>
          <span class="font-mono ml-2">{providerLabel(status.provider)}</span>
        </div>
        <div>
          <span class="opacity-50 text-xs uppercase">url</span>
          <a class="link link-hover ml-2 font-mono break-all" href={webURL(status.provider, status.remote_url)} target="_blank" rel="noopener">
            {status.remote_url}
          </a>
        </div>
        <div>
          <span class="opacity-50 text-xs uppercase">branch</span>
          <span class="font-mono ml-2">{status.branch}</span>
          <span class="badge badge-sm ml-2" class:badge-success={status.ahead === 0 && status.behind === 0} class:badge-warning={status.ahead > 0 || status.behind > 0}>
            {aheadBehind}
          </span>
        </div>
        {#if status.last_sync_unix && status.last_sync_unix > 0}
          <div class="text-xs opacity-60">
            last sync : {new Date(status.last_sync_unix * 1000).toLocaleString()}
          </div>
        {/if}
        {#if status.last_error}
          <div class="text-xs text-error">last error : {status.last_error}</div>
        {/if}
      </div>

      <h4 class="mt-4 mb-2 text-xs uppercase opacity-60">Changes</h4>
      {#if status.changes.length === 0}
        <div class="text-xs opacity-50 italic px-2">clean working tree</div>
      {:else}
        <ul class="text-sm font-mono space-y-1 max-h-48 overflow-y-auto bg-base-100 rounded-box border border-base-300 p-2">
          {#each status.changes as c}
            <li>
              <span class="badge badge-sm mr-2"
                class:badge-success={c.status === 'staged'}
                class:badge-warning={c.status === 'modified'}
                class:badge-info={c.status === 'untracked'}
                class:badge-error={c.status === 'deleted'}>
                {c.status}
              </span>
              {c.path}
            </li>
          {/each}
        </ul>
      {/if}

      {#if editing}
        <div class="mt-4 border-t border-base-300 pt-3">
          {@render configForm()}
          <div class="mt-2 flex gap-2 justify-end">
            <button class="btn btn-ghost btn-xs" onclick={() => (editing = false)}>Cancel edit</button>
            <button class="btn btn-primary btn-xs" disabled={busy !== 'idle'} onclick={doSave}>
              {#if busy === 'saving'}<span class="loading loading-spinner loading-xs"></span>{/if}
              Save
            </button>
          </div>
        </div>
      {/if}

      {#if actionErr}
        <div class="alert alert-error alert-sm mt-3 text-xs">{actionErr}</div>
      {/if}

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (editing = !editing)}>⚙ Configure</button>
        <button class="btn btn-sm" disabled={busy !== 'idle'} onclick={doPull}>
          {#if busy === 'pulling'}<span class="loading loading-spinner loading-xs"></span>{/if}
          ⇣ Pull
        </button>
        <button class="btn btn-primary btn-sm" disabled={busy !== 'idle' || (status.ahead === 0 && status.changes.length === 0)} onclick={doPush}>
          {#if busy === 'pushing'}<span class="loading loading-spinner loading-xs"></span>{/if}
          ⇡ Push
        </button>
        <button class="btn btn-sm" onclick={() => { open = false; onClose(); }}>Close</button>
      </div>
    {/if}
  </div>
  <button
    type="button"
    class="modal-backdrop"
    onclick={() => { open = false; onClose(); }}
    aria-label="Close"
  ></button>
</dialog>

{#snippet configForm()}
  <div class="space-y-2">
    <div class="grid grid-cols-2 gap-3">
      <div class="form-control">
        <label class="label">
          <span class="label-text text-xs uppercase opacity-60">Provider</span>
        </label>
        <select class="select select-bordered select-sm w-full" bind:value={provider}>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
          <option value="forgejo">Forgejo</option>
          <option value="generic">Generic (https / ssh)</option>
        </select>
      </div>
      <div class="form-control">
        <label class="label">
          <span class="label-text text-xs uppercase opacity-60">Branch</span>
        </label>
        <input class="input input-bordered input-sm w-full font-mono" bind:value={branch} placeholder="main" />
      </div>
    </div>
    <div class="form-control">
      <label class="label">
        <span class="label-text text-xs uppercase opacity-60">Remote URL</span>
      </label>
      <input class="input input-bordered input-sm w-full font-mono" bind:value={remoteURL} placeholder="https://github.com/owner/repo.git" />
    </div>
    <div class="form-control">
      <label class="label">
        <span class="label-text text-xs uppercase opacity-60">Access token</span>
        <span class="label-text-alt text-xs opacity-50">
          {provider === 'github' ? 'GitHub PAT (repo scope)' : provider === 'gitlab' ? 'GitLab PAT (write_repository)' : provider === 'forgejo' ? 'Forgejo access token' : 'Password or token'}
        </span>
      </label>
      <input class="input input-bordered input-sm w-full font-mono" type="password" bind:value={token} placeholder="paste your token" />
    </div>
  </div>
{/snippet}
