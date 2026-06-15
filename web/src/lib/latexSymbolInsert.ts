// latexSymbolInsert — bridge between the LatexSymbolPalette and the
// WYSIWYG contenteditable surface. The palette already routes into
// CodeMirror via window.weftLoomInsertAtCursor (see Editor.svelte) ;
// when the focused editor is the WYSIWYG surface instead, we need a
// DOM-native insert that respects the live Selection + fires an
// 'input' event so the parent's autosave timer picks the change up.
//
// Pure DOM, no framework deps. Used by LatexSymbolPalette.svelte.

export function insertAtContenteditableCaret(el: HTMLElement, snippet: string): void {
  el.focus();

  const win = el.ownerDocument?.defaultView ?? window;
  const sel = win.getSelection();

  // Decide where to drop the text. If the live selection has a range
  // inside `el`, splice there. Otherwise (focus elsewhere, no caret,
  // or a stale range), park the caret at the end of `el` and insert.
  let range: Range | null = null;
  if (sel && sel.rangeCount > 0) {
    const candidate = sel.getRangeAt(0);
    if (el.contains(candidate.commonAncestorContainer)) {
      range = candidate;
    }
  }
  if (!range) {
    range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // end of el
  }

  // Replace any selected text + drop a TextNode (NOT innerHTML — we
  // don't want raw \alpha sequences to be misinterpreted as markup).
  range.deleteContents();
  const textNode = el.ownerDocument.createTextNode(snippet);
  range.insertNode(textNode);

  // Caret to the end of the inserted text.
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Notify contenteditable consumers (oninput in LatexWysiwygEditor
  // schedules the autosave). InputEvent bubbles by default in the
  // spec but we set it explicitly for clarity.
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

// resolveWysiwygTarget — if `document.activeElement` is (or is inside)
// a `.latex-wysiwyg-surface`, return that surface ; else null. Lets
// the palette pick a target without hard-coding querySelector hits.
export function resolveWysiwygTarget(doc: Document = document): HTMLElement | null {
  const active = doc.activeElement;
  if (!active) return null;
  if (active instanceof HTMLElement && active.classList.contains('latex-wysiwyg-surface')) {
    return active;
  }
  const surface = active.closest?.('.latex-wysiwyg-surface');
  return surface instanceof HTMLElement ? surface : null;
}
