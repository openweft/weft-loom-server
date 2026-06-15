<script lang="ts">
  // WysiwygFindReplace — floating Find/Replace popover for the
  // .latex-wysiwyg-surface contenteditable. Anchored top-right of
  // the editor wrapper ; finds plain-text matches by walking the
  // surface's Text nodes (TreeWalker) ; highlights every hit with a
  // <mark class="wysiwyg-find-hit"> wrapper ; Next/Prev scrolls +
  // marks the current match active ; Replace swaps the current
  // hit's text + advances ; Replace all sweeps everything.
  //
  // SKIP rules — we don't search inside :
  //   .katex          (KaTeX-rendered math — replacing here would
  //                    desync the data-tex source of truth)
  //   .latex-cite     ([Einstein 1905] is computed from .bib, not
  //                    user-edited text)
  //   .latex-ref      (\ref{…} chip is generated from data-key)
  //   .latex-label    (label hint chip)
  //   .latex-raw      (pass-through LaTeX source we don't grok yet)
  //   [contenteditable="false"]  (math, figures, anything atomic)
  //
  // The ancestor check on every Text node keeps the search-and-
  // replace truth-aligned with what the surface ACTUALLY stores —
  // the underlying LaTeX source rebuilds from data-* attributes,
  // not from the visible rendered text inside .katex spans.

  import { onMount, onDestroy, tick } from 'svelte';

  interface Props {
    host: HTMLElement;    // the contenteditable .latex-wysiwyg-surface
    onChange: () => void; // fired after each Replace so the parent debounce-saves
    onClose: () => void;
  }
  let { host, onChange, onClose }: Props = $props();

  // ─── state ──────────────────────────────────────────────────────
  let findText = $state('');
  let replaceText = $state('');
  let caseSensitive = $state(false);
  let currentIdx = $state(0);
  let totalHits = $state(0);

  let findInputEl: HTMLInputElement | undefined = $state();

  // Each hit is a contiguous run of characters wrapped in a single
  // <mark>. We track them in document order so Next/Prev iterate
  // the visible surface naturally.
  let hitNodes: HTMLElement[] = [];

  // CSS selector for ancestors we MUST NOT descend into. Anything
  // inside one of these is rendered/derived and would break the
  // underlying LaTeX source if we replaced its text.
  const SKIP_SELECTOR =
    '.katex, .latex-cite, .latex-ref, .latex-label, .latex-raw, [contenteditable="false"]';

  function isInsideSkipped(node: Node): boolean {
    let el: HTMLElement | null =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as HTMLElement)
        : (node.parentElement as HTMLElement | null);
    while (el && el !== host) {
      if (el.matches?.(SKIP_SELECTOR)) return true;
      el = el.parentElement;
    }
    return false;
  }

  // ─── highlight build / teardown ────────────────────────────────
  // Strip every <mark.wysiwyg-find-hit> we've previously inserted,
  // restoring the original Text nodes. We replace the <mark> with
  // its child Text node + normalize() so the host returns to its
  // pristine shape (no leftover wrappers, no fragmented text runs).
  function stripHighlights() {
    if (!host) return;
    const marks = host.querySelectorAll<HTMLElement>('mark.wysiwyg-find-hit');
    marks.forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    });
    // Coalesce adjacent text nodes split by our wrappers.
    host.normalize();
    hitNodes = [];
    totalHits = 0;
    currentIdx = 0;
  }

  // Build the search index : walk every Text node not inside a
  // skipped ancestor ; for each occurrence of the query, slice the
  // Text node + wrap that slice in a <mark>. We collect the marks
  // in document order so Next/Prev work without resorting.
  function buildHighlights() {
    stripHighlights();
    if (!findText || !host) return;

    // Snapshot every text node first — splitting nodes during the
    // walk would corrupt the iterator's state.
    const texts: Text[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (isInsideSkipped(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let cur: Node | null = walker.nextNode();
    while (cur) {
      texts.push(cur as Text);
      cur = walker.nextNode();
    }

    const needle = caseSensitive ? findText : findText.toLowerCase();
    const needleLen = needle.length;
    if (needleLen === 0) return;

    const collected: HTMLElement[] = [];
    for (const textNode of texts) {
      let value = textNode.nodeValue ?? '';
      // Track offset INSIDE the current Text node ; the node itself
      // gets shortened+respawned as we splitText off each match.
      let working: Text = textNode;
      let workingValue = value;
      let searchFrom = 0;
      while (true) {
        const hay = caseSensitive ? workingValue : workingValue.toLowerCase();
        const idx = hay.indexOf(needle, searchFrom);
        if (idx < 0) break;
        // Carve out [idx, idx+needleLen) of `working` into its own
        // Text node, wrap it in a <mark>, and continue searching
        // the trailing fragment.
        const after = working.splitText(idx);
        // `after` now starts with the match. Split off the match.
        const tail = after.splitText(needleLen);
        const mark = document.createElement('mark');
        mark.className = 'wysiwyg-find-hit';
        const matchNode = after; // after is now just the match text
        const parent = matchNode.parentNode;
        if (!parent) break;
        parent.insertBefore(mark, matchNode);
        mark.appendChild(matchNode);
        collected.push(mark);
        // Continue with `tail` as the next working node.
        working = tail;
        workingValue = tail.nodeValue ?? '';
        searchFrom = 0;
      }
    }

    hitNodes = collected;
    totalHits = collected.length;
    currentIdx = totalHits > 0 ? 0 : 0;
    if (totalHits > 0) markActive(0);
  }

  // ─── navigation ────────────────────────────────────────────────
  function markActive(i: number) {
    hitNodes.forEach((el, j) => {
      if (j === i) el.classList.add('wysiwyg-find-hit-active');
      else el.classList.remove('wysiwyg-find-hit-active');
    });
    const el = hitNodes[i];
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function next() {
    if (totalHits === 0) return;
    currentIdx = (currentIdx + 1) % totalHits;
    markActive(currentIdx);
  }

  function prev() {
    if (totalHits === 0) return;
    currentIdx = (currentIdx - 1 + totalHits) % totalHits;
    markActive(currentIdx);
  }

  // ─── replace ───────────────────────────────────────────────────
  // Swap the current hit's text + drop the <mark> wrapper. Then
  // rebuild the index : the replacement text might itself contain
  // the needle, or the surrounding text node may have shifted in
  // ways that invalidate our cached refs. Cheap to rebuild + keeps
  // currentIdx pointing at the next match in document order.
  function replaceOne() {
    if (totalHits === 0) return;
    const target = hitNodes[currentIdx];
    if (!target) return;
    const parent = target.parentNode;
    if (!parent) return;
    const replacementNode = document.createTextNode(replaceText);
    parent.replaceChild(replacementNode, target);
    parent.normalize?.();
    const wasIdx = currentIdx;
    buildHighlights();
    // Position at the same logical place (or wrap if we ate the
    // last match). buildHighlights already activated index 0 — only
    // adjust if we want the "advance to next" semantic.
    if (totalHits > 0) {
      currentIdx = Math.min(wasIdx, totalHits - 1);
      markActive(currentIdx);
    }
    onChange();
  }

  function replaceAll() {
    if (totalHits === 0) return;
    // Walk a snapshot — mutating during iteration is fine since
    // each replace is local to its own <mark>.
    const marks = [...hitNodes];
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(replaceText), m);
      parent.normalize?.();
    }
    buildHighlights();
    onChange();
  }

  // ─── lifecycle ─────────────────────────────────────────────────
  // Rebuild whenever the query or the case-sensitivity flag flips.
  // The $effect runs reactively on every keystroke in the input ;
  // that's fine because buildHighlights is O(N text nodes) and the
  // surface is bounded by one tex file.
  $effect(() => {
    void findText;
    void caseSensitive;
    buildHighlights();
  });

  function onPanelKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      next();
      return;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      prev();
      return;
    }
  }

  function onWindowKey(e: KeyboardEvent) {
    // Cmd/Ctrl+G = Next, Cmd/Ctrl+Shift+G = Prev. These come
    // through globally even when focus drifts out of the inputs.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    }
  }

  function close() {
    stripHighlights();
    onClose();
  }

  onMount(() => {
    void tick().then(() => {
      findInputEl?.focus();
    });
  });

  onDestroy(() => {
    // Safety net : if the parent unmounts us without calling
    // onClose (e.g. file swap), we still want the highlights gone.
    stripHighlights();
  });
