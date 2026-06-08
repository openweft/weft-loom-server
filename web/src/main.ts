// main.ts — V0.1 entry. Wires Yjs over a y-websocket connection to
// /api/projects/<name>/sync (the server's WS relay), and a
// CodeMirror 6 editor with the y-codemirror.next binding so every
// keystroke flows through the CRDT and back out to peers.
//
// V0.1 deliberately keeps the UI minimal : just the editor, a
// language picker (LaTeX / Markdown / Go / C++ / Python), and a
// "Compile" button that POSTs the job + tails the SSE stream. V0.2
// adds project switcher, file tree, presence indicators, PDF
// preview.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { go } from '@codemirror/lang-go';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';

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
      return javascript();
    default:
      return markdown();
  }
}

function wsURL(project: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/projects/${encodeURIComponent(project)}/sync`;
}

async function startEditor(project: string, language: string) {
  // Yjs document + y-websocket connection bound to the server's
  // room for this project.
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(wsURL(project), '', ydoc, {
    // The server treats the URL path as the room ID ; we don't need
    // a sub-name. y-websocket appends one regardless — we pass empty
    // and let the server's room key derive from the URL.
  });
  const ytext = ydoc.getText('codemirror');

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
    ],
  });

  const app = document.getElementById('app');
  if (!app) throw new Error('no #app element');
  app.innerHTML = '';
  const header = document.createElement('header');
  header.style.padding = '0.5rem';
  header.style.borderBottom = '1px solid #ccc';
  header.innerHTML = `
    <strong>weft-loom</strong>
    <span style="margin: 0 0.5rem">project: <code>${project}</code></span>
    <span style="margin: 0 0.5rem">language: <code>${language}</code></span>
    <button id="compile">Compile</button>
    <span id="status" style="margin-left: 0.5rem; color: #888">connecting…</span>
  `;
  const editorHost = document.createElement('div');
  editorHost.style.height = 'calc(100vh - 50px)';
  app.appendChild(header);
  app.appendChild(editorHost);

  const view = new EditorView({ state, parent: editorHost });

  provider.on('status', (event: { status: string }) => {
    const status = document.getElementById('status');
    if (status) status.textContent = event.status;
  });

  document.getElementById('compile')?.addEventListener('click', () =>
    compile(project, language),
  );

  return { view, ydoc, provider };
}

async function compile(project: string, language: string) {
  const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
  if (!resp.ok) {
    alert(`compile start failed : ${resp.status}`);
    return;
  }
  const { id } = await resp.json();
  console.log('compile job', id);
  // SSE stream tails the build log + result.
  const es = new EventSource(`/api/projects/${encodeURIComponent(project)}/compile/${id}`);
  es.addEventListener('log', (e) => console.log('compile:', (e as MessageEvent).data));
  es.addEventListener('result', (e) => {
    console.log('compile result:', (e as MessageEvent).data);
    es.close();
  });
  es.addEventListener('error', (e) => {
    console.error('compile error:', e);
    es.close();
  });
}

// V0.1 : single hard-coded project. V0.2 reads from /api/projects
// and shows a switcher.
startEditor('demo', 'markdown').catch((e) => {
  console.error('editor failed', e);
  const app = document.getElementById('app');
  if (app) app.textContent = `editor failed: ${e}`;
});
