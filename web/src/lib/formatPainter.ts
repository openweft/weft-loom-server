// formatPainter.ts — Word-style Format Painter for the LatexWysiwyg
// contenteditable surface.
//
// Two-step UX :
//   1. Operator picks a sample by clicking the brush, then selecting
//      (or just placing the caret in) some formatted text. The host
//      calls snapshotFormatting(getSelection()) and stashes the
//      returned FormatSnapshot.
//   2. On the NEXT selection, the host calls applyFormatting(...) to
//      replay the same marks onto the new range.
//
// We piggyback on document.execCommand so the formatting matches what
// the existing B/I/U/H1/H2/H3 toolbar already produces — same DOM
// shape (<strong>/<em>/<u>/<h1>...), same undo entries, same
// round-trip through latexWysiwyg.ts. `code` has no native exec verb
// so we manually wrap the range in a <code>.
//
// Yjs integration : when armed, the operator's painter advertises
// itself on the Y.Awareness map under the `formatPainter` field
// (shape : FormatSnapshot or null). Peers render a faint paint-bucket
// badge near the originator's caret via wirePeerFormatPainters() so
// "alice is about to paint a heading" is visible in real time —
// mirrors how wysiwygPresence renders peer carets. The marker
// disappears the moment the originator applies (snap = null).

export interface FormatSnapshot {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  code: boolean;     // true if the selection is inside a <code>
  heading: 0 | 1 | 2 | 3;  // 0 = no heading
}

const EMPTY: FormatSnapshot = {
  bold: false,
  italic: false,
  underline: false,
  code: false,
  heading: 0,
};

// Walks up from `node` looking for any element whose tagName matches
// one of the supplied tags. Stops at the document root or `stopAt`.
// Returns the first match (case-insensitive), null otherwise.
function closestTag(node: Node | null, tags: string[]): Element | null {
  let cur: Node | null = node;
  const set = new Set(tags.map((t) => t.toUpperCase()));
  while (cur) {
    if (cur.nodeType === 1 /* ELEMENT_NODE */) {
      const el = cur as Element;
      if (set.has(el.tagName.toUpperCase())) return el;
    }
    cur = cur.parentNode;
  }
  return null;
}

/** Read the current Selection's formatting state. Walks up the DOM
 *  from sel.anchorNode looking for <strong>/<em>/<u>/<code>/<h1-3>
 *  ancestors. Returns all-zero when nothing's selected. */
export function snapshotFormatting(sel: Selection | null): FormatSnapshot {
  if (!sel || sel.rangeCount === 0) return { ...EMPTY };
  const anchor = sel.anchorNode;
  if (!anchor) return { ...EMPTY };

  // We also accept <b>/<i> in case the source HTML uses the older
  // tag flavors — the parseLatex output sticks to <strong>/<em> but
  // the browser sometimes synthesizes <b>/<i> when pasting.
  const bold = closestTag(anchor, ['STRONG', 'B']) != null;
  const italic = closestTag(anchor, ['EM', 'I']) != null;
  const underline = closestTag(anchor, ['U']) != null;
  const code = closestTag(anchor, ['CODE']) != null;

  let heading: 0 | 1 | 2 | 3 = 0;
  const h = closestTag(anchor, ['H1', 'H2', 'H3']);
  if (h) {
    if (h.tagName === 'H1') heading = 1;
    else if (h.tagName === 'H2') heading = 2;
    else if (h.tagName === 'H3') heading = 3;
  }

  return { bold, italic, underline, code, heading };
}

