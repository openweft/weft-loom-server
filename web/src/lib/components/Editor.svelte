<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorState } from '@codemirror/state';
  import { EditorView, keymap, lineNumbers } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import {
    syntaxHighlighting,
    defaultHighlightStyle,
    indentOnInput,
    bracketMatching,
    StreamLanguage,
  } from '@codemirror/language';
  import { markdown } from '@codemirror/lang-markdown';
  import { go } from '@codemirror/lang-go';
  import { cpp } from '@codemirror/lang-cpp';
  import { python } from '@codemirror/lang-python';
  import { rust } from '@codemirror/lang-rust';
  import { javascript } from '@codemirror/lang-javascript';
  import { stex } from '@codemirror/legacy-modes/mode/stex';

  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import { yCollab } from 'y-codemirror.next';
  import type { Awareness } from 'y-protocols/awareness';
  import type { Identity } from '../identity';

  interface Props {
    project: string;
    language: string;
    // file is the active file path inside the project — empty means
    // the project's default ytext ("codemirror"). Selecting a
    // different file rebinds the editor to a per-file ytext within
    // the SAME provider, so collaborators on different files share
    // one WS but only see each other's edits when they're on the
    // same file.
    file?: string;
    identity: Identity;
    onStatus?: (
      status: 'connecting' | 'connected' | 'disconnected',
    ) => void;
    onYDoc?: (doc: Y.Doc) => void;
    onAwareness?: (a: Awareness) => void;
  }

  let { project, language, file, identity, onStatus, onYDoc, onAwareness }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;
  let provider: WebsocketProvider | undefined;
  let ydoc: Y.Doc | undefined;

  function languagePack(name: string) {
    switch (name) {
      case 'latex':
        return StreamLanguage.define(stex);
      case 'markdown':
        return markdown();
      case 'go':
        return go();
      case 'cpp':
      case 'c':
        return cpp();
      case 'python':
        return python();
      case 'rust':
        return rust();
      case 'javascript':
      case 'typescript':
        return javascript();
      default:
        return markdown();
    }
  }

  function wsURL(p: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/projects/${encodeURIComponent(p)}/sync`;
  }

  onMount(() => {
    if (!host) return;
    ydoc = new Y.Doc();
    onYDoc?.(ydoc);
    provider = new WebsocketProvider(wsURL(project), '', ydoc);
    // The y-codemirror.next yCollab extension consumes awareness state
    // for remote cursor coloring. Setting the local user identity
    // here makes both this client's name+color visible to every other
    // peer in the room AND ensures the awareness state has a 'user'
    // entry the CollaboratorList component can read.
    provider.awareness.setLocalStateField('user', {
      name: identity.name,
      color: identity.color,
    });
    onAwareness?.(provider.awareness);
    const ytextKey = file && file !== '' ? 'file:' + file : 'codemirror';
    const ytext = ydoc.getText(ytextKey);

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        languagePack(language),
        yCollab(ytext, provider.awareness),
        EditorView.theme({
          '&': { height: '100%' },
        }),
      ],
    });

    view = new EditorView({ state, parent: host });

    provider.on('status', (event: { status: string }) => {
      if (
        event.status === 'connected' ||
        event.status === 'connecting' ||
        event.status === 'disconnected'
      ) {
        onStatus?.(event.status);
      }
    });
  });

  onDestroy(() => {
    view?.destroy();
    provider?.destroy();
    ydoc?.destroy();
  });
</script>

<div bind:this={host} class="h-full w-full bg-base-100"></div>
