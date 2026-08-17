// minimal-edit.ts — the smallest single replacement turning one string into
// another.
//
// # Why this exists
//
// The WYSIWYG surface serialises its whole contenteditable back to LaTeX after
// every edit, so what it has to offer a CRDT is two whole documents rather than
// a keystroke. Its Yjs version wrote the difference as `delete(0, length)`
// followed by `insert(0, source)` — every character in the document removed and
// re-added, on every edit.
//
// That was survivable when the document lived in memory for as long as the tab
// did. It is not survivable now: the operations are persisted, so a keystroke in
// a three-thousand-character file would leave three thousand tombstones behind
// and cost three thousand operations to apply, on every replica, forever.
//
// It also destroyed something. The module that logged track-changes said so:
// "every local edit does a whole-doc replace, which overwrites Yjs's
// per-character item.id.client history, so the source-walking trick returns
// 'the last author who saved' for the whole document". Writing only what
// changed gives per-character authorship back for free.
//
// # Why one replacement and not a diff
//
// A real diff would find several disjoint edits and write each. This finds the
// common prefix and the common suffix and replaces what is between them, which
// is one edit. For a person typing — which is what produces these two strings —
// that is the same answer a diff would give, and for a paste or a reformat it
// is a superset that is still bounded by the change rather than by the file.
//
// # Surrogate pairs
//
// Offsets here are UTF-16 code units, which is what the DOM counts in and what
// collab takes. A prefix length measured that way can land between the two
// halves of an astral character — an emoji, a mathematical symbol — and collab
// refuses such an offset rather than rounding it, which is the right thing for
// it to do and something this has to not ask for. Both boundaries are moved
// outwards onto a code point when they land inside one.

/** A single replacement: remove `removed` code units at `pos`, put `insert` there. */
export interface Edit {
  pos: number;
  removed: number;
  insert: string;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Whether `at` falls between the two halves of a surrogate pair in `s`. */
function splitsAPair(s: string, at: number): boolean {
  if (at <= 0 || at >= s.length) return false;
  return isHighSurrogate(s.charCodeAt(at - 1)) && isLowSurrogate(s.charCodeAt(at));
}

/**
 * minimalEdit returns the one replacement that turns `before` into `after`, or
 * undefined when they are already the same.
 */
export function minimalEdit(before: string, after: string): Edit | undefined {
  if (before === after) return undefined;

  // The common prefix, then backed off if it landed inside a character.
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (splitsAPair(before, start) || splitsAPair(after, start)) start--;

  // The common suffix, measured from both ends and never crossing the prefix.
  let end = 0;
  const room = Math.min(before.length - start, after.length - start);
  while (
    end < room &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end++;
  }
  if (splitsAPair(before, before.length - end) || splitsAPair(after, after.length - end)) end--;

  return {
    pos: start,
    removed: before.length - end - start,
    insert: after.slice(start, after.length - end),
  };
}
