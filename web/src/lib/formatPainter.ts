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
// Pure-DOM, no Svelte runes, no Yjs. Wire-in is a follow-up on the
// component side.

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