// Wraps the current selection's range contents in a <code>. Returns
// true if it produced a mutation, false if the range was collapsed
// (we don't wrap empty selections — would orphan an empty <code>).
function wrapInCode(sel: Selection): boolean {
  if (sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return false;
  // Already inside a <code> ? skip.
  if (closestTag(range.commonAncestorContainer, ['CODE'])) return false;
  const code = (range.startContainer.ownerDocument ?? document).createElement('code');
  try {
    code.appendChild(range.extractContents());
    range.insertNode(code);
  } catch {
    // extractContents can throw on weird boundary cases (e.g.
    // crossing a non-editable block). Swallow + report no-op so
    // the rest of applyFormatting still runs its execCommand calls.
    return false;
  }
  // Restore the selection over the freshly wrapped node so chained
  // exec calls (bold/italic/...) still target the same content.
  const fresh = (sel.anchorNode?.ownerDocument ?? document).createRange();
  fresh.selectNodeContents(code);
  sel.removeAllRanges();
  sel.addRange(fresh);
  return true;
}

/** Apply a snapshot to the current Selection by issuing the matching
 *  document.execCommand calls (bold, italic, underline, formatBlock).
 *  For 'code' wraps in a <code> manually (execCommand has no native
 *  code command). NO-OP when the selection is empty.
 *
 *  Returns true if any mutation happened.
 */
export function applyFormatting(sel: Selection | null, snap: FormatSnapshot): boolean {
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  // Headings legitimately target a collapsed caret (formatBlock
  // promotes the whole containing block). Inline marks require a
  // non-empty range — execCommand('bold') on a collapsed selection
  // just toggles "future typing" state, which would silently no-op
  // from the painter's POV. Bail on collapsed unless we have a
  // heading to apply.
  if (range.collapsed && snap.heading === 0) return false;

  let mutated = false;

  if (snap.bold) {
    document.execCommand('bold', false);
    mutated = true;
  }
  if (snap.italic) {
    document.execCommand('italic', false);
    mutated = true;
  }
  if (snap.underline) {
    document.execCommand('underline', false);
    mutated = true;
  }
  if (snap.code) {
    if (wrapInCode(sel)) mutated = true;
  }
  if (snap.heading > 0) {
    document.execCommand('formatBlock', false, 'h' + snap.heading);
    mutated = true;
  }

  return mutated;
}

// ─── Yjs awareness integration ────────────────────────────────────────
//
// Awareness field name : `formatPainter`. Value shape :
//
//   null                 — the peer's painter is idle.
//   FormatSnapshot       — the peer is armed ; the snapshot is the
//                          formatting they captured + will apply on
//                          their next selection.
//
// The originator publishes via painterMeta. Peers render
// via wirePeerFormatPainters — same module shape as wysiwygPresence
// (overlay sibling div, rAF-coalesced paint, returns destroy()).

import { watchPeers, type Session } from './collab';

/** The meta key a peer's armed painter travels under. */
export const PAINTER_KEY = 'formatPainter';

/**
 * How a painter snapshot is carried between replicas.
 *
 * A session publishes meta as strings, so the snapshot is JSON rather than an
 * object — which it effectively was already: awareness payloads were cloned on
 * the wire, and the field never held anything a JSON round-trip would lose.
 *
 * An unarmed painter publishes no key at all rather than a null one. A peer
 * reading it asks whether the key is there, which is the question it was
 * already asking, and one less state to represent.
 */
export function painterMeta(snap: FormatSnapshot | null): Record<string, string> {
  return snap ? { [PAINTER_KEY]: JSON.stringify(snap) } : {};
}

/** Reads a peer's painter back, or undefined when they are not holding one. */
export function painterOf(meta: Record<string, string> | undefined): FormatSnapshot | undefined {
  const raw = meta?.[PAINTER_KEY];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as FormatSnapshot;
  } catch {
    // A snapshot this build cannot read is a peer without a badge, not a
    // paint that throws.
    return undefined;
  }
}

// Snapshot label : short human-readable summary of what the painter
// will apply. Rendered in the badge tooltip.
function describeSnap(snap: FormatSnapshot): string {
  const parts: string[] = [];
  if (snap.heading > 0) parts.push('H' + snap.heading);
  if (snap.bold) parts.push('B');
  if (snap.italic) parts.push('I');
  if (snap.underline) parts.push('U');
  if (snap.code) parts.push('Code');
  return parts.length ? parts.join('+') : 'plain';
}

export interface PainterPresenceWiring {
  destroy: () => void;
}

