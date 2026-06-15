// editorVisibilityCheck.ts — CodeMirror 6 ViewPlugin that detects
// the "doc has content but the editor area is visually empty"
// failure mode + surfaces it in the console + via a custom DOM
// event other parts of the SPA can listen to.
//
// Symptoms it catches :
//   - Foreground colour ≈ background colour (theme misconfig,
//     a daisyUI rename that purged the editor text colour, a
//     VSCode theme load that set editor.foreground = the bg)
//   - The document has length > 0 + line numbers render +
//     minimap renders, but `.cm-content` renders zero glyphs
//     (height = 0, or all .cm-line elements clipped)
//
// What it does NOT do : evaluate per-token highlight visibility
// (would need to walk every line — too costly per keystroke). The
// base colour check is the dominant signal in practice ; any token
// that overrides the base is by definition a different colour, so
// if base passes the contrast check, tokens almost always do too.
//
// Signals emitted :
//   - console.warn('[editor-visibility] …', diagnosticObject)
//   - window.dispatchEvent(new CustomEvent('weft-loom:editor-invisible', { detail }))
//   - sets `data-weft-loom-invisible="1"` on the .cm-editor root so
//     CSS selectors / Puppeteer tests can react without listening
//     to the event.
//
// Re-evaluated on viewport change + once 100 ms after mount (gives
// the lang pack a chance to load + theme to apply).

import { ViewPlugin, type ViewUpdate, type EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

// luminanceFor : sRGB relative luminance per WCAG 2.0.
function luminanceFor(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// contrastRatio : WCAG contrast ratio between two RGB triples ;
// 1.0 = identical, 21.0 = black on white.
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = luminanceFor(a);
  const lb = luminanceFor(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// parseRGB : parse `rgb(R, G, B)` / `rgba(R, G, B, A)` strings into
// a [R, G, B] triple. Returns null when the string is "transparent"
// or unparseable — the caller should walk up the cascade looking
// for an opaque ancestor.
function parseRGB(s: string): [number, number, number] | null {
  if (!s || s === 'transparent' || s === 'rgba(0, 0, 0, 0)') return null;
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

// effectiveBackgroundOf : walk up the DOM until we find an ancestor
// with a non-transparent background-color. `.cm-content` inherits
// "transparent" from the editor theme, so the actual paint colour
// lives further up (typically `.cm-editor` or the daisyUI base).
function effectiveBackgroundOf(el: Element | null): [number, number, number] | null {
  let cur: Element | null = el;
  while (cur) {
    const bg = parseRGB(getComputedStyle(cur).backgroundColor);
    if (bg) return bg;
    cur = cur.parentElement;
  }
  return null;
}

// Threshold for "indistinguishable" — WCAG-AA text demands 4.5 ;
// 2.0 catches the truly broken cases without false-positive on
// low-contrast-but-readable themes.
const MIN_CONTRAST = 2.0;

interface Diagnostic {
  fg: string;
  bg: string;
  contrast: number;
  docLength: number;
  lineCount: number;
  contentHeight: number;
  reason: 'low-contrast' | 'zero-paint';
}

// check returns null when the editor is healthy or a Diagnostic
// describing the symptom otherwise. Pure read-only — never mutates
// view state.
function check(view: EditorView): Diagnostic | null {
  // Doc with no content is not an editor-visibility bug, just an
  // empty file. Bail out so we don't false-alarm on fresh untitled
  // tabs the user hasn't typed into yet.
  const docLength = view.state.doc.length;
  if (docLength === 0) return null;

  const contentEl = view.contentDOM;
  const editorEl = view.dom;

  // Pick the first .cm-line for the foreground sample. The widget
  // we'd want to read from is the actual text node, but
  // getComputedStyle on a text node returns the parent's style ;
  // sampling the .cm-line itself is equivalent.
  const firstLine = contentEl.querySelector('.cm-line');
  if (!firstLine) return null; // editor not laid out yet

  const fg = parseRGB(getComputedStyle(firstLine).color);
  if (!fg) return null; // colour parser couldn't read — give up quietly

  const bg = effectiveBackgroundOf(editorEl) ?? [255, 255, 255];

  const contentRect = contentEl.getBoundingClientRect();

  // Zero-paint check : doc has content, line numbers render (we
  // know the viewport is initialised), but cm-content has no
  // measurable height. Hidden-by-CSS regression.
  if (contentRect.height === 0) {
    return {
      fg: `rgb(${fg.join(', ')})`,
      bg: `rgb(${bg.join(', ')})`,
      contrast: contrastRatio(fg, bg),
      docLength,
      lineCount: view.state.doc.lines,
      contentHeight: contentRect.height,
      reason: 'zero-paint',
    };
  }

  // Low-contrast check : the dominant cause of "doc populated,
  // editor visually empty".
  const ratio = contrastRatio(fg, bg);
  if (ratio < MIN_CONTRAST) {
    return {
      fg: `rgb(${fg.join(', ')})`,
      bg: `rgb(${bg.join(', ')})`,
      contrast: ratio,
      docLength,
      lineCount: view.state.doc.lines,
      contentHeight: contentRect.height,
      reason: 'low-contrast',
    };
  }
  return null;
}

// emit logs + dispatches + marks the editor DOM root. Called from
// the ViewPlugin when a regression is detected. Throttled via a
// per-view flag so we don't spam every viewport update.
function emit(view: EditorView, d: Diagnostic): void {
  console.warn(
    '[editor-visibility] document is populated but the content area is unreadable',
    d,
  );
  try {
    window.dispatchEvent(new CustomEvent('weft-loom:editor-invisible', { detail: d }));
  } catch {
    /* no window in tests : ignore */
  }
  view.dom.setAttribute('data-weft-loom-invisible', '1');
}

// clear removes the marker once the editor recovers (theme switch,
// content typed, etc.). Mirrors emit() so a Puppeteer assertion
// can use `expect(...).not.toHaveAttribute('data-weft-loom-invisible')`
// across a recovery scenario.
function clear(view: EditorView): void {
  if (view.dom.hasAttribute('data-weft-loom-invisible')) {
    view.dom.removeAttribute('data-weft-loom-invisible');
    try {
      window.dispatchEvent(new CustomEvent('weft-loom:editor-visible'));
    } catch { /* ignore */ }
  }
}

// visibilityCheckExtension : the CM6 extension to plug into the
// Editor.svelte extension stack. Cheap : one getComputedStyle pair
// + one luminance calc per check ; gated on viewportChanged so the
// per-keystroke cost is zero unless the viewport actually re-laid.
export function visibilityCheckExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      private lastCheckAt = 0;
      // Minimum interval between checks ; throttles bursts where
      // many small viewport updates fire in sequence.
      private readonly MIN_INTERVAL_MS = 200;

      constructor(view: EditorView) {
        // First check 200 ms after mount — gives the language pack
        // dynamic-import + the theme apply a chance to land before
        // we sample colours.
        setTimeout(() => this.maybeCheck(view), 200);
      }

      update(u: ViewUpdate) {
        if (!u.viewportChanged && !u.docChanged && !u.geometryChanged) return;
        this.maybeCheck(u.view);
      }

      private maybeCheck(view: EditorView) {
        const now = performance.now();
        if (now - this.lastCheckAt < this.MIN_INTERVAL_MS) return;
        this.lastCheckAt = now;
        const d = check(view);
        if (d) {
          emit(view, d);
        } else {
          clear(view);
        }
      }
    },
  );
}
