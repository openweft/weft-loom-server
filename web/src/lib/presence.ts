// presence.ts — CodeMirror 6 extension that paints remote peers'
// carets + selections live, driven by the Yjs Awareness map.
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
import type { Awareness } from 'y-protocols/awareness';

// PeerCursor : what we read out of each remote awareness state.
// Offsets are absolute positions in the current Y.Text doc — converted
// back to CodeMirror offsets by clamping against doc.length on every
// rebuild.
interface PeerCursor {
  anchor: number;
  head: number;
}
interface PeerUser {
  name?: string;
  color?: string;
}

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
    readonly clientID: number,
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  eq(other: CaretWidget): boolean {
    return (
      other.clientID === this.clientID &&
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
    wrap.setAttribute('data-client-id', String(this.clientID));
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
// Range entries must be added in offset order ; we collect everything
// then sort before pushing into the RangeSetBuilder.
function buildPeerDecorations(
  view: EditorView,
  awareness: Awareness,
): DecorationSet {
  const docLen = view.state.doc.length;
  const selfID = awareness.clientID;
  interface Entry {
    from: number;
    to: number;
    deco: Decoration;
    // tiebreak — selections sort before widgets at the same offset
    // so the selection background paints under the caret bar.
    kind: 0 | 1;
  }
  const entries: Entry[] = [];
  awareness.getStates().forEach((state, clientID) => {
    if (clientID === selfID) return;
    const s = state as { user?: PeerUser; cursor?: PeerCursor };
    const cursor = s.cursor;
    if (!cursor) return;
    const anchor = Math.max(0, Math.min(docLen, cursor.anchor | 0));
    const head = Math.max(0, Math.min(docLen, cursor.head | 0));
    const user = s.user ?? {};
    const name = user.name ?? `client ${clientID}`;
    const color = user.color ?? 'hsl(0, 0%, 60%)';
    // Selection range (only when non-empty).
    if (anchor !== head) {
      const from = Math.min(anchor, head);
      const to = Math.max(anchor, head);
      entries.push({
        from,
        to,
        kind: 0,
        deco: Decoration.mark({
          class: 'cm-peer-selection',
          attributes: {
            style: `background-color: ${withAlpha(color, 0.22)}`,
            'data-client-id': String(clientID),
          },
        }),
      });
    }
    // Caret widget at head.
    entries.push({
      from: head,
      to: head,
      kind: 1,
      deco: Decoration.widget({
        widget: new CaretWidget(clientID, name, color),
        side: 1,
      }),
    });
  });
  entries.sort((a, b) => a.from - b.from || a.to - b.to || a.kind - b.kind);
  const builder = new RangeSetBuilder<Decoration>();
  for (const e of entries) builder.add(e.from, e.to, e.deco);
  return builder.finish();
}

// withAlpha : same shape as authorship.ts but local to keep the module
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
export function presenceCursors(awareness: Awareness): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      cleanup: () => void;
      // The throttled local broadcaster — closure-captured by the
      // updateListener below so we don't re-wrap on every update.
      broadcast: (anchor: number, head: number) => void;

      constructor(view: EditorView) {
        this.decorations = buildPeerDecorations(view, awareness);
        // Awareness 'change' can fire SYNCHRONOUSLY from inside our own
        // throttled broadcast — which itself runs inside a CM update.
        // Dispatching back into the view there throws
        // "Calls to EditorView.update are not allowed while an update
        // is in progress". Defer via requestAnimationFrame so the
        // rebuild lands on the next tick.
        let pending = false;
        const refresh = () => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            this.decorations = buildPeerDecorations(view, awareness);
            view.dispatch({});
          });
        };
        awareness.on('change', refresh);
        this.cleanup = () => awareness.off('change', refresh);
        this.broadcast = throttle((anchor: number, head: number) => {
          awareness.setLocalStateField('cursor', { anchor, head });
        }, 50);
        // Push initial cursor so peers see us the moment we mount.
        const sel = view.state.selection.main;
        this.broadcast(sel.anchor, sel.head);
      }

      update(u: ViewUpdate) {
        // When the doc changes we map peer offsets implicitly by
        // rebuilding from awareness — peers' next broadcast will
        // include their own post-edit offsets ; until then, the
        // clamping in buildPeerDecorations keeps stale offsets sane.
        if (u.docChanged) {
          this.decorations = buildPeerDecorations(u.view, awareness);
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
    {
      decorations: (v) => v.decorations,
    },
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