// resolveCaretRect : find the (Range) bounding rect for character
// offset `target` inside `host`. Mirrors wysiwygPresence's
// resolveTextOffset — we re-implement here to keep formatPainter a
// self-contained module (wysiwygPresence isn't exporting its
// internals).
function resolveCaretRect(host: HTMLElement, target: number): DOMRect | null {
  const safe = Math.max(0, target | 0);
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let cumulative = 0;
  let lastText: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    lastText = n;
    const len = n.nodeValue?.length ?? 0;
    if (cumulative + len >= safe) {
      const range = document.createRange();
      try {
        range.setStart(n, safe - cumulative);
        range.collapse(true);
      } catch {
        return null;
      }
      const r = range.getBoundingClientRect();
      if (r.height > 0) return r;
      // Some browsers return a zero-rect for collapsed ranges at
      // certain positions ; fall back to a tiny rect at the node's
      // first client rect so the badge still anchors visibly.
      const rects = (n.parentElement ?? host).getClientRects();
      return rects[0] ?? null;
    }
    cumulative += len;
  }
  if (lastText) {
    const range = document.createRange();
    try {
      range.setStart(lastText, lastText.nodeValue?.length ?? 0);
      range.collapse(true);
      const r = range.getBoundingClientRect();
      if (r.height > 0) return r;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Wire peer-format-painter badges over a contenteditable host.
 * Reads the `formatPainter` field on each remote awareness state +
 * paints a 🎨 badge anchored at the peer's caret (via
 * `wysiwygSelection.endOffset`) for as long as they're armed.
 *
 * Lives as a SIBLING overlay under the host's parent, same shape
 * as wireWysiwygPresence — the two layers stack without conflict
 * (different class names) and share the same rAF cadence in spirit
 * (each schedules its own frame ; awareness 'change' fires both).
 */
export function wirePeerFormatPainters(
  host: HTMLElement,
  session: Session,
): PainterPresenceWiring {
  const overlay = document.createElement('div');
  overlay.className = 'wysiwyg-painter-layer';
  overlay.setAttribute('aria-hidden', 'true');
  const parent = host.parentNode;
  if (parent) {
    parent.insertBefore(overlay, host.nextSibling);
  } else {
    document.body.appendChild(overlay);
  }

  // Per-peer badge cache. Each entry is a single <span> ; we recolor
  // + reposition in place to avoid create/remove churn.
  // Keyed by replica identity, which is a string.
  const peerBadges = new Map<string, HTMLSpanElement>();

  function removePeer(clientID: string) {
    const el = peerBadges.get(clientID);
    if (!el) return;
    el.remove();
    peerBadges.delete(clientID);
  }

  function paint() {
    const hostRect = host.getBoundingClientRect();
    const seen = new Set<string>();

    for (const peer of session.peers()) {
      const clientID = peer.site;
      if (clientID === session.site) continue;
      const snap = painterOf(peer.meta);
      if (!snap) continue; // peer's painter idle
      // Anchor at the peer's caret, which is the head of what they published.
      const caretRect = resolveCaretRect(host, peer.cursor.head);
      if (!caretRect) continue;

      const color = peer.meta?.color ?? 'hsl(0, 0%, 60%)';
      const name = peer.meta?.name ?? `site ${clientID}`;
      const label = `${name} : ${describeSnap(snap)}`;

      let badge = peerBadges.get(clientID);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'wysiwyg-peer-painter';
        overlay.appendChild(badge);
        peerBadges.set(clientID, badge);
      }
      badge.textContent = '🎨';
      badge.setAttribute('data-client-id', String(clientID));
      badge.setAttribute('data-label', label);
      badge.setAttribute('title', label);
      badge.style.setProperty('--peer-color', color);
      // Anchor the badge just above + right of the caret so it
      // doesn't overlap the caret bar wysiwygPresence already paints
      // at the same spot.
      badge.style.left = `${caretRect.left - hostRect.left + 4}px`;
      badge.style.top = `${caretRect.top - hostRect.top - 4}px`;
      seen.add(clientID);
    }

    for (const clientID of Array.from(peerBadges.keys())) {
      if (!seen.has(clientID)) removePeer(clientID);
    }
  }

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

  let unwatch: (() => void) | undefined;
  let stopped = false;
  void watchPeers(session, schedulePaint)
    .then((off) => (stopped ? off() : (unwatch = off)))
    .catch((err) => console.error('collab: peer painters', err));
  schedulePaint();

  return {
    destroy() {
      stopped = true;
      unwatch?.();
      if (frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        frame = 0;
      }
      for (const clientID of Array.from(peerBadges.keys())) removePeer(clientID);
      overlay.remove();
    },
  };
}
