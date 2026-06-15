// wysiwygPresence.ts — peer-caret + peer-selection overlay for the
// LatexWysiwygEditor contenteditable surface.
//
// Mirrors what presence.ts does for the CodeMirror source view, but
// for a plain contenteditable host : Yjs Awareness states arrive
// with shape { user: { name, color }, wysiwygSelection?: { startOffset,
// endOffset } } ; we render each remote peer's caret as a thin
// vertical bar absolutely positioned over the host, plus a faint
// colored background for their selection range.
//
// Why a SIBLING overlay layer (not children of the host) :
// contenteditable=true makes every descendant of the host editable.
// Stuffing the caret <span>s inside the host would (a) make them
// targets of the user's own caret + selection, (b) leak peer-name
// pseudo-element text into host.textContent and serializeLatex's
// round-trip, and (c) trip the MutationObserver wired by
// ybindingWysiwyg. The overlay lives as a SIBLING under the same
// parent + uses `pointer-events: none` + absolute positioning over
// the host's bounding rect ; nothing the overlay does perturbs the
// editable content.
//
// Repaint cadence : a single rAF batches awareness 'change' events.
// The host doesn't push paint requests on every keystroke — peers'
// own broadcasts arrive throttled on the wire, and rAF is enough to
// collapse bursts. If the integrating component mutates the host
// content locally (typing, render passes), the next awareness tick
// re-measures ranges against the new DOM ; ranges that don't map
// (peer offset out of bounds because content shrunk) are clamped.
//
// Range computation : peers publish offsets as character offsets
// into host.textContent. We walk Text nodes via TreeWalker, counting
// characters, and stop at the first Text node where the running
// total covers the peer's offset — then build a Range with
// (textNode, offset - cumulative). This handles peers whose offsets
// span paragraph boundaries (different Text nodes) ; the bounding
// rect of a multi-node range is the union, which is what we want
// for the selection highlight.

import type { Awareness } from 'y-protocols/awareness';

export interface PresenceWiring {
  /** Tear down listeners + remove DOM nodes. */
  destroy: () => void;
}

// PeerState : the slice of awareness state we read. Other fields
// (cursor, user.cursorColor, etc.) are ignored — this module only
// owns the WYSIWYG surface.
interface PeerSelection {
  startOffset: number;
  endOffset: number;
}
interface PeerUser {
  name?: string;
  color?: string;
}
interface PeerState {
  user?: PeerUser;
  wysiwygSelection?: PeerSelection;
}

// resolveTextOffset : walks Text nodes inside `root` in document
// order via TreeWalker, returning the (node, offset) pair that
// corresponds to character `target` into root.textContent. Clamps
// to the end of the last Text node if `target` exceeds the total
// text length — so a peer with a stale offset still paints
// somewhere visible instead of throwing.
function resolveTextOffset(
  root: HTMLElement,
  target: number,
): { node: Text; offset: number } | null {
  const safe = Math.max(0, target | 0);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cumulative = 0;
  let lastText: Text | null = null;
  // Walk until we find the text node that contains `safe`.
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    lastText = node;
    const len = node.nodeValue?.length ?? 0;
    if (cumulative + len >= safe) {
      return { node, offset: safe - cumulative };
    }
    cumulative += len;
  }
  if (lastText) {
    return { node: lastText, offset: lastText.nodeValue?.length ?? 0 };
  }
  return null;
}

// buildRange : convert (start, end) char offsets to a DOM Range.
// Returns null if root has no Text nodes (host is empty / only
// element children with no text).
function buildRange(root: HTMLElement, start: number, end: number): Range | null {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const a = resolveTextOffset(root, lo);
  const b = resolveTextOffset(root, hi);
  if (!a || !b) return null;
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return null;
  }
  return range;
}

/**
 * Wire peer-caret + peer-selection rendering into a contenteditable
 * host. Reads Yjs Awareness states + paints each peer's caret as a
 * vertical-bar overlay positioned absolutely over the host, with
 * a tooltip label showing the peer name. Selection ranges get a
 * faint colored background overlay.
 *
 * The host MUST have `position: relative` set so the absolute
 * overlay positions correctly inside it — actually the overlay is
 * appended as a SIBLING of the host (under the same parent) +
 * positioned via the host's getBoundingClientRect, so the host
 * itself doesn't need any positioning context. The parent should
 * be positioned (relative / absolute / fixed) ; if it isn't, the
 * overlay falls back to viewport coordinates which still works as
 * long as the page doesn't scroll between paints.
 *
 * Each awareness 'change' event recomputes everyone's overlay
 * positions ; coalesced to 60 Hz via requestAnimationFrame.
 */
