// refResolver.ts — auto-numbering for LaTeX cross-references in the
// WYSIWYG body.
//
// `\label{x}` is parsed (latexWysiwyg.ts) into
//   <span class="latex-label" data-label="x">¶</span>
// and `\ref{x}` into
//   <span class="latex-ref" data-label="x">[ref:x]</span>
//
// This module turns the raw `[ref:x]` placeholders into "Eq. (3)",
// "Figure 2", "Section 1.2", etc. — by walking the rendered DOM in
// source order, inferring each label's KIND from its containing
// block (equation / figure / theorem / table / heading / list-item),
// numbering per-kind, then replacing every ref's textContent with
// the looked-up label.
//
// Wiring : LatexWysiwygEditor.svelte should call
//   const labels = buildLabelMap(editorEl);
//   resolveRefs(editorEl, labels);
// after `renderMathNodes` + `renderCiteNodes` + `renderFigureNodes`,
// and again whenever the body mutates (on save, on bib tick, etc.).
//
// V0.1 — flat per-kind counters. V0.2 will add hierarchical
// section numbering ("1.2.3") + per-theorem-variant counters
// (Theorem 1 vs Lemma 1 separately) keyed on the .latex-theorem
// data-env attribute.

export type LabelKind = 'eq' | 'fig' | 'sec' | 'thm' | 'table' | 'item' | 'unknown';

export interface LabelEntry {
  /** Original `data-label` value, e.g. "eq:einstein". */
  label: string;
  /** 1-based index within the kind (eq:1, eq:2, fig:1, ...). */
  index: number;
  /** Inferred kind from the label's containing block. */
  kind: LabelKind;
  /** Pretty-printed reference text, e.g. "Eq. (3)", "Figure 2". */
  text?: string;
}

// ─── label map ───────────────────────────────────────────────────

// Equation environments that get an "Eq. (N)" prefix when labelled.
// Mirrors the list latexWysiwyg.ts recognises as math envs.
const EQ_ENV_NAMES = new Set([
  'equation', 'equation*',
  'align', 'align*',
  'gather', 'gather*',
  'multline', 'multline*',
]);

// buildLabelMap walks every `.latex-label[data-label]` in document
// order, infers its kind by inspecting ancestors, and assigns the
// next 1-based per-kind counter. The returned map is keyed on the
// raw `data-label` string and is consumed by resolveRefs.
export function buildLabelMap(root: HTMLElement): Map<string, LabelEntry> {
  const map = new Map<string, LabelEntry>();
  const counters: Record<LabelKind, number> = {
    eq: 0, fig: 0, sec: 0, thm: 0, table: 0, item: 0, unknown: 0,
  };
  const labels = root.querySelectorAll('.latex-label[data-label]');
  labels.forEach((node) => {
    const el = node as HTMLElement;
    const label = el.getAttribute('data-label') ?? '';
    if (!label) return;
    const kind = inferKind(el);
    // Per-kind 1-based counter — bump BEFORE assigning so "first
    // equation" lands at index 1, not 0.
    counters[kind] += 1;
    const index = counters[kind];
    const entry: LabelEntry = {
      label,
      index,
      kind,
      text: composeText(kind, index, label),
    };
    map.set(label, entry);
  });
  return map;
}

// inferKind walks up the ancestor chain looking for the first block
// the label is nested in. Order matters : the more specific check
// (math-env data-env="equation") comes before the generic ones.
function inferKind(el: HTMLElement): LabelKind {
  for (let cur: HTMLElement | null = el.parentElement; cur; cur = cur.parentElement) {
    // Equation envs : .math.math-env carries data-env identifying
    // which AMS env (equation/align/gather/multline). Anything in
    // EQ_ENV_NAMES counts as an equation label.
    if (cur.classList && cur.classList.contains('math-env')) {
      const env = cur.getAttribute('data-env') ?? '';
      if (EQ_ENV_NAMES.has(env)) return 'eq';
    }
    // Figure env wrapper.
    if (cur.tagName === 'FIGURE' && cur.classList && cur.classList.contains('latex-figure-env')) {
      return 'fig';
    }
    // Theorem-like env wrapper. V0.1 collapses lemma/proof/etc.
    if (cur.classList && cur.classList.contains('latex-theorem')) {
      return 'thm';
    }
    // Tabular table.
    if (cur.tagName === 'TABLE' && cur.classList && cur.classList.contains('latex-tabular')) {
      return 'table';
    }
    // Headings — \section / \subsection / \subsubsection.
    if (cur.tagName === 'H1' || cur.tagName === 'H2' || cur.tagName === 'H3') {
      return 'sec';
    }
    // List items.
    if (cur.tagName === 'LI') {
      return 'item';
    }
  }
  return 'unknown';
}

// composeText prints the human-readable reference text for a kind +
// index pair. "unknown" falls back to the raw label so the ref at
// least carries identifying info (rather than "[N]" with no clue).
function composeText(kind: LabelKind, index: number, label: string): string {
  switch (kind) {
    case 'eq':      return `Eq. (${index})`;
    case 'fig':     return `Figure ${index}`;
    case 'sec':     return `Section ${index}`;
    case 'thm':     return `Theorem ${index}`;
    case 'table':   return `Table ${index}`;
    case 'item':    return `Item ${index}`;
    case 'unknown': return label;
  }
}

// ─── resolve refs ────────────────────────────────────────────────

// resolveRefs walks every `.latex-ref[data-label]` and rewrites its
// textContent to the looked-up label text (e.g. "Eq. (3)"). When
// the label is unknown — typo, deleted label, fwd-ref to a not-yet-
// rendered chunk — falls back to "[ref:label]" so the user can see
// which key is dangling. Sets the `title` attr for hover : "eq: x"
// or "unresolved: x" so debugging is one tooltip away.
export function resolveRefs(root: HTMLElement, labels: Map<string, LabelEntry>): void {
  const refs = root.querySelectorAll('.latex-ref[data-label]');
  refs.forEach((node) => {
    const el = node as HTMLElement;
    const label = el.getAttribute('data-label') ?? '';
    const lookup = labels.get(label);
    if (lookup && lookup.text) {
      el.textContent = lookup.text;
      el.setAttribute('title', `${lookup.kind}: ${label}`);
    } else {
      el.textContent = `[ref:${label}]`;
      el.setAttribute('title', `unresolved: ${label}`);
    }
  });
}
