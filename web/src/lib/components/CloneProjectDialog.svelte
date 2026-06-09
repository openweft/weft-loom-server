<script lang="ts">
  // CloneProjectDialog — daisyUI modal that creates a new project by
  // cloning a git repository. This is the architectural primary path :
  // **git is the source of truth, the working tree is transitory**.
  //
  // Behind the scenes :
  //   1. POST /api/projects/{local-name}/git/config sets the remote.
  //   2. POST /api/projects/{local-name}/git/clone wipes any local
  //      working tree under that name and runs `git clone --branch …`.
  //   3. The new project then has a synchronised working tree fed by
  //      pull/push every time a session opens / closes.
  //
  // The user picks a friendly local name (defaults to repo basename)
  // so multi-tab editing knows which working tree to attach to.
  import { saveConfig, cloneFromRemote, type GitConfig, type GitProvider } from '../git';

  interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (project: string) => void;
  }

  let { open = $bindable(), onClose, onCreated }: Props = $props();

  let provider = $state<GitProvider>('github');
  let remoteURL = $state('');
  let branch = $state('main');
  let token = $state('');
  let localName = $state('');
  let err = $state<string | null>(null);
  let busy = $state(false);

  // Auto-fill the local name from the URL's basename (repo-name without
  // .git suffix) when the user hasn't customised it. Stop once they
  // edit the field by hand.
  let nameTouched = $state(false);

  $effect(() => {
    if (nameTouched) return;
    const m = remoteURL.match(/[/:]([^/:]+?)(?:\.git)?$/);
    if (m) localName = m[1];
  });

  async function doClone() {
    if (!remoteURL) {
      err = 'Remote URL is required';
      return;
    }
    if (!localName) {
      err = 'Local project name is required';
      return;
    }
    const cfg: GitConfig = {
      provider,
      remote_url: remoteURL,
      branch: branch || 'main',
      token,
    };
    busy = true;
    err = null;
    try {
      await saveConfig(localName, cfg);
      await cloneFromRemote(localName, cfg);
      onCreated(localName);
      open = false;
      remoteURL = '';
      branch = 'main';
      token = '';
      localName = '';
      nameTouched = false;
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog class="modal" class:modal-open={open}>
  <div class="modal-box max-w-xl">
    <h3 class="text-lg font-bold mb-3">Clone a repository</h3>

    <p class="text-xs opacity-60 italic mb-3">
      The cloned working tree is the transient editing surface ; git is
      the source of truth. Every change syncs through git on session
      open / close.
    </p>

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

    <div class="form-control mt-2">
      <label class="label">
        <span class="label-text text-xs uppercase opacity-60">Remote URL</span>
      </label>
      <input class="input input-bordered input-sm w-full font-mono" bind:value={remoteURL} placeholder="https://github.com/owner/repo.git" />
    </div>

    <div class="form-control mt-2">
      <label class="label">
        <span class="label-text text-xs uppercase opacity-60">Local project name</span>
        <span class="label-text-alt text-xs opacity-50">auto-filled from URL</span>
      </label>
      <input
        class="input input-bordered input-sm w-full font-mono"
        bind:value={localName}
        oninput={() => (nameTouched = true)}
        placeholder="my-project"
      />
    </div>

    <div class="form-control mt-2">
      <label class="label">
        <span class="label-text text-xs uppercase opacity-60">Access token</span>
        <span class="label-text-alt text-xs opacity-50">
          {provider === 'github' ? 'GitHub PAT (repo scope)' :
           provider === 'gitlab' ? 'GitLab PAT (write_repository)' :
           provider === 'forgejo' ? 'Forgejo access token' : 'Password or token'}
        </span>
      </label>
      <input class="input input-bordered input-sm w-full font-mono" type="password" bind:value={token} placeholder="paste your token" />
    </div>

    {#if err}
      <div class="alert alert-error alert-sm mt-3 text-xs">{err}</div>
    {/if}

    <div class="modal-action">
      <button class="btn btn-sm" onclick={() => { open = false; onClose(); }}>Cancel</button>
      <button class="btn btn-primary btn-sm" disabled={busy} onclick={doClone}>
        {#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
        Clone
      </button>
    </div>
  </div>
  <button
    type="button"
    class="modal-backdrop"
    onclick={() => { open = false; onClose(); }}
    aria-label="Close"
  ></button>
</dialog>
