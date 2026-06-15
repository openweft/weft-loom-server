<script lang="ts">
  // FigureWizard — daisyUI modal that builds a LaTeX `\begin{figure}`
  // block from a small form (image picker, width, placement, caption,
  // label). The parent owns the WYSIWYG caret and just receives the
  // generated string via onInsert.
  //
  // Pure form ↔ string : all the snippet-building logic lives in
  // `../figureGen.ts` so node --test can exercise it without Svelte.
  // The dialog only handles state + image-listing + preview rendering.

  import { listFiles, type File } from '../api';
  import { generateFigureLatex } from '../figureGen';

  interface Props {
    open: boolean;
    project: string;
    onInsert: (latex: string) => void;
    onClose: () => void;
  }

  let { open = $bindable(), project, onInsert, onClose }: Props = $props();

  // Image extensions the wizard will surface. .pdf is deliberately
  // omitted here — the wizard targets rasters + svg ; a PDF figure
  // can still be inserted by hand via the source view.
  const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];

  let images = $state<File[]>([]);
  let imagePath = $state('');
  let width = $state('');
  let placement = $state<'h' | 't' | 'b' | 'p' | 'H'>('h');
  let caption = $state('');
  let label = $state('');
  let loading = $state(false);

  function isImage(f: File): boolean {
    if (f.dir) return false;
    const p = f.path.toLowerCase();
    return IMAGE_EXTS.some((ext) => p.endsWith(ext));
  }

  async function refresh() {
    loading = true;
    try {
      const files = await listFiles(project);
      images = files.filter(isImage);
      // Default the picker to the first image so the preview is
      // meaningful out of the gate — empty path produces a broken
      // \includegraphics{} that would mislead the user.
      if (!imagePath && images.length > 0) {
        imagePath = images[0].path;
      }
    } catch {
      images = [];
    } finally {
      loading = false;
    }
  }

  // Re-list every time the dialog opens. Cheap (one HTTP call) and
  // catches images dragged in between opens.
  $effect(() => {
    if (open) {
      void refresh();
    }
  });

  const previewLatex = $derived(
    generateFigureLatex({
      path: imagePath,
      width,
      placement,
      caption,
      label,
    }),
  );

  function doInsert() {
    if (!imagePath) return;
    onInsert(previewLatex);
    open = false;
    onClose();
  }

  function doCancel() {
    open = false;
    onClose();
  }
</script>

<dialog class="modal" class:modal-open={open} data-testid="figure-wizard">
  <div class="modal-box max-w-2xl">
    <h3 class="text-lg font-bold mb-3">Insert figure</h3>

    <div class="form-control">
      <label class="label" for="fw-image">
        <span class="label-text text-xs uppercase opacity-60">Image</span>
        <span class="label-text-alt text-xs opacity-50">.png .jpg .svg .gif .webp</span>
      </label>
      {#if loading}
        <div class="text-xs opacity-60">Loading project files…</div>
      {:else if images.length === 0}
        <div class="alert alert-warning alert-sm text-xs" data-testid="figure-wizard-no-images">
          No images found in this project. Drag-drop one into the file
          explorer first, then re-open this dialog.
        </div>
      {:else}
        <select
          id="fw-image"
          class="select select-bordered select-sm w-full font-mono"
          bind:value={imagePath}
          data-testid="figure-wizard-image"
        >
          {#each images as img (img.path)}
            <option value={img.path}>{img.path}</option>
          {/each}
        </select>
      {/if}
    </div>

    <div class="form-control mt-3">
      <label class="label" for="fw-width">
        <span class="label-text text-xs uppercase opacity-60">Width</span>
        <span class="label-text-alt text-xs opacity-50">optional · empty = natural size</span>
      </label>
      <input
        id="fw-width"
        class="input input-bordered input-sm w-full font-mono"
        bind:value={width}
        placeholder="0.7\textwidth or 5cm"
      />
    </div>

    <div class="form-control mt-3">
      <span class="label-text text-xs uppercase opacity-60 mb-1">Placement</span>
      <div class="join">
        {#each (['h', 't', 'b', 'p', 'H'] as const) as p (p)}
          <label class="join-item btn btn-sm" class:btn-active={placement === p}>
            <input
              type="radio"
              name="fw-placement"
              value={p}
              bind:group={placement}
              class="hidden"
              aria-label="Placement {p}"
            />
            [{p}]
          </label>
        {/each}
      </div>
    </div>

    <div class="form-control mt-3">
      <label class="label" for="fw-caption">
        <span class="label-text text-xs uppercase opacity-60">Caption</span>
        <span class="label-text-alt text-xs opacity-50">optional</span>
      </label>
      <input
        id="fw-caption"
        class="input input-bordered input-sm w-full"
        bind:value={caption}
        placeholder="Results of the experiment"
      />
    </div>

    <div class="form-control mt-3">
      <label class="label" for="fw-label">
        <span class="label-text text-xs uppercase opacity-60">Label</span>
        <span class="label-text-alt text-xs opacity-50">optional · becomes \label{`fig:<value>`}</span>
      </label>
      <label class="input input-bordered input-sm flex items-center gap-2 font-mono">
        <span class="opacity-50 select-none">fig:</span>
        <input
          id="fw-label"
          class="grow bg-transparent outline-none"
          bind:value={label}
          placeholder="plot"
        />
      </label>
    </div>

    <div class="form-control mt-3">
      <span class="label-text text-xs uppercase opacity-60 mb-1">Preview</span>
      <pre class="bg-base-200 rounded p-2 overflow-x-auto max-h-48"><code
          class="font-mono text-xs"
          data-testid="figure-wizard-preview">{previewLatex}</code></pre>
    </div>

    <div class="modal-action">
      <button class="btn btn-sm" onclick={doCancel}>Cancel</button>
      <button
        class="btn btn-primary btn-sm"
        onclick={doInsert}
        disabled={!imagePath}
        data-testid="figure-wizard-insert"
      >
        Insert
      </button>
    </div>
  </div>
  <button
    type="button"
    class="modal-backdrop"
    onclick={doCancel}
    aria-label="Close"
  ></button>
</dialog>
