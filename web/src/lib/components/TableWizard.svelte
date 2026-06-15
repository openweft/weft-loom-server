<script lang="ts">
  // TableWizard — daisyUI modal that builds a LaTeX `\begin{tabular}`
  // block from a small form (rows, cols, per-column alignment, borders,
  // optional caption/label float wrapper). The parent owns the WYSIWYG
  // caret and just receives the generated string via onInsert.
  //
  // Pure form ↔ string : all the snippet-building logic lives in
  // `../tableGen.ts` so node --test can exercise it without Svelte.
  // The dialog only handles state + preview rendering.

  import { generateTabularLatex, type ColAlign } from '../tableGen';

  interface Props {
    open: boolean;
    onInsert: (latex: string) => void;
    onClose: () => void;
  }

  let { open = $bindable(), onInsert, onClose }: Props = $props();

  // Form state — defaults match the wizard spec : 3×3 left-aligned,
  // no borders, no float wrapper.
  let rows = $state(3);
  let cols = $state(3);
  let alignments = $state<ColAlign[]>(['l', 'l', 'l']);
  let bordered = $state(false);
  let hlines = $state(false);
  let caption = $state('');
  let label = $state('');

  // Keep the alignments[] array in lockstep with `cols`. Growing pads
  // with 'l' (matches the default) ; shrinking just truncates so the
  // user's earlier choices on the remaining columns survive.
  $effect(() => {
    const target = Math.max(1, Math.min(12, Math.floor(cols)));
    if (alignments.length === target) return;
    if (alignments.length < target) {
      alignments = [...alignments, ...Array(target - alignments.length).fill('l' as ColAlign)];
    } else {
      alignments = alignments.slice(0, target);
    }
  });

  // Clamp + sanitise for the live preview. The number inputs already
  // enforce min/max via attributes, but a user can still paste in a
  // garbage value — make the preview defensive.
  const previewLatex = $derived(
    generateTabularLatex({
      rows: Math.max(1, Math.min(20, Math.floor(rows || 1))),
      cols: Math.max(1, Math.min(12, Math.floor(cols || 1))),
      alignments,
      bordered,
      hlines,
      caption,
      label,
    }),
  );

  function setAlignment(i: number, val: ColAlign) {
    const next = alignments.slice();
    next[i] = val;
    alignments = next;
  }

  function doInsert() {
    onInsert(previewLatex);
    open = false;
    onClose();
  }

  function doCancel() {
    open = false;
    onClose();
  }
</script>

<dialog class="modal" class:modal-open={open} data-testid="table-wizard">
  <div class="modal-box max-w-2xl">
    <h3 class="text-lg font-bold mb-3">Insert table</h3>

    <div class="grid grid-cols-2 gap-3">
      <div class="form-control">
        <label class="label" for="tw-rows">
          <span class="label-text text-xs uppercase opacity-60">Rows</span>
        </label>
        <input
          id="tw-rows"
          type="number"
          min="1"
          max="20"
          class="input input-bordered input-sm w-full"
          bind:value={rows}
        />
      </div>
      <div class="form-control">
        <label class="label" for="tw-cols">
          <span class="label-text text-xs uppercase opacity-60">Columns</span>
        </label>
        <input
          id="tw-cols"
          type="number"
          min="1"
          max="12"
          class="input input-bordered input-sm w-full"
          bind:value={cols}
        />
      </div>
    </div>

    <div class="form-control mt-3">
      <span class="label-text text-xs uppercase opacity-60 mb-1">Column alignment</span>
      <div class="flex flex-wrap gap-2">
        {#each alignments as a, i (i)}
          <label class="flex flex-col items-center gap-1">
            <span class="text-xs opacity-50">Col {i + 1}</span>
            <select
              class="select select-bordered select-xs"
              value={a}
              onchange={(e) => setAlignment(i, (e.currentTarget as HTMLSelectElement).value as ColAlign)}
              aria-label="Alignment for column {i + 1}"
            >
              <option value="l">l (left)</option>
              <option value="c">c (center)</option>
              <option value="r">r (right)</option>
            </select>
          </label>
        {/each}
      </div>
    </div>

    <div class="form-control mt-3 flex flex-col gap-1">
      <label class="label cursor-pointer justify-start gap-2">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={bordered} />
        <span class="label-text text-sm">Add | between columns</span>
      </label>
      <label class="label cursor-pointer justify-start gap-2">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={hlines} />
        <span class="label-text text-sm">Add \hline above and below rows</span>
      </label>
    </div>

    <div class="form-control mt-2">
      <label class="label" for="tw-caption">
        <span class="label-text text-xs uppercase opacity-60">Caption</span>
        <span class="label-text-alt text-xs opacity-50">optional · triggers table float</span>
      </label>
      <input
        id="tw-caption"
        class="input input-bordered input-sm w-full"
        bind:value={caption}
        placeholder="Results of the experiment"
      />
    </div>

    <div class="form-control mt-2">
      <label class="label" for="tw-label">
        <span class="label-text text-xs uppercase opacity-60">Label</span>
        <span class="label-text-alt text-xs opacity-50">optional · becomes \label{`tab:<value>`}</span>
      </label>
      <input
        id="tw-label"
        class="input input-bordered input-sm w-full font-mono"
        bind:value={label}
        placeholder="results"
      />
    </div>

    <div class="form-control mt-3">
      <span class="label-text text-xs uppercase opacity-60 mb-1">Preview</span>
      <pre class="bg-base-200 rounded p-2 overflow-x-auto max-h-48"><code
          class="font-mono text-xs"
          data-testid="table-wizard-preview">{previewLatex}</code></pre>
    </div>

    <div class="modal-action">
      <button class="btn btn-sm" onclick={doCancel}>Cancel</button>
      <button class="btn btn-primary btn-sm" onclick={doInsert} data-testid="table-wizard-insert">
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
