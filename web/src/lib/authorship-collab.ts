// authorship-collab.ts — paints each character with the colour of whoever typed
// it, on top of go-crdt/collab.
//
// It replaces authorship.ts, which walked Yjs internals — `ytext._start`,
// `item.id.client`, `item.right` — and said so itself: "Stable in Yjs 13.x … If
// Yjs ever encapsulates these, switch to ytext.toDelta() with a custom format
// flag." That is a comment about a structure this code was not meant to be
// reading.
//
// collab answers the question instead of being taken apart to find it.
// `authorRuns()` returns the visible text split into stretches by who wrote
// them — `{site, pos, len}`, in UTF-16 code units, which is what CodeMirror
// counts in. No internals, no conversion, and nothing to break when the
// implementation underneath changes.

import { EditorView, Decoration, type DecorationSet, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { watchParts, watchPeers, type Session, type Text } from './collab';

interface User {
  name: string;
  color: string;
}

/**
 * withAlpha turns an HSL string into the same colour at the requested alpha, so
 * the text stays readable over it in both themes. Anything it does not
 * recognise is left alone rather than mangled.
 */
function withAlpha(c: string, alpha: number): string {
  if (c.startsWith('hsl(') && !c.startsWith('hsla(')) {
    return c.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  }
  if (c.startsWith('hsla(')) return c;
  return c;
}

/** The colour to paint a stretch nobody here has ever met. */
const UNKNOWN = 'hsl(0, 0%, 60%)';

export function authorshipExtension(session: Session, text: Text) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private stop: Array<() => void> = [];
      private stopped = false;

      constructor(view: EditorView) {
        this.decorations = this.build(view);

        // One rebuild per change to this part, and one per change to who is
        // here. Rebuilding on the editor's own docChanged as well is what an
        // earlier version did, and it built twice per keystroke.
        const refresh = () => {
          if (!this.stopped) this.decorations = this.build(view);
        };
        void watchParts(session, (parts) => {
          for (const part of parts) {
            if (part.kind === 'text' && part.name === text.name) refresh();
          }
        })
          .then((off) => (this.stopped ? off() : this.stop.push(off)))
          .catch((err) => console.error('collab: authorship', err));
        void watchPeers(session, refresh)
          .then((off) => (this.stopped ? off() : this.stop.push(off)))
          .catch((err) => console.error('collab: authorship peers', err));
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();

        // Who is here, by replica identity. A site nobody is publishing under
        // is somebody who has left, or somebody who wrote this before this tab
        // was opened — both get the same grey, and the same "offline".
        const users = new Map<string, User>();
        for (const peer of session.peers()) {
          const name = peer.meta?.name;
          const color = peer.meta?.color;
          if (name && color) users.set(peer.site, { name, color });
        }

        const docLen = view.state.doc.length;
        for (const run of text.authorRuns()) {
          if (run.pos >= docLen) break;
          const to = Math.min(run.pos + run.len, docLen);
          if (to <= run.pos) continue;
          const user = users.get(run.site);
          builder.add(
            run.pos,
            to,
            Decoration.mark({
              attributes: {
                style: `background-color: ${withAlpha(user?.color ?? UNKNOWN, 0.2)}`,
                title: user ? user.name : `site ${run.site} (offline)`,
              },
            }),
          );
        }
        return builder.finish();
      }

      destroy() {
        this.stopped = true;
        for (const off of this.stop) off();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
