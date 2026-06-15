// diffRender.ts — character-level diff helper for the track-changes
// UI (TrackChangesPanel). Wraps jsdiff's `diffChars` into a stable
// segment shape we control (independent of jsdiff's internal Change
// object) + an HTML renderer that escapes user text and emits one
// <span class="diff-{kind}">…</span> per segment.
//
// Kept deliberately small + framework-free so it's trivially unit
// testable from plain node (see tests/diff-render.mjs). The Svelte
// side only needs renderDiffHtml(diffStrings(before, after)).

import { diffChars } from 'diff';

export interface DiffSegment {
  kind: 'unchanged' | 'added' | 'removed';
  text: string;
}

/** Computes a character-level diff between two strings + returns
 *  segments suitable for inline HTML rendering. */
export function diffStrings(before: string, after: string): DiffSegment[] {
  const parts = diffChars(before ?? '', after ?? '');
  const out: DiffSegment[] = [];
  for (const p of parts) {
    let kind: DiffSegment['kind'];
    if (p.added) kind = 'added';
    else if (p.removed) kind = 'removed';
    else kind = 'unchanged';
    out.push({ kind, text: p.value });
  }
  return out;
}

// escapeHtml : minimal HTML entity escape for safe injection via
// {@html}. We only need the five XML predefined entities ; the
// rendered text comes from arbitrary LaTeX source so it WILL
// contain & < > and possibly quotes.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders the segments as HTML : unchanged = plain, added = green
 *  underline, removed = red strikethrough. Caller sets data-attrs. */
export function renderDiffHtml(segments: DiffSegment[]): string {
  let html = '';
  for (const seg of segments) {
    html += `<span class="diff-${seg.kind}">${escapeHtml(seg.text)}</span>`;
  }
  return html;
}
