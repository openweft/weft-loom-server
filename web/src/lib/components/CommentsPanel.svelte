<script lang="ts">
  // CommentsPanel — floating 💭 FAB next to the LaTeX symbol +
  // bibliography clusters. Visible for ANY editable file (not just
  // LaTeX) since collaborative comments are useful everywhere.
  //
  // Comments live in a Y.Array on the same Y.Doc the editor uses,
  // so the round-trip is full-CRDT : another peer adds a comment +
  // the local panel re-renders on the next Yjs observe tick.
  //
  // T6 V0.1 scope :
  //   - List comments for the active file
  //   - "Add comment on selection" button (selection from the editor)
  //   - Resolve / re-open / delete
  //   - Click → scroll the editor to the anchor + focus
  //
  // Out of scope V0.1 : threaded replies, markdown body, mentions,
  // notification badges.

  import * as Y from 'yjs';
  import {
    commentsArray, encodeRP, resolveAnchors, genId,
    newCommentMap, commentFromMap,
    type CommentRecord,
  } from '../comments';
  import type { Identity } from '../identity';

  interface Props {
    ydoc?: Y.Doc;
    file?: string;
    identity?: Identity;
    visible: boolean;
    // Called when the user clicks a comment in the list — App
    // dispatches a `jumpToLine` effect on the editor.
    onJumpToOffset?: (from: number, to: number) => void;
  }
  let { ydoc, file, identity, visible, onJumpToOffset }: Props = $props();

  let open = $state(false);
  let comments = $state<CommentRecord[]>([]);
  let resolved = $state<Record<string, { from: number; to: number } | null>>({});
  let pendingBody = $state('');
  let lastSelection = $state<{ from: number; to: number; text: string } | null>(null);

  let arr: Y.Array<Y.Map<unknown>> | undefined;
  let observer: (() => void) | undefined;

  // Watch the comments array + rebuild local state every time it
  // changes (local OR remote). We resolve anchors against the live
  // ytext so the panel hides comments whose target was deleted.
  $effect(() => {
    if (observer) { observer(); observer = undefined; }
    arr = undefined;
    comments = [];
    resolved = {};
    if (!ydoc || !file) return;
    const a = commentsArray(ydoc, file);
    arr = a;
    const ytext = ydoc.getText('file:' + file);
    const rebuild = () => {
      const list = a.toArray().map(commentFromMap);
      comments = list;
      const res: Record<string, { from: number; to: number } | null> = {};
      for (const c of list) {
        res[c.id] = resolveAnchors(ydoc, ytext, c);
      }
      resolved = res;
    };
    rebuild();
    const fn = () => rebuild();
    a.observe(fn);
    ytext.observe(fn);
    observer = () => { a.unobserve(fn); ytext.unobserve(fn); };
    return () => { if (observer) { observer(); observer = undefined; } };
  });

  // The editor sends selection changes to the global hook so the
  // panel knows which range a new comment should anchor on.
  $effect(() => {
    if (!visible) return;
    (window as unknown as {
      weftLoomReportSelection?: (sel: { from: number; to: number; text: string } | null) => void;
    }).weftLoomReportSelection = (sel) => { lastSelection = sel; };
    return () => {
      delete (window as unknown as { weftLoomReportSelection?: unknown }).weftLoomReportSelection;
    };
  });

  function addComment() {
    if (!arr || !ydoc || !file) return;
    const body = pendingBody.trim();
    if (!body) return;
    const sel = lastSelection;
    if (!sel || sel.from === sel.to) {
      alert('Select some text in the editor first, then add a comment.');
      return;
    }
    const ytext = ydoc.getText('file:' + file);
    const fromRP = Y.createRelativePositionFromTypeIndex(ytext, sel.from);
    const toRP   = Y.createRelativePositionFromTypeIndex(ytext, sel.to);
    const rec: CommentRecord = {
      id: genId(),
      from: encodeRP(fromRP),
      to:   encodeRP(toRP),
      body,
      authorId:    identity?.id ?? 'anon',
      authorName:  identity?.name ?? 'Anonymous',
      authorColor: identity?.color ?? '#888',
      resolved: false,
      ts: Date.now(),
    };
    ydoc.transact(() => { arr!.push([newCommentMap(rec)]); }, 'comment-add');
    pendingBody = '';
  }

  function toggleResolved(id: string) {
    if (!arr || !ydoc) return;
    ydoc.transact(() => {
      const all = arr!.toArray();
      const idx = all.findIndex(m => m.get('id') === id);
      if (idx < 0) return;
      const cmap = all[idx];
      cmap.set('resolved', !cmap.get('resolved'));
    }, 'comment-toggle');
  }

  function deleteComment(id: string) {
    if (!arr || !ydoc) return;
    ydoc.transact(() => {
      const all = arr!.toArray();
      const idx = all.findIndex(m => m.get('id') === id);
      if (idx >= 0) arr!.delete(idx, 1);
    }, 'comment-delete');
  }

  function onJump(c: CommentRecord) {
    const r = resolved[c.id];
    if (!r) return;
    onJumpToOffset?.(r.from, r.to);
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
</script>

{#if visible}
  <div class="comments-panel">
    <button
      type="button"
      class="comments-fab btn btn-circle btn-accent"
      title={'Comments (' + comments.length + ')'}
      onclick={() => (open = !open)}
      aria-label="Open comments"
      data-testid="comments-toggle"
    >
      <span class="text-xl">💭</span>
      {#if comments.filter(c => !c.resolved).length > 0}
        <span class="absolute -top-1 -right-1 badge badge-xs badge-warning">
          {comments.filter(c => !c.resolved).length}
        </span>
      {/if}
    </button>
    {#if open}
      <div class="comments-popover card bg-base-200 shadow-xl border border-base-300" data-testid="comments-panel">
        <div class="card-body p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-semibold">
              Comments
              <span class="opacity-50 text-xs">
                ({comments.filter(c => !c.resolved).length} open · {comments.filter(c => c.resolved).length} resolved)
              </span>
            </div>
            <button class="btn btn-ghost btn-xs" onclick={() => (open = false)} aria-label="Close">×</button>
          </div>
          <div class="add-comment border border-base-300 rounded p-2 mb-2 bg-base-100">
            <div class="text-[10px] opacity-60 mb-1">
              {#if lastSelection && lastSelection.from < lastSelection.to}
                On selection: "<i>{lastSelection.text.slice(0, 60)}{lastSelection.text.length > 60 ? '…' : ''}</i>"
              {:else}
                Select text in the editor to anchor a new comment.
              {/if}
            </div>
            <textarea
              class="textarea textarea-bordered textarea-sm w-full"
              rows="2"
              placeholder="Comment body…"
              bind:value={pendingBody}
              data-testid="comments-input"
            ></textarea>
            <button
              class="btn btn-primary btn-xs mt-1"
              onclick={addComment}
              disabled={!pendingBody.trim() || !lastSelection || lastSelection.from === lastSelection.to}
              data-testid="comments-add"
            >Add comment</button>
          </div>
          <div class="comments-list">
            {#each comments as c (c.id)}
              <div
                class="comment"
                class:resolved={c.resolved}
                data-testid="comment-entry"
                data-id={c.id}
              >
                <button
                  type="button"
                  class="comment-jump"
                  onclick={() => onJump(c)}
                  title={resolved[c.id] ? 'Jump to anchor' : 'Anchor lost (text deleted)'}
                >
                  <div class="comment-head">
                    <span class="comment-author" style="color: {c.authorColor}">{c.authorName}</span>
                    <span class="comment-ts">{formatTime(c.ts)}</span>
                    {#if c.resolved}
                      <span class="badge badge-ghost badge-xs">resolved</span>
                    {/if}
                    {#if !resolved[c.id]}
                      <span class="badge badge-warning badge-xs">orphan</span>
                    {/if}
                  </div>
                  <div class="comment-body">{c.body}</div>
                </button>
                <div class="comment-actions">
                  <button
                    class="btn btn-ghost btn-xs"
                    onclick={() => toggleResolved(c.id)}
                  >{c.resolved ? 'Re-open' : 'Resolve'}</button>
                  <button
                    class="btn btn-ghost btn-xs text-error"
                    onclick={() => deleteComment(c.id)}
                  >Delete</button>
                </div>
              </div>
            {/each}
            {#if comments.length === 0}
              <div class="opacity-50 text-xs p-2 text-center">
                No comments yet. Select some text in the editor + write a comment above.
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .comments-panel {
    position: absolute;
    right: 1.5rem;
    bottom: 9.5rem; /* sits above bib panel + symbol palette */
    z-index: 30;
  }
  .comments-fab {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    position: relative;
  }
  .comments-popover {
    position: absolute;
    right: 0;
    bottom: 4rem;
    width: 28rem;
    max-height: 36rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .comments-popover :global(.card-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .comments-list {
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .comment {
    display: block;
    padding: 0.5rem 0.6rem;
    border-radius: 0.4rem;
    background: rgba(0, 0, 0, 0.03);
    border: 1px solid rgba(0, 0, 0, 0.08);
  }
  .comment.resolved { opacity: 0.5; }
  .comment-jump {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .comment-jump:hover .comment-body { color: rgb(0, 100, 200); }
  .comment-head {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.7rem;
  }
  .comment-author { font-weight: 600; }
  .comment-ts { opacity: 0.5; }
  .comment-body {
    font-size: 0.8rem;
    margin-top: 0.2rem;
    white-space: pre-wrap;
  }
  .comment-actions {
    margin-top: 0.3rem;
    display: flex;
    gap: 0.2rem;
  }
</style>
