// collab.ts — the session this editor collaborates through.
//
// It replaces yjs + y-websocket with go-crdt/collab, which is the same merge
// logic the server runs, compiled to WebAssembly. What that buys is not a
// different algorithm but a server that holds the document: the old bridge
// relayed frames it could not read and dropped a room when its last client
// left, so comments, the change log and the chat lived in browsers and nowhere
// else. Whoever closed the last tab took them.
//
// Two things about the shape of this module.
//
// Values are bytes. collab does not interpret what a list or a map holds, and
// neither should it — but loom's records are objects, so the encoding is loom's
// to choose and it is here rather than scattered through the components. It is
// JSON, because that is what these records already were on the wire.
//
// Offsets are UTF-16 code units, everywhere, which is what a JavaScript string
// counts in and what CodeMirror counts in. An offset that would split a
// character is refused rather than rounded.

import type { Collab, Session, List, MapPart, PartChange, Text } from './collab.d';

/** The document a project's editors share: text, comments, change log, chat. */
export const DEFAULT_ROOM = 'default';

/** The room a spreadsheet uses, one per file, as the old bridge did. */
export function sheetRoom(file: string): string {
  return `ods:${file}`;
}

let loading: Promise<Collab> | undefined;

/**
 * Loads the WebAssembly client, once per page however many times it is asked
 * for. The instance runs for the life of the page: it holds every open session,
 * so letting it go would end them.
 */
export function loadCollab(): Promise<Collab> {
  if (!loading) {
    loading = (async () => {
      if (!('collab' in globalThis)) {
        await import(/* @vite-ignore */ `${base()}wasm_exec.js`);
        const go = new (globalThis as any).Go();
        const source = await WebAssembly.instantiateStreaming(
          fetch(`${base()}collab.wasm`),
          go.importObject,
        );
        // run() resolves when main returns, and main never returns — it is
        // holding the sessions. So it is deliberately not awaited.
        void go.run(source.instance);
        await untilInstalled();
      }
      return (globalThis as any).collab as Collab;
    })();
  }
  return loading;
}

/** base is where the SPA is served from, which is not the origin: loom mounts under /loom/. */
function base(): string {
  const path = globalThis.location?.pathname ?? '/';
  const at = path.indexOf('/assets/');
  return at >= 0 ? path.slice(0, at + 1) : path.replace(/[^/]*$/, '');
}

/**
 * Waits for the instance to install its API. The module has started running by
 * the time instantiateStreaming resolves, but "started" is not "reached the
 * line that sets globalThis.collab".
 */
async function untilInstalled(): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if ('collab' in globalThis) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('collab: the WebAssembly client never finished starting');
}

/** wsURL is where the session is, from where the page is. */
function wsURL(project: string): string {
  const url = new URL(`api/projects/${encodeURIComponent(project)}/collab`, globalThis.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Joins a project's document.
 *
 * `who` names this participant — a session token, a tab identifier — and
 * becomes its replica identity. Two participants sharing one identity is silent
 * data loss, so it must differ per tab and not merely per user: the same person
 * with two tabs open is two participants.
 */
export async function joinProject(
  project: string,
  who: string,
  room: string = DEFAULT_ROOM,
): Promise<Session> {
  const collab = await loadCollab();
  const site = await collab.deriveSite(who);
  return collab.join({ url: wsURL(project), document: `${project}:${room}`, site });
}

/** A tab's own identity, which outlives a reload but not a new tab. */
export function tabIdentity(): string {
  const key = 'loom.collab.tab';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Turns a record into what a part holds. */
export function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/** Turns what a part holds back into a record, or undefined if it is not one. */
export function decode<T>(raw: Uint8Array | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(decoder.decode(raw)) as T;
  } catch {
    // A value this build cannot read is skipped rather than thrown: a peer on a
    // newer build must not be able to stop this one rendering.
    return undefined;
  }
}

/** Everything a list part holds, as records, skipping any this build cannot read. */
export function records<T>(list: List): T[] {
  const out: T[] = [];
  for (const raw of list.values()) {
    const one = decode<T>(raw);
    if (one !== undefined) out.push(one);
  }
  return out;
}

// A session takes one change handler and a later one replaces it, which is
// right for the session and wrong for a page: the editor watches the text, the
// chat watches its list, the comments watch theirs, and each would silently
// unregister the last. So the one handler is installed here and what it hears
// is handed to everybody watching.
//
// It is per session rather than global, because switching projects ends a
// session and everything watching it should stop with it.
type Watcher = (parts: PartChange[]) => void;
const watchers = new WeakMap<Session, Set<Watcher>>();

/**
 * Calls fn with what changed, until the returned function is called.
 *
 * A list part reports only that it moved: the views written against one read it
 * back whole, and a list here holds tens or hundreds of values rather than the
 * hundreds of thousands of characters a document holds. A map hands over the
 * keys that changed, because a view reads those back. A text hands over the
 * edits, because an editor cannot re-read a document per keystroke and keep a
 * cursor.
 */
export async function watchParts(session: Session, fn: Watcher): Promise<() => void> {
  let set = watchers.get(session);
  if (!set) {
    set = new Set();
    watchers.set(session, set);
    await session.onChange((parts) => {
      // A copy, so that a watcher unsubscribing from inside its own callback
      // does not change the set being walked.
      for (const watcher of [...set!]) {
        try {
          watcher(parts);
        } catch (err) {
          // One view throwing must not stop the others being told.
          console.error('collab: a watcher threw', err);
        }
      }
    });
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

// Who is here has the same shape of problem as what changed, and the same
// answer: one handler on the session, everybody else told from it.
type PeerWatcher = () => void;
const peerWatchers = new WeakMap<Session, Set<PeerWatcher>>();

/** Calls fn whenever the participants change, until the returned function is called. */
export async function watchPeers(session: Session, fn: PeerWatcher): Promise<() => void> {
  let set = peerWatchers.get(session);
  if (!set) {
    set = new Set();
    peerWatchers.set(session, set);
    await session.onPeers(() => {
      for (const watcher of [...set!]) {
        try {
          watcher();
        } catch (err) {
          console.error('collab: a peer watcher threw', err);
        }
      }
    });
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

/** watch is watchParts for a caller that only cares about some of the kinds. */
export function watch(
  session: Session,
  handlers: {
    text?: (name: string, edits: PartChange['text']) => void;
    list?: (name: string) => void;
    map?: (name: string, keys: string[]) => void;
  },
): Promise<() => void> {
  return watchParts(session, (parts) => {
    for (const part of parts) {
      if (part.kind === 'text' && handlers.text) handlers.text(part.name, part.text);
      if (part.kind === 'list' && handlers.list) handlers.list(part.name);
      if (part.kind === 'map' && handlers.map) handlers.map(part.name, part.keys ?? []);
    }
  });
}

export type { Collab, Session, List, MapPart, PartChange, Text };
