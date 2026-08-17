// presence-collab.ts — remote carets and selections, from a collab session.
//
// It replaces presence.ts and most of it is that file unchanged: painting
// somebody else's caret is the same problem whoever is telling you where they
// are. What changed is who tells you, and the one thing that follows — peers()
// includes this participant, so the self filter is on the session's own site,
// and a site is a string rather than a number.
//
// Today CollaboratorsSidebar shows who's in the room, but the editor
// surface itself has no visual presence : you can't tell where a peer
// is currently typing, what they have selected, or even that they're
// active in this file. This extension fixes that — it watches the
// shared Awareness object (already wired in Editor.svelte) and, for
// every peer state carrying { cursor: { anchor, head } } alongside
// the existing { user: { name, color } }, renders :
//
//   - a thin colored caret bar at `head` (DOM widget)
//   - a label pill floating above the caret with the peer's name
//   - a tinted selection background spanning [min(anchor,head),
//     max(anchor,head)] when the range is non-empty
//
// The local view also publishes its own cursor/selection state into
// awareness every time the selection changes, throttled to 50 ms so
// fast mouse drags don't slam the WS relay. Peers consume that field
// the same way we consume theirs.
//
// CSS lives in app.css under .cm-peer-caret / .cm-peer-caret-label /
// .cm-peer-selection ; the per-peer color is pushed as an inline
// `background-color` / `border-color` style so the stylesheet only
// owns layout + base presentation.

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { watchPeers, type Session } from './collab';

// Throttle helper : trailing-edge throttle, returns a wrapped fn that
// fires at most once per `ms` and queues the latest call so the final
// state always propagates. Used for the local cursor/selection
// broadcaster so we don't flood the relay during burst typing or fast
// drag-selects, while still guaranteeing the very last position lands.
function throttle<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let last = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  const wrapped = ((...args: Parameters<T>) => {
    const now = Date.now();
    lastArgs = args;
    const since = now - last;
    if (since >= ms) {
      last = now;
      fn(...args);
      lastArgs = null;
      return;
    }
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      last = Date.now();
      if (lastArgs) {
        const a = lastArgs;
        lastArgs = null;
        fn(...a);
      }
    }, ms - since);
  }) as T;
  return wrapped;
}

// CaretWidget : a zero-width widget that renders a colored vertical bar
// + an above-the-line label pill. `side: 1` puts the widget after the
// position (CodeMirror inserts it inline between glyphs).
class CaretWidget extends WidgetType {
  constructor(
    readonly site: string,
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  eq(other: CaretWidget): boolean {
    return (
      other.site === this.site &&
      other.name === this.name &&
      other.color === this.color
    );
  }
  toDOM(): HTMLElement {
    // The wrapper is the visible caret bar. The label rides on a
    // ::after pseudo-element driven by CSS `content: attr(data-name)`
    // so it shows up visually but DOESN'T contribute to the parent
    // .cm-line's .textContent — keeps tests + accessibility tooling
    // that read line text from picking up "peer-name" as if it were
    // real document content.
    const wrap = document.createElement('span');
    wrap.className = 'cm-peer-caret';
    wrap.setAttribute('data-client-id', String(this.site));
    wrap.setAttribute('data-name', this.name);
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.borderLeftColor = this.color;
    wrap.style.setProperty('--cm-peer-color', this.color);
    return wrap;
  }
  ignoreEvent(): boolean {
    // Don't swallow mouse events — we want clicks near the caret to
    // place the local cursor exactly there.
    return true;
  }
}

// buildPeerDecorations : reads every remote awareness state, filters
// out our own + states missing a cursor, and emits a DecorationSet
// containing :
//   - one mark per non-empty selection range (.cm-peer-selection)
//   - one widget per caret position (.cm-peer-caret)
// dependency-free. Handles hsl(), hsla(), #RRGGBB ; falls back to a
// CSS color-mix wrapper for anything else.
function withAlpha(c: string, alpha: number): string {
  if (c.startsWith('hsl(') && !c.startsWith('hsla(')) {
    return c.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  }
  if (c.startsWith('hsla(')) return c;
  if (/^#[0-9a-fA-F]{6}$/.test(c)) {
    const a = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, '0');
    return c + a;
  }
  return c;
}

