// sectionFolding.ts — CodeMirror 6 foldService that detects LaTeX
// sectioning commands (\chapter / \section / \subsection / …) AND
// Markdown ATX headings (`#`, `##`, …), then offers fold ranges
// from one heading to the next heading at the same-or-higher level
// (or end of file).
//
// Why this beats Overleaf : Overleaf's editor folds only \begin…
// \end environments — sections stay flat, so collapsing the whole
// Methods chapter while editing Results requires manual marker
// folds. Here every heading is a foldable region by construction.

import { foldService } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';

interface Heading {
  line: number; // 1-based
  level: number; // 0=chapter / h1, 4=paragraph / h5
}

// scanHeadings cache. CodeMirror's foldService is queried once per
// candidate gutter line, so on a 5000-line doc with 80 \section commands
// a single render fires foldFor ~80 times — each call previously walked
// the full document. Cache the result keyed by state.doc (a Text
// instance whose identity is stable until a doc change ; on docChanged
// the EditorState produces a NEW Text and the old entry GCs naturally).
// One cache per (doc, isLatex) pair — same doc rendered in latex vs
// markdown mode would produce different heading sets.
const headingCache = new WeakMap<Text, { latex?: Heading[]; markdown?: Heading[] }>();

const LATEX_RE = /^\s*\\(chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;
const MD_RE = /^\s{0,3}(#{1,6})\s+\S/;

const LATEX_LEVEL: Record<string, number> = {
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
};

function scanHeadings(state: EditorState, isLatex: boolean): Heading[] {
  const doc = state.doc;
  // Cache lookup : same Text identity → same result. Entries auto-GC
  // when the EditorState transitions to a new doc (the old Text
  // becomes unreachable).
  const cached = headingCache.get(doc);
  const key = isLatex ? 'latex' : 'markdown';
  const hit = cached?.[key];
  if (hit) return hit;

  const out: Heading[] = [];
  // Markdown : track fence to skip headings inside code blocks.
  let inFence = false;
  let fenceCh = '';
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (!isLatex) {
      const fence = /^(`{3,}|~{3,})/.exec(text);
      if (fence) {
        if (!inFence) { inFence = true; fenceCh = fence[1][0]; }
        else if (text.startsWith(fenceCh)) inFence = false;
        continue;
      }
      if (inFence) continue;
      const m = MD_RE.exec(text);
      if (m) out.push({ line: i, level: m[1].length - 1 });
    } else {
      const m = LATEX_RE.exec(text);
      if (m) out.push({ line: i, level: LATEX_LEVEL[m[1]] ?? 1 });
    }
  }

  const entry = cached ?? {};
  entry[key] = out;
  headingCache.set(doc, entry);
  return out;
}

function foldFor(state: EditorState, lineFrom: number, _lineTo: number, isLatex: boolean) {
  const headings = scanHeadings(state, isLatex);
  // Find the heading that starts exactly at lineFrom (CodeMirror
  // calls the service with the line-start offset, expecting a
  // {from, to} fold range or null).
  const startLineNumber = state.doc.lineAt(lineFrom).number;
  const idx = headings.findIndex(h => h.line === startLineNumber);
  if (idx < 0) return null;
  const here = headings[idx];
  // End = next heading at the SAME or SHALLOWER level. If none, fold
  // to end of file.
  let endLine = state.doc.lines + 1;
  for (let i = idx + 1; i < headings.length; i++) {
    if (headings[i].level <= here.level) {
      endLine = headings[i].line;
      break;
    }
  }
  // Fold range starts at end-of-heading-line (so the heading itself
  // stays visible when collapsed) and ends at the start of the
  // closing line.
  const from = state.doc.line(startLineNumber).to;
  const to = endLine > state.doc.lines
    ? state.doc.line(state.doc.lines).to
    : state.doc.line(endLine - 1).to;
  if (to <= from) return null;
  return { from, to };
}

// Public extension : returns a foldService that activates for the
// matching language. Wired in Editor.svelte alongside the existing
// foldGutter.
export function sectionFolding(language: string) {
  const isLatex = language === 'latex';
  const isMarkdown = language === 'markdown';
  if (!isLatex && !isMarkdown) return [];
  return [foldService.of((state, lineFrom, lineTo) => foldFor(state, lineFrom, lineTo, isLatex))];
}