export function wireWysiwygPresence(
  host: HTMLElement,
  awareness: Awareness,
  localClientID: number,
): PresenceWiring {
  // Sibling overlay div. Lives under the same parent as the host so
  // it inherits the same stacking context + scroll container, but
  // sits OUTSIDE the contenteditable boundary so nothing in here is
  // typed-into / selected-into / observed-by the host's mutation
  // observer.
  const overlay = document.createElement('div');
  overlay.className = 'wysiwyg-presence-layer';
  overlay.setAttribute('aria-hidden', 'true');
  const parent = host.parentNode;
  if (parent) {
    parent.insertBefore(overlay, host.nextSibling);
  } else {
    // Host isn't mounted yet : defer append until it is. Caller
    // shouldn't hit this path normally, but we degrade silently.
    document.body.appendChild(overlay);
  }

  // Per-clientID cache of caret + selection DOM nodes so we update
  // in place instead of churning create/remove every paint. Map
  // keyed by clientID ; entries hold both pieces (selection may be
  // null for collapsed carets).
  interface PeerNodes {
    caret: HTMLSpanElement;
    selection: HTMLSpanElement | null;
  }
  const peerNodes = new Map<number, PeerNodes>();

  // removePeer : drop a peer's caret + selection from the overlay
  // and from the cache. Used both on departure (awareness state
  // removed) and on destroy().
  function removePeer(clientID: number) {
    const entry = peerNodes.get(clientID);
    if (!entry) return;
    entry.caret.remove();
    entry.selection?.remove();
    peerNodes.delete(clientID);
  }

  // paint : the single source of truth for the overlay's contents.
  // Walks every awareness state, skips our own + states without a
  // wysiwygSelection, resolves each peer's character offsets back
  // to a DOM Range, measures the range's bounding rects relative
  // to the host's rect, and (re)places the peer's caret +
  // selection elements. Peers that have left awareness get their
  // nodes pruned at the end.
  function paint() {
    const states = awareness.getStates();
    const hostRect = host.getBoundingClientRect();
    const seen = new Set<number>();

    states.forEach((raw, clientID) => {
      if (clientID === localClientID) return;
      const state = raw as PeerState;
      const sel = state.wysiwygSelection;
      if (!sel) return;
      const range = buildRange(host, sel.startOffset, sel.endOffset);
      if (!range) return;

      const user = state.user ?? {};
      const name = user.name ?? `client ${clientID}`;
      const color = user.color ?? 'hsl(0, 0%, 60%)';

      // The caret is anchored at the END of the range (the "head"
      // side, where the user is actively typing). DOM ranges are
      // directionless ; we use endOffset as the head, matching what
      // the CodeMirror presence does with selection.main.head.
      const caretRange = document.createRange();
      const endResolved = resolveTextOffset(host, sel.endOffset);
      if (!endResolved) return;
      caretRange.setStart(endResolved.node, endResolved.offset);
      caretRange.collapse(true);
      const caretRect = caretRange.getBoundingClientRect();
      // Some browsers return a zero-rect for collapsed ranges at
      // certain positions ; fall back to the union range's rect.
      const usableCaret = caretRect.height > 0 ? caretRect : range.getBoundingClientRect();

      let entry = peerNodes.get(clientID);
      if (!entry) {
        const caret = document.createElement('span');
        caret.className = 'wysiwyg-peer-caret';
        entry = { caret, selection: null };
        overlay.appendChild(caret);
        peerNodes.set(clientID, entry);
      }

      // Update caret position + per-peer color. Both the bar and
      // its ::after label drive off --peer-color via CSS.
      entry.caret.setAttribute('data-client-id', String(clientID));
      entry.caret.setAttribute('data-name', name);
      entry.caret.style.setProperty('--peer-color', color);
      entry.caret.style.left = `${usableCaret.left - hostRect.left}px`;
      entry.caret.style.top = `${usableCaret.top - hostRect.top}px`;
      entry.caret.style.height = `${Math.max(usableCaret.height, 12)}px`;

      // Selection rectangles : only emit when the range is non-
      // empty (start != end). getClientRects returns one rect per
      // line-box ; for V0.1 we render a single union rect, which
      // is visually correct for single-line ranges + acceptable
      // for multi-line ranges (whole bounding box highlighted).
      // V0.2 could split into per-rect to match wrapped text.
      if (sel.startOffset !== sel.endOffset) {
        const selRect = range.getBoundingClientRect();
        if (!entry.selection) {
          entry.selection = document.createElement('span');
          entry.selection.className = 'wysiwyg-peer-selection';
          overlay.appendChild(entry.selection);
        }
        entry.selection.style.setProperty('--peer-color', color);
        entry.selection.style.left = `${selRect.left - hostRect.left}px`;
        entry.selection.style.top = `${selRect.top - hostRect.top}px`;
        entry.selection.style.width = `${selRect.width}px`;
        entry.selection.style.height = `${selRect.height}px`;
      } else if (entry.selection) {
        entry.selection.remove();
        entry.selection = null;
      }
      seen.add(clientID);
    });

    // Prune peers that disappeared from awareness OR that have a
    // state but no wysiwygSelection any more (toggled away).
    for (const clientID of Array.from(peerNodes.keys())) {
      if (!seen.has(clientID)) removePeer(clientID);
    }
  }

  // rAF coalescer : awareness 'change' can fire bursts (e.g.
  // initial sync sending every existing peer's state in sequence).
  // We schedule a single repaint per frame.
  let frame = 0;
  function schedulePaint() {
    if (frame) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
    frame = raf(() => {
      frame = 0;
      paint();
    });
  }

  awareness.on('change', schedulePaint);

  // Initial paint : capture peers that were already present when
  // we wired up (e.g. user joined mid-session).
  schedulePaint();

  return {
    destroy() {
      awareness.off('change', schedulePaint);
      if (frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        frame = 0;
      }
      // Clean up every peer's nodes then the overlay itself.
      for (const clientID of Array.from(peerNodes.keys())) removePeer(clientID);
      overlay.remove();
    },
  };
}
