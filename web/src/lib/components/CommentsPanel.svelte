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
    commentsArray, encodeRP, genId,
    newCommentMap,
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
  // Per-thread reply drafts. Keyed by the thread-root comment id ;
  // typing in one reply box doesn't leak into another.
  let replyDrafts = $state<Record<string, string>>({});
  // Tracks which thread-root has its reply textarea expanded. Clean
  // UX : only one reply form open at a time, click "Reply" to toggle.
  let replyOpen = $state<string | null>(null);
  // Derived view : top-level threads (comments without parentId)
  // grouped with their replies. Replies are sorted by ts ascending so
  // they read top→bottom chronologically inside each thread.
  type Thread = { root: CommentRecord; replies: CommentRecord[] };
  const threads = $derived.by((): Thread[] => {
    const roots = comments.filter((c) => !c.parentId);
    const byParent = new Map<string, CommentRecord[]>();
    for (const c of comments) {
      if (!c.parentId) continue;
      const arr = byParent.get(c.parentId) ?? [];
      arr.push(c);
      byParent.set(c.parentId, arr);
    }
    for (const arr of byParent.values()) arr.sort((a, b) => a.ts - b.ts);
    return roots.map((r) => ({ root: r, replies: byParent.get(r.id) ?? [] }));
  });

  let arr: Y.Array<Y.Map<unknown>> | undefined;

  // H4 fix : the panel no longer runs its own ytext.observe +
  // arr.observeDeep — App.svelte owns the single comment-anchor
  // resolver and broadcasts the snapshot via `window.weftLoomCommentRanges`
  // + a `weft-loom-comments-resolved` CustomEvent. The panel just
  // consumes that snapshot, so a keystroke decodes anchors ONCE
  // (instead of twice — once for the editor decoration, once for the
  // panel list).
  //
  // `arr` is still resolved here because addComment / toggleResolved /
  // deleteComment / addReply need to write back into the Y.Array.
  $effect(() => {
    comments = [];
    resolved = {};
    arr = undefined;
    if (!ydoc || !file) return;
    arr = commentsArray(ydoc, file);
    const pickSnapshot = () => {
      const snap = (window as unknown as {
        weftLoomCommentRanges?: {
          file: string;
          comments: CommentRecord[];
          resolved: Record<string, { from: number; to: number } | null>;
        };
      }).weftLoomCommentRanges;
      if (!snap || snap.file !== file) return;
      comments = snap.comments;
      resolved = snap.resolved;
    };
    // Prime synchronously from the last broadcast snapshot (App.svelte
    // does an initial doRebuild() before the observer is wired, so the
    // snapshot is usually already there by the time we mount).
    pickSnapshot();
    const onSnap = () => pickSnapshot();
    window.addEventListener('weft-loom-comments-resolved', onSnap);
    return () => {
      window.removeEventListener('weft-loom-comments-resolved', onSnap);
    };
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
    // Threaded comments : when deleting a thread root we cascade
    // through replies in the same transaction so peers see a clean
    // disappearance. Deleting a reply leaves the root + siblings.
    ydoc.transact(() => {
      const all = arr!.toArray();
      // Pre-compute ids to drop : the target + (when target is a
      // root) every direct/indirect reply that points back at it.
      const toDrop = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const m of all) {
          const p = m.get('parentId') as string | undefined;
          const ownId = m.get('id') as string;
          if (p && toDrop.has(p) && !toDrop.has(ownId)) {
            toDrop.add(ownId);
            grew = true;
          }
        }
      }
      // Delete from highest index to lowest so indices stay valid.
      const indices: number[] = [];
      for (let i = 0; i < all.length; i++) {
        if (toDrop.has(all[i].get('id') as string)) indices.push(i);
      }
      indices.reverse();
      for (const i of indices) arr!.delete(i, 1);
    }, 'comment-delete');
  }

  function addReply(rootId: string) {
    if (!arr || !ydoc || !file) return;
    const body = (replyDrafts[rootId] ?? '').trim();
    if (!body) return;
    // Replies inherit the root thread's anchor range — they reference
    // the same span of text, so no new from/to needed. We still store
    // empty number[] in the CRDT shape so commentFromMap doesn't bork
    // on missing fields ; the renderer skips anchor decoration for
    // replies.
    const rec: CommentRecord = {
      id: genId(),
      from: [],
      to: [],
      body,
      authorId:    identity?.id ?? 'anon',
      authorName:  identity?.name ?? 'Anonymous',
      authorColor: identity?.color ?? '#888',
      resolved: false,
      ts: Date.now(),
      parentId: rootId,
    };
    ydoc.transact(() => { arr!.push([newCommentMap(rec)]); }, 'comment-reply');
    replyDrafts = { ...replyDrafts, [rootId]: '' };
    replyOpen = null;
  }

  function toggleReplyOpen(id: string) {
    replyOpen = replyOpen === id ? null : id;
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

  // External toggle via toolbar icon — replaces the removed FAB.
  $effect(() => {
    const handler = () => { open = !open; };
    window.addEventListener('weft-loom:toggle-comments', handler);
    return () => window.removeEventListener('weft-loom:toggle-comments', handler);
  });
</script>

{#if visible}
  <div class="comments-panel">
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
            {#each threads as t (t.root.id)}
              <div
                class="comment thread-root"
                class:resolved={t.root.resolved}
                data-testid="comment-entry"
                data-id={t.root.id}
              >
                <button
                  type="button"
                  class="comment-jump"
                  onclick={() => onJump(t.root)}
                  title={resolved[t.root.id] ? 'Jump to anchor' : 'Anchor lost (text deleted)'}
                >
                  <div class="comment-head">
                    <span class="comment-author" style="color: {t.root.authorColor}">{t.root.authorName}</span>
                    <span class="comment-ts">{formatTime(t.root.ts)}</span>
                    {#if t.root.resolved}
                      <span class="badge badge-ghost badge-xs">resolved</span>
                    {/if}
                    {#if !resolved[t.root.id]}
                      <span class="badge badge-warning badge-xs">orphan</span>
                    {/if}
                    {#if t.replies.length > 0}
                      <span class="badge badge-info badge-xs" data-testid="reply-count">
                        {t.replies.length} {t.replies.length === 1 ? 'reply' : 'replies'}
                      </span>
                    {/if}
                  </div>
                  <div class="comment-body">{t.root.body}</div>
                </button>
                {#each t.replies as r (r.id)}
                  <div class="comment reply" data-testid="comment-reply" data-id={r.id}>
                    <div class="comment-head">
                      <span class="comment-author" style="color: {r.authorColor}">{r.authorName}</span>
                      <span class="comment-ts">{formatTime(r.ts)}</span>
                    </div>
                    <div class="comment-body">{r.body}</div>
                    <div class="comment-actions">
                      <button
                        class="btn btn-ghost btn-xs text-error"
                        onclick={() => deleteComment(r.id)}
                        aria-label="Delete reply"
                      >Delete</button>
                    </div>
                  </div>
                {/each}
                {#if replyOpen === t.root.id}
                  <div class="reply-compose" data-testid="reply-compose">
                    <textarea
                      class="textarea textarea-bordered textarea-sm w-full"
                      rows="2"
                      placeholder="Reply…"
                      bind:value={replyDrafts[t.root.id]}
                      data-testid="reply-input"
                    ></textarea>
                    <div class="flex gap-1 mt-1">
                      <button
                        class="btn btn-primary btn-xs"
                        onclick={() => addReply(t.root.id)}
                        disabled={!(replyDrafts[t.root.id] ?? '').trim()}
                        data-testid="reply-send"
                      >Send</button>
                      <button
                        class="btn btn-ghost btn-xs"
                        onclick={() => (replyOpen = null)}
                      >Cancel</button>
                    </div>
                  </div>
                {/if}
                <div class="comment-actions">
                  <button
                    class="btn btn-ghost btn-xs"
                    onclick={() => toggleReplyOpen(t.root.id)}
                    data-testid="reply-toggle"
                  >{replyOpen === t.root.id ? 'Close reply' : 'Reply'}</button>
                  <button
                    class="btn btn-ghost btn-xs"
                    onclick={() => toggleResolved(t.root.id)}
                  >{t.root.resolved ? 'Re-open' : 'Resolve'}</button>
                  <button
                    class="btn btn-ghost btn-xs text-error"
                    onclick={() => deleteComment(t.root.id)}
                  >Delete</button>
                </div>
              </div>
            {/each}
            {#if threads.length === 0}
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
    right: 1rem;
    top: 3rem;
    z-index: 30;
  }
  .comments-popover {
    position: absolute;
    right: 0;
    top: 0;
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
  /* Replies render nested under their root thread with a left rail
     so the visual hierarchy is clear. */
  .comment.reply {
    margin: 0.4rem 0 0 1rem;
    padding: 0.35rem 0.5rem;
    background: rgba(0, 0, 0, 0.02);
    border-left: 2px solid rgba(0, 100, 200, 0.3);
    border-radius: 0 0.3rem 0.3rem 0;
  }
  .reply-compose {
    margin: 0.4rem 0 0 1rem;
    padding: 0.3rem;
    background: rgba(0, 100, 200, 0.04);
    border-radius: 0.3rem;
  }
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
