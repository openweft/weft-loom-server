// ybindingWysiwyg.ts — minimal Yjs ↔ contenteditable two-way binding.
//
// The complement to ybinding.ts (CodeMirror side). Where CodeMirror
// hands us character-level deltas straight out of its transactions,
// a contenteditable surface emits arbitrary DOM mutations (insertions,
// deletions, attribute changes, drag-drop, IME composition…). Mapping
// those to fine-grained Y.Text ops is non-trivial.
//
// V0.1 strategy : observe ALL DOM mutations, debounce 50 ms, and
// emit a wholesale "delete + insert" against Y.Text whenever the
// host's innerHTML differs from ytext.toString(). O(N) per mutation
// burst, simple + provably correct. V0.2 can swap this for an
// incremental diff (e.g. fast-diff) once we've nailed down which
// mutation classes need finer-grained CRDT history.
//
// Feedback-loop protection : transactions we originate are tagged
// with the YORIGIN_LOCAL origin, and remote applies temporarily
// disconnect+reconnect the MutationObserver around the innerHTML
// write so the resulting DOM mutations don't echo back as a
// "local change".
//
// SECURITY : the Y.Text content arrives from PEERS through the
// y-websocket relay. A malicious peer can publish raw HTML like
// `<img src=x onerror=…>` into the CRDT ; without sanitisation the
// host's innerHTML= would execute it. We DOMPurify every write to
// the host AND every Y.Text insert so neither direction smuggles
// script. The active prod editor (LatexWysiwygEditor) uses a
// different model (Y.Text = LaTeX source, parsed locally), but this
// binding stays sanitiser-clean so a future switch can't regress.

import * as Y from 'yjs';
import DOMPurify from 'dompurify';

// Same allowlist shape as WysiwygEditor.svelte's SANITIZE_OPTS :
// keep formatting markup (b/i/u/p/h*/ul/ol/li/span/a) + data-*
// attributes the LaTeX/WYSIWYG round-trip needs, drop everything
// script-y. KEEP_CONTENT preserves text inside disallowed tags so
// peers don't lose words when they paste a bad fragment.
const SANITIZE_OPTS = {
  KEEP_CONTENT: true,
  ALLOW_DATA_ATTR: true,
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
};

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_OPTS) as unknown as string;
}

export const YORIGIN_LOCAL = 'yb-wysiwyg-local';

export interface YjsWysiwygBinding {
  /** Attach observers ; returns a destroy fn. Call once after the
   *  contenteditable has its initial innerHTML set + the Yjs
   *  awareness is wired. */
  attach: (host: HTMLElement) => () => void;
}

export function yjsWysiwygBinding(ytext: Y.Text, ydoc: Y.Doc): YjsWysiwygBinding {
  const attach = (host: HTMLElement): (() => void) => {
    // ── seed phase ──────────────────────────────────────────────
    // Mirror ybinding.ts's seed rules : whichever side is empty
    // adopts the other side's content. If both have content +
    // disagree, the Yjs side wins (it's the canonical CRDT state
    // and the relay's cached buffer is the source of truth across
    // sessions).
    const hostHtml = host.innerHTML;
    if (ytext.length === 0 && hostHtml !== '') {
      ydoc.transact(() => {
        ytext.insert(0, sanitize(hostHtml));
      }, YORIGIN_LOCAL);
    } else if (ytext.length > 0 && hostHtml !== ytext.toString()) {
      host.innerHTML = sanitize(ytext.toString());
    }

    // ── local → remote ──────────────────────────────────────────
    // MutationObserver fires on every DOM tweak inside the surface.
    // We debounce to coalesce bursts (an execCommand can fire 5-10
    // mutations across the subtree) and only push to Y.Text when
    // the resulting innerHTML actually differs from the CRDT state.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const flushLocal = () => {
      debounceTimer = undefined;
      const newHtml = sanitize(host.innerHTML);
      if (newHtml === ytext.toString()) return;
      ydoc.transact(() => {
        if (ytext.length > 0) ytext.delete(0, ytext.length);
        if (newHtml.length > 0) ytext.insert(0, newHtml);
      }, YORIGIN_LOCAL);
    };
    const mo = new MutationObserver(() => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushLocal, 50);
    });
    const startObserving = () => {
      mo.observe(host, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    };
    startObserving();

    // ── remote → local ──────────────────────────────────────────
    // ytext.observe fires for every Y.Text change, local OR remote.
    // We filter on tr.origin === YORIGIN_LOCAL to skip our own
    // applies (otherwise we'd read-back ytext.toString() and stomp
    // on whatever the DOM already has, plus risk caret loss).
    //
    // For remote applies we disconnect the MutationObserver,
    // overwrite innerHTML, then reconnect. Without the disconnect
    // the synthetic mutations from the innerHTML= would queue up,
    // fire after the microtask boundary, and we'd push the same
    // bytes back to ytext under YORIGIN_LOCAL — harmless to CRDT
    // state but it'd churn the relay + show as a phantom edit.
    const yObserver = (_event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.origin === YORIGIN_LOCAL) return;
      const next = sanitize(ytext.toString());
      if (host.innerHTML === next) return;
      mo.disconnect();
      host.innerHTML = next;
      // takeRecords drains any mutations queued between disconnect
      // and the assignment above so they don't leak through on
      // reconnect (the MutationObserver spec keeps a per-observer
      // pending queue even while detached).
      mo.takeRecords();
      startObserving();
    };
    ytext.observe(yObserver);

    return () => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      mo.disconnect();
      ytext.unobserve(yObserver);
    };
  };

  return { attach };
}
