<script lang="ts">
  // TrackChangesPanel — side panel listing every PENDING ChangeRecord
  // on the active file's change log. Each row shows :
  //   - Author dot (the user.color from awareness) + display name
  //   - "X min ago" relative timestamp
  //   - Diff preview : first ~80 chars of `before` (strikethrough,
  //     redish background) + first ~80 chars of `after` (greenish
  //     background) — quick visual scan of what changed without
  //     running a full character-level diff yet
  //   - Accept / Reject buttons
  //
  // Accept = log.accept(id)  → record dropped, source already at `after`.
  // Reject = log.reject(id)  → record dropped AND a window event
  //   `weft-loom:rollback-change` is dispatched with { id, before } so
  //   LatexWysiwygEditor can rewrite the Y.Text. We don't import the
  //   editor directly to keep the panel reusable from any view.
  //
  // Visual : floats top:1rem; right:1rem like WysiwygFindReplace, with
  // a daisyUI .card + accent color. The panel observes its Y.Array
  // via observeDeep so peer accepts/rejects + new records arrive
  // live, the same way CommentsPanel updates without a polling tick.

  import { onMount, onDestroy } from 'svelte';
  import type { ChangeLog, ChangeRecord } from '../changelog-collab';
  import { diffStrings, renderDiffHtml, type DiffSegment } from '../diffRender';

  interface Props {
    log: ChangeLog;
    onClose: () => void;
  }
  let { log, onClose }: Props = $props();

  let pending = $state<ChangeRecord[]>([]);

  // refresh : re-pull the pending list from the log. Cheap (O(N) walk of the
  // list part) ; called on mount and on every change to it.
  function refresh() {
    pending = log.pending();
  }

  // One channel for both, which keeps local-vs-remote irrelevant: either way
  // the list re-renders. There is no deep variant to ask for any more — a
  // record is written whole and never edited, so a change to this log is a
  // change to the list.
  let unsubscribe: (() => void) | undefined;

  onMount(() => {
    refresh();
    unsubscribe = log.subscribe(refresh);
  });

  onDestroy(() => {
    unsubscribe?.();
  });

  // relativeTime : "2 min ago" / "just now" / "3 h ago" — same
  // bucketing CommentsPanel uses so the loom UI stays consistent.
  function relativeTime(ts: number): string {
    const diff = Math.max(0, Date.now() - ts);
    if (diff < 30 * 1000) return 'just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return `${Math.floor(diff / 1000)}s ago`;
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return `${days} d ago`;
  }

  // diffPreviewHtml : runs a character-level diff between
  // rec.before and rec.after, then caps the total rendered text at
  // ~200 chars so a huge edit doesn't blow up the panel height.
  // Truncation walks the segment list left→right and stops when the
  // accumulated character count exceeds the cap, appending "…" on
  // overflow. Empty + identical snapshots gracefully degrade to a
  // single 'unchanged' segment.
  const DIFF_PREVIEW_CAP = 200;

  function capSegments(segs: DiffSegment[], cap: number): { segs: DiffSegment[]; truncated: boolean } {
    let used = 0;
    const out: DiffSegment[] = [];
    for (const seg of segs) {
      if (used >= cap) return { segs: out, truncated: true };
      const remaining = cap - used;
      if (seg.text.length <= remaining) {
        out.push(seg);
        used += seg.text.length;
      } else {
        out.push({ kind: seg.kind, text: seg.text.slice(0, remaining) });
        return { segs: out, truncated: true };
      }
    }
    return { segs: out, truncated: false };
  }

  function diffPreviewHtml(before: string, after: string): string {
    const all = diffStrings(before, after);
    const { segs, truncated } = capSegments(all, DIFF_PREVIEW_CAP);
    let html = renderDiffHtml(segs);
    if (truncated) html += '<span class="diff-unchanged">…</span>';
    return html;
  }

  function onAccept(rec: ChangeRecord) {
    void log.accept(rec.id);
    refresh();
  }

  function onReject(rec: ChangeRecord) {
    void log.reject(rec.id);
    refresh();
  }

  function onPanelKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div
  class="track-changes-panel card bg-base-200 border border-accent shadow-xl"
  role="dialog"
  aria-label="Track changes"
  tabindex="-1"
  data-testid="track-changes-panel"
  onkeydown={onPanelKey}
>
  <div class="card-body p-3 gap-2">
    <div class="flex items-center gap-2 text-xs">
      <span class="font-semibold text-accent">Track changes</span>
      <span class="ml-auto opacity-60 font-mono" data-testid="track-changes-count">
        {pending.length} pending
      </span>
      <button
        class="btn btn-ghost btn-xs"
        onclick={onClose}
        title="Close (Esc)"
        aria-label="Close track changes"
      >×</button>
    </div>

    {#if pending.length === 0}
      <div class="p-3 text-xs opacity-60 italic text-center">
        No pending changes. Edits from authors with track-changes
        enabled appear here.
      </div>
    {:else}
      <div class="track-changes-list max-h-96 overflow-y-auto flex flex-col gap-2">
        {#each pending as rec (rec.id)}
          <div
            class="track-changes-row border border-base-300 rounded p-2 bg-base-100"
            data-testid="track-changes-row"
            data-change-id={rec.id}
          >
            <div class="flex items-center gap-2 text-xs">
              <span
                class="author-dot inline-block w-3 h-3 rounded-full border border-base-300"
                style="background-color: {rec.color};"
                aria-hidden="true"
              ></span>
              <span class="font-semibold">{rec.author}</span>
              <span class="opacity-60 ml-auto">{relativeTime(rec.at)}</span>
            </div>

            <div
              class="diff-preview mt-2 text-xs font-mono rounded px-1 py-0.5 bg-base-200"
              title={`Before:\n${rec.before}\n\nAfter:\n${rec.after}`}
              data-testid="track-changes-diff"
            >{@html diffPreviewHtml(rec.before, rec.after)}</div>

            <div class="flex justify-end gap-1 mt-2">
              <button
                class="btn btn-success btn-xs"
                onclick={() => onAccept(rec)}
                data-testid="track-changes-accept"
                title="Accept this change (drop from log)"
              >Accept</button>
              <button
                class="btn btn-error btn-xs btn-outline"
                onclick={() => onReject(rec)}
                data-testid="track-changes-reject"
                title="Reject : roll source back to the before-snapshot"
              >Reject</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .track-changes-panel {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 50;
    width: 22rem;
    max-width: calc(100vw - 2rem);
  }
  .diff-preview {
    /* Word-wrap multi-line diffs ; the cap inside diffPreviewHtml
       limits raw character count so the panel can't be flooded by
       a huge paste. Hover title exposes the full before/after. */
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 8rem;
    overflow-y: auto;
  }
  .diff-preview :global(.diff-added) {
    background: rgba(80, 200, 100, 0.2);
  }
  .diff-preview :global(.diff-removed) {
    background: rgba(255, 80, 80, 0.2);
    text-decoration: line-through;
  }
  .diff-preview :global(.diff-unchanged) {
    opacity: 0.7;
  }
</style>
