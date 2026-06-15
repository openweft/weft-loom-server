// wysiwygSpellFilter.ts — keep the browser's native spell-checker
// off LaTeX commands, math nodes, citations, refs, labels, raw
// passthrough spans, images and figure/footnote wrappers, so the
// red squiggle only fires on actual prose inside <p>/<h1..6>/<li>/<td>.
//
// The browser respects spellcheck="false" per-element : marking every
// non-prose node as spellcheck="false" is enough — descendants still
// inherit that and stop being spell-checked. Idempotent ; cheap to
// leave the marks in place.

// Selector list — every LaTeX-shaped or non-prose span the WYSIWYG
// surface renders. Kept in sync with LatexWysiwygEditor.svelte.
const SKIP_SELECTOR =
  '.latex-cite, .latex-ref, .latex-label, .latex-raw, ' +
  '.math-inline, .math-display, .math-env, .katex, ' +
  '.latex-footnote, .latex-figure, img, ' +
  '.latex-theorem-header';

/**
 * Mark every LaTeX-shaped span inside `host` with
 * `spellcheck="false"`. Returns a teardown that removes the
 * attribute from exactly the nodes we marked — useful in tests ;
 * production code can drop the teardown, the marks are harmless.
 */
export function applySpellFilter(host: HTMLElement): () => void {
  const marked: Element[] = [];
  const nodes = host.querySelectorAll(SKIP_SELECTOR);
  nodes.forEach((el) => {
    el.setAttribute('spellcheck', 'false');
    marked.push(el);
  });
  return () => {
    for (const el of marked) {
      el.removeAttribute('spellcheck');
    }
  };
}

/**
 * Wire a MutationObserver on `host` that re-applies `applySpellFilter`
 * whenever new nodes appear in the subtree (remote update, local
 * Insert-math, Insert-citation, paste, …). The re-apply is debounced
 * 100 ms so a flurry of micro-mutations collapses into a single pass.
 * Returns a destroy fn that disconnects the observer + cancels any
 * pending debounce.
 */
export function wireSpellFilter(host: HTMLElement): () => void {
  // Initial sweep — pick up everything already in the tree.
  applySpellFilter(host);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      applySpellFilter(host);
    }, 100);
  };

  const observer = new MutationObserver((records) => {
    // Cheap precheck : only re-run if something actually was added.
    // If a mutation batch is pure attribute changes (e.g. our own
    // setAttribute call), skip — otherwise the observer would loop.
    for (const r of records) {
      if (r.type === 'childList' && r.addedNodes.length > 0) {
        schedule();
        return;
      }
    }
  });
  observer.observe(host, { subtree: true, childList: true });

  return () => {
    observer.disconnect();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
