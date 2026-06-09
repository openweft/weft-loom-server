<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorState } from '@codemirror/state';
  import { EditorView, keymap, lineNumbers } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import {
    syntaxHighlighting,
    defaultHighlightStyle,
    HighlightStyle,
    indentOnInput,
    bracketMatching,
    StreamLanguage,
  } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';
  import { markdown } from '@codemirror/lang-markdown';
  import { autocompletion } from '@codemirror/autocomplete';
  import { marpMetadataCompletion } from '../marpAutocomplete';
  import { codeblockLanguageCompletion } from '../codeblockAutocomplete';
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
  import { readFile, writeFile } from '../api';

  interface Props {
    project: string;
    language: string;
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
  let saveDebounce: ReturnType<typeof setTimeout> | undefined;
  let seeded = false;

  // Dark-theme syntax highlight : the defaultHighlightStyle uses
  // dark blue keywords which become unreadable on a dark background.
  // This palette is roughly the VS Code Dark+ defaults — bright enough
  // to read on a #1e1e1e-ish base. CodeMirror gates application on
  // `themeType: 'dark'` so it auto-applies only when daisyUI's dark
  // theme is active.
  const cmDarkHighlight = HighlightStyle.define(
    [
      { tag: t.keyword, color: '#c586c0' },
      { tag: t.controlKeyword, color: '#c586c0' },
      { tag: t.atom, color: '#569cd6' },
      { tag: t.number, color: '#b5cea8' },
      { tag: t.string, color: '#ce9178' },
      { tag: t.tagName, color: '#569cd6' },
      { tag: t.heading, color: '#569cd6', fontWeight: 'bold' },
      { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
      { tag: t.meta, color: '#dcdcaa' },
      { tag: t.invalid, color: '#f44747' },
      { tag: t.url, color: '#3794ff' },
      { tag: t.variableName, color: '#9cdcfe' },
      { tag: t.typeName, color: '#4ec9b0' },
      { tag: t.macroName, color: '#dcdcaa' },
      { tag: t.processingInstruction, color: '#c586c0' },
      { tag: t.bracket, color: '#d4d4d4' },
      { tag: t.brace, color: '#d4d4d4' },
      { tag: t.operator, color: '#d4d4d4' },
      { tag: t.punctuation, color: '#d4d4d4' },
    ],
    { themeType: 'dark' },
  );

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
    provider = new WebsocketProvider(wsURL(project), 'default', ydoc);
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
        syntaxHighlighting(cmDarkHighlight),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        languagePack(language),
        yCollab(ytext, provider.awareness),
        // Marp theme autocomplete : fires when the cursor sits in a
        // YAML front-matter block on a `theme:` line. Closed if the
        // user types a value that isn't a known theme.
        autocompletion({
          override: [marpMetadataCompletion, codeblockLanguageCompletion],
        }),
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

    // Auto-seed from disk : runs immediately on mount, NOT gated on
    // the WS 'sync' event — the WS may never complete sync (relay
    // can fail to handshake), and we still want the user to see
    // their file content. The Yjs CRDT will reconcile if the relay
    // later pushes a divergent state.
    //
    // Guard : skip if ytext already has content (the relay's existing
    // doc beat us to it via the early sync handshake) so we don't
    // duplicate the buffer.
    (async () => {
      if (!file) return;
      try {
        const content = await readFile(project, file);
        if (content && ytext.length === 0) {
          ydoc!.transact(() => {
            ytext.insert(0, content);
          }, 'seed-from-disk');
          seeded = true;
        }
      } catch {
        // 404 / permission denied — leave ytext empty so the user
        // can edit a fresh file.
      }
    })();

    // Auto-save : every edit reschedules a debounced PUT to the file
    // API. 1 second of idle → write to disk → schedulePush() (server
    // side) kicks off the auto-commit + git push pipeline.
    ytext.observe(() => {
      if (!file) return;
      if (saveDebounce) clearTimeout(saveDebounce);
      saveDebounce = setTimeout(async () => {
        if (!file) return;
        try {
          await writeFile(project, file, ytext.toString());
        } catch (e) {
          console.error('autosave failed', e);
        }
      }, 1000);
    });
  });

  onDestroy(() => {
    // Flush any pending save before tearing down so a fast file switch
    // doesn't lose the user's last keystrokes.
    if (saveDebounce) {
      clearTimeout(saveDebounce);
      if (ydoc && file) {
        const ytextKey = 'file:' + file;
        const t = ydoc.getText(ytextKey);
        // Fire-and-forget : the provider's about to die anyway.
        writeFile(project, file, t.toString()).catch(() => {});
      }
    }
    view?.destroy();
    provider?.destroy();
    ydoc?.destroy();
  });
</script>

<div bind:this={host} class="h-full w-full bg-base-100"></div>