</script>

<svelte:window onkeydown={onWindowKey} />

<div
  class="wysiwyg-find-replace card bg-base-200 border border-base-300 shadow-xl"
  role="dialog"
  aria-label="Find and replace"
  data-testid="wysiwyg-find-replace"
  onkeydown={onPanelKey}
>
  <div class="card-body p-3 gap-2">
    <div class="flex items-center gap-2 text-xs">
      <span class="font-semibold">Find &amp; replace</span>
      <span class="ml-auto opacity-60 font-mono" data-testid="wysiwyg-find-counter">
        {totalHits === 0 ? 0 : currentIdx + 1}/{totalHits}
      </span>
      <button
        class="btn btn-ghost btn-xs"
        onclick={close}
        title="Close (Esc)"
        aria-label="Close find and replace"
      >×</button>
    </div>

    <input
      bind:this={findInputEl}
      bind:value={findText}
      class="input input-bordered input-sm w-72 text-sm"
      placeholder="Find…"
      aria-label="Find"
      data-testid="wysiwyg-find-input"
    />

    <input
      bind:value={replaceText}
      class="input input-bordered input-sm w-72 text-sm"
      placeholder="Replace with…"
      aria-label="Replace with"
      data-testid="wysiwyg-replace-input"
    />

    <label class="label cursor-pointer justify-start gap-2 py-0">
      <input
        type="checkbox"
        class="checkbox checkbox-xs"
        bind:checked={caseSensitive}
        data-testid="wysiwyg-find-case"
      />
      <span class="label-text text-xs">Case sensitive</span>
    </label>

    <div class="flex flex-wrap items-center gap-1">
      <div class="join">
        <button
          class="join-item btn btn-xs"
          onclick={prev}
          disabled={totalHits === 0}
          title="Previous match (Cmd/Ctrl+Shift+G)"
          aria-label="Previous match"
        >↑ Prev</button>
        <button
          class="join-item btn btn-xs"
          onclick={next}
          disabled={totalHits === 0}
          title="Next match (Cmd/Ctrl+G)"
          aria-label="Next match"
        >↓ Next</button>
      </div>
      <div class="join">
        <button
          class="join-item btn btn-xs"
          onclick={replaceOne}
          disabled={totalHits === 0 || findText.length === 0}
          title="Replace current match"
        >Replace</button>
        <button
          class="join-item btn btn-xs"
          onclick={replaceAll}
          disabled={totalHits === 0 || findText.length === 0}
          title="Replace all matches"
        >Replace all</button>
      </div>
    </div>
  </div>
</div>

<style>
  .wysiwyg-find-replace {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 50;
  }
  /* Highlight styling — applied to <mark> wrappers we inject into
     the surface. :global because the marks live OUTSIDE this
     component's DOM (inside the host contenteditable). */
  :global(mark.wysiwyg-find-hit) {
    background: rgba(250, 200, 50, 0.5);
    color: inherit;
    border-radius: 2px;
    padding: 0;
  }
  :global(mark.wysiwyg-find-hit-active) {
    outline: 2px solid hsl(220, 70%, 50%);
    outline-offset: 1px;
  }
</style>