// presenceCursors : public CM6 extension factory. The Editor passes
// the live Awareness instance ; we register :
//   - a ViewPlugin that maintains the DecorationSet for remote peers
//     and listens on awareness 'change' to rebuild it.
//   - an EditorView.updateListener that broadcasts the LOCAL selection
//     into awareness.cursor (throttled to 50 ms), so peers see us too.
function buildPeerDecorations(view: EditorView, session: Session): DecorationSet {
  const docLen = view.state.doc.length;
  const self = session.site;
  interface Entry {
    from: number;
    to: number;
    deco: Decoration;
    // Tiebreak: selections sort before widgets at the same offset so the
    // selection background paints under the caret bar.
    kind: 0 | 1;
  }
  const entries: Entry[] = [];
  for (const peer of session.peers()) {
    if (peer.site === self) continue;
    if (!peer.cursor) continue;
    // Offsets are UTF-16 code units on both sides of this, which is what
    // CodeMirror counts in — nothing to convert.
    const anchor = Math.max(0, Math.min(docLen, peer.cursor.anchor | 0));
    const head = Math.max(0, Math.min(docLen, peer.cursor.head | 0));
    const name = peer.meta?.name ?? `site ${peer.site}`;
    const color = peer.meta?.color ?? 'hsl(0, 0%, 60%)';
    if (anchor !== head) {
      entries.push({
        from: Math.min(anchor, head),
        to: Math.max(anchor, head),
        kind: 0,
        deco: Decoration.mark({
          class: 'cm-peer-selection',
          attributes: {
            style: `background-color: ${withAlpha(color, 0.22)}`,
            'data-client-id': peer.site,
          },
        }),
      });
    }
    entries.push({
      from: head,
      to: head,
      kind: 1,
      deco: Decoration.widget({ widget: new CaretWidget(peer.site, name, color), side: 1 }),
    });
  }
  entries.sort((a, b) => a.from - b.from || a.kind - b.kind);
  const builder = new RangeSetBuilder<Decoration>();
  for (const e of entries) builder.add(e.from, e.to, e.deco);
  return builder.finish();
}

/**
 * presenceCursors paints where everybody else is, and publishes where this
 * participant is.
 *
 * meta travels with every cursor rather than being set once, because a session
 * publishes the two together — there is no "set this field and leave the rest"
 * here, which is a smaller API and one less thing to leave stale.
 */
export function presenceCursors(
  session: Session,
  meta: () => Record<string, string>,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      cleanup: () => void;
      broadcast: (anchor: number, head: number) => void;

      constructor(view: EditorView) {
        this.decorations = buildPeerDecorations(view, session);
        // A peer change can arrive synchronously from inside our own throttled
        // publish, which itself runs inside a CodeMirror update. Dispatching
        // back into the view there throws "Calls to EditorView.update are not
        // allowed while an update is in progress", so the rebuild is deferred
        // to the next frame.
        let pending = false;
        const refresh = () => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            this.decorations = buildPeerDecorations(view, session);
            view.dispatch({});
          });
        };
        let stop: (() => void) | undefined;
        let stopped = false;
        void watchPeers(session, refresh)
          .then((off) => (stopped ? off() : (stop = off)))
          .catch((err) => console.error('collab: watching peers', err));
        this.cleanup = () => {
          stopped = true;
          stop?.();
        };
        this.broadcast = throttle((anchor: number, head: number) => {
          void session.setCursor({ anchor, head }, meta()).catch(() => {
            // A cursor nobody sees is not worth ending a session over.
          });
        }, 50);
        const sel = view.state.selection.main;
        this.broadcast(sel.anchor, sel.head);
      }

      update(u: ViewUpdate) {
        // Peer offsets are not mapped through the edit: their next publish
        // carries their own post-edit offsets, and the clamping above keeps a
        // stale one sane until it arrives.
        if (u.docChanged) {
          this.decorations = buildPeerDecorations(u.view, session);
        }
        if (u.selectionSet || u.docChanged) {
          const sel = u.state.selection.main;
          this.broadcast(sel.anchor, sel.head);
        }
      }

      destroy() {
        this.cleanup();
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [
    plugin,
    EditorView.baseTheme({
      // Selection background — colour applied inline per-peer.
      '.cm-peer-selection': {
        // Background is set inline ; fallback below keeps the highlight
        // visible if the inline style was scrubbed by sanitisation.
        backgroundColor: 'rgba(120, 120, 120, 0.18)',
      },
      // Caret bar : 2 px wide, height of one line, colour from inline.
      '.cm-peer-caret': {
        position: 'relative',
        display: 'inline-block',
        width: '0',
        height: '1em',
        borderLeft: '2px solid hsl(0, 0%, 60%)',
        marginLeft: '-1px',
        verticalAlign: 'text-top',
        pointerEvents: 'none',
      },
      // Floating label pill above the caret.
      '.cm-peer-caret-label': {
        position: 'absolute',
        bottom: '100%',
        left: '-1px',
        padding: '1px 6px',
        borderRadius: '3px 3px 3px 0',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '10px',
        fontWeight: '600',
        lineHeight: '1.2',
        color: 'white',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        pointerEvents: 'none',
        zIndex: '10',
      },
    }),
  ];
}
