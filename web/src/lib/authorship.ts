// authorship.ts — CodeMirror 6 extension that paints each character's
// background with the color of the user who typed it. Reads the Yjs
// Y.Text internal structure (item.id.client) to attribute every run
// of characters to a clientID, then looks up the user.color from the
// Yjs awareness state (the same map CollaboratorList consumes).
//
// Two states :
//   - off       : extension returns no decorations ; editor renders
//                  with the normal CodeMirror theme.
//   - on        : every character gets a `background-color: <user>33`
//                  decoration (20 % alpha so the foreground text stays
//                  readable in both light + dark themes).
//
// Toggled at runtime via a Compartment from Editor.svelte ; the wire
// up is one button in the navbar that posts "revision mode on/off"
// through a callback.
//
// Uses Yjs internals (ytext._start, item.right, item.length,
// item.id.client). Stable in Yjs 13.x ; y-codemirror.next itself
// walks the same chain to apply deltas. If Yjs ever encapsulates
// these, switch to ytext.toDelta() with a custom format flag.

import { EditorView, Decoration, type DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

interface User {
  name: string;
  color: string;
}

// withAlpha turns an HSL string ("hsl(200, 70%, 50%)") into the
// corresponding HSLA at the requested alpha. Falls back to a hardcoded
// pastel when the parser doesn't recognise the shape.
function withAlpha(c: string, alpha: number): string {
  if (c.startsWith('hsl(') && !c.startsWith('hsla(')) {
    return c.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  }
  if (c.startsWith('hsla(')) return c;
  // Hex or named color — let the browser handle it via rgba() with
  // a wrapping span (caller passes through).
  return c;
}

// readAuthorship walks the Y.Text item chain and emits the
// (from, to, clientID) triplets the decorator turns into background
// marks. Skips deleted items (Yjs keeps tombstones in the chain).
function readAuthorship(ytext: Y.Text): Array<{ from: number; to: number; clientID: number }> {
  const out: Array<{ from: number; to: number; clientID: number }> = [];
  // _start is an internal Yjs field. y-codemirror.next uses the
  // same one ; stable across the Yjs 13.x line we ship. The cast
  // through `any` (rather than @ts-expect-error) keeps the
  // directive from going stale if Yjs's types ever expose this.
  let item: any = (ytext as any)._start;
  let offset = 0;
  while (item) {
    if (!item.deleted) {
      const len = item.length as number;
      if (len > 0) {
        out.push({
          from: offset,
          to: offset + len,
          clientID: item.id.client as number,
        });
        offset += len;
      }
    }
    item = item.right;
  }
  return out;
}

export function authorshipExtension(ytext: Y.Text, awareness: Awareness) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      cleanupYjs: () => void;
      cleanupAwareness: () => void;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
        // ytext.observe is the single source of truth — it fires for
        // BOTH local edits (routed through ybinding's ydoc.transact)
        // and remote edits. The previous implementation also rebuilt
        // on update.docChanged, which produced two builds per keystroke.
        // We also dropped a `view.dispatch({})` no-op that used to
        // chase its own tail : ViewPlugin's `provide(v => v.decorations)`
        // contract already re-renders when `this.decorations` is
        // reassigned, so the dispatch only generated another update
        // cycle without changing the output.
        const refresh = () => {
          this.decorations = this.build(view);
        };
        ytext.observe(refresh);
        this.cleanupYjs = () => ytext.unobserve(refresh);
        // awareness.on('change') fires when a peer joins / leaves /
        // updates their colour. We rebuild so the freshly-known author
        // gets a colour instead of the grey fallback.
        awareness.on('change', refresh);
        this.cleanupAwareness = () => awareness.off('change', refresh);
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        // userMap : clientID → user.color via awareness states.
        const userMap = new Map<number, User>();
        awareness.getStates().forEach((state, clientID) => {
          const u = (state as { user?: User }).user;
          if (u && u.color) userMap.set(clientID, u);
        });

        const runs = readAuthorship(ytext);
        const docLen = view.state.doc.length;
        for (const r of runs) {
          if (r.from >= docLen) break;
          const to = Math.min(r.to, docLen);
          if (to <= r.from) continue;
          const user = userMap.get(r.clientID);
          const baseColor = user?.color ?? 'hsl(0, 0%, 60%)';
          const bg = withAlpha(baseColor, 0.2);
          const deco = Decoration.mark({
            attributes: {
              style: `background-color: ${bg}`,
              title: user
                ? `${user.name}`
                : `client ${r.clientID} (offline)`,
            },
          });
          builder.add(r.from, to, deco);
        }
        return builder.finish();
      }

      update(update: ViewUpdate) {
        // The observers above already rebuild on Yjs / awareness
        // events. Local-only doc updates that DON'T touch the ytext
        // (e.g. selection moves) don't need a rebuild — the
        // RangeSetBuilder result is cheap to keep.
        if (update.docChanged) {
          // doc changed for some reason that bypassed yjs ; refresh
          // defensively.
          this.decorations = this.build(update.view);
        }
      }

      destroy() {
        this.cleanupYjs();
        this.cleanupAwareness();
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
