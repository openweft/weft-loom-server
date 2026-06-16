<script lang="ts">
  // ImportZipDialog — daisyUI 5 modal that uploads a project archive
  // and POSTs it to /api/projects/{name}/import. Mirrors the export
  // flow on the same project so a round-trip (Download zip → Import)
  // is symmetric. The server applies its zip-slip defence + 200 MiB
  // cap ; this dialog stays presentation-only.

  interface Props {
    open: boolean;
    project: string;
    onClose: () => void;
    onDone: () => void;
  }

  let { open = $bindable(), project, onClose, onDone }: Props = $props();

  let dialogEl = $state<HTMLDialogElement | null>(null);
  let cancelBound = false;
  $effect(() => {
    if (!dialogEl) return;
    if (!cancelBound) {
      dialogEl.addEventListener('cancel', (e) => {
        e.preventDefault();
        open = false;
        onClose();
      });
      cancelBound = true;
    }
    if (open && !dialogEl.open) {
      dialogEl.showModal();
      queueMicrotask(() => {
        const target = dialogEl?.querySelector<HTMLElement>('[data-autofocus]');
        target?.focus();
      });
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  let fileEl = $state<HTMLInputElement | null>(null);
  let selectedName = $state<string>('');
  let selectedSize = $state<number>(0);
  let includeAll = $state<boolean>(false);
  let busy = $state<boolean>(false);
  let err = $state<string | null>(null);
  let summary = $state<{ imported: number; skipped: number } | null>(null);

  function onPick(e: Event) {
    const t = e.target as HTMLInputElement;
    const f = t.files?.[0];
    if (!f) {
      selectedName = '';
      selectedSize = 0;
      return;
    }
    selectedName = f.name;
    selectedSize = f.size;
    err = null;
    summary = null;
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    return (n / 1024 / 1024).toFixed(1) + ' MiB';
  }

  async function doImport() {
    const f = fileEl?.files?.[0];
    if (!f) {
      err = 'choose a .zip file first';
      return;
    }
    busy = true;
    err = null;
    summary = null;
    try {
      const fd = new FormData();
      fd.append('zip', f);
      const url =
        '/api/projects/' +
        encodeURIComponent(project) +
        '/import' +
        (includeAll ? '?include=all' : '');
      const resp = await fetch(url, { method: 'POST', body: fd });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(resp.status + ' : ' + txt);
      }
      summary = (await resp.json()) as { imported: number; skipped: number };
      onDone();
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }

  function close() {
    open = false;
    selectedName = '';
    selectedSize = 0;
    summary = null;
    err = null;
    onClose();
  }
</script>

<dialog class="modal" class:modal-open={open} bind:this={dialogEl}>
  <div class="modal-box max-w-lg">
    <h3 class="text-lg font-bold mb-3">Import project from ZIP</h3>

    <p class="text-xs opacity-60 mb-3">
      Files are written into project <span class="font-mono">{project}</span>.
      Existing files with matching paths are overwritten.
    </p>

    <div class="form-control">
      <label class="label" for="iz-file">
        <span class="label-text text-xs uppercase opacity-60">Archive (.zip, max 200 MiB)</span>
      </label>
      <input
        id="iz-file"
        type="file"
        accept=".zip,application/zip"
        bind:this={fileEl}
        onchange={onPick}
        class="file-input file-input-bordered file-input-sm w-full"
        data-autofocus
      />
      {#if selectedName}
        <div class="text-[11px] opacity-60 mt-1 font-mono">
          {selectedName} — {fmtBytes(selectedSize)}
        </div>
      {/if}
    </div>

    <div class="form-control mt-3">
      <label class="label cursor-pointer justify-start gap-2 py-1" for="iz-include-all">
        <input
          id="iz-include-all"
          type="checkbox"
          class="checkbox checkbox-sm"
          bind:checked={includeAll}
        />
        <span class="label-text text-xs">
          Include <span class="font-mono">.weft-loom/</span> + <span class="font-mono">.git/objects/pack/</span>
        </span>
      </label>
    </div>

    {#if err}
      <div class="alert alert-error alert-sm mt-3 text-xs">{err}</div>
    {/if}

    {#if summary}
      <div class="alert alert-success alert-sm mt-3 text-xs">
        Imported {summary.imported} file{summary.imported === 1 ? '' : 's'} ·
        skipped {summary.skipped}
      </div>
    {/if}

    <div class="modal-action">
      <button class="btn btn-sm" onclick={close}>Close</button>
      <button
        class="btn btn-primary btn-sm"
        disabled={busy || !selectedName}
        onclick={doImport}
      >
        {#if busy}
          <span class="loading loading-spinner loading-xs"></span>
        {/if}
        Import
      </button>
    </div>
  </div>
  <button
    type="button"
    class="modal-backdrop"
    onclick={close}
    aria-label="Close"
    aria-hidden="true"
    tabindex="-1"
  ></button>
</dialog>
