// lspClient.ts — minimal CodeMirror 6 LSP client that connects to
// the server's `/api/lsp/<lang>` WebSocket. V0.1 surfaces server-
// published diagnostics via @codemirror/lint ; completions land in
// V0.2. The transport is JSON-RPC 2.0 (no Content-Length framing —
// the server strips it before forwarding).
//
// Wire shape : each WS message is a single JSON-RPC object.
// We track request id → resolver so the editor can issue
// commands + receive responses without re-implementing JSON-RPC.

import { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';

export interface LSPDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number; // 1=error 2=warn 3=info 4=hint
  message: string;
  source?: string;
}

export interface LSPCompletionItem {
  label: string;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  filterText?: string;
  kind?: number;
  sortText?: string;
}

export interface LSPHoverResult {
  contents: string;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LSPLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LSPClient {
  ready: Promise<void>;
  // Open / close docs as the user navigates between files. The
  // client tracks version numbers per uri so didChange sends a
  // strictly-increasing version.
  didOpen(uri: string, languageId: string, text: string): void;
  didClose(uri: string): void;
  didChange(uri: string, text: string): void;
  // Cleanup : closes the WS. The editor calls this when unmounting.
  dispose(): void;
  // Diagnostics for one uri. Returns the CodeMirror Diagnostic
  // array the lint extension expects, mapped from LSP ranges.
  diagnosticsFor(uri: string, view: EditorView): Diagnostic[];
  // Observer set : the lint source subscribes here so it re-runs
  // when the server pushes a fresh publishDiagnostics frame.
  onChange(listener: () => void): () => void;
  // V0.2 : interactive requests. Each returns null on error or
  // when the server has nothing to say at that position.
  completion(uri: string, line: number, character: number): Promise<LSPCompletionItem[] | null>;
  hover(uri: string, line: number, character: number): Promise<LSPHoverResult | null>;
  definition(uri: string, line: number, character: number): Promise<LSPLocation[] | null>;
}

type RPCResponse = {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

type RPCNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export function createLSPClient(opts: {
  url: string;             // /api/lsp/<lang>
  rootUri: string;         // file:///<project>
  workspaceFolderName: string;
}): LSPClient {
  const ws = new WebSocket(opts.url.replace(/^http/, 'ws'));
  const diagnostics = new Map<string, LSPDiagnostic[]>();
  const versions = new Map<string, number>();
  const observers = new Set<() => void>();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let readyResolve!: () => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });

  function notifyObservers() { for (const fn of observers) fn(); }

  function send(obj: object): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  function request<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method: string, params: unknown): void {
    send({ jsonrpc: '2.0', method, params });
  }

  ws.addEventListener('open', () => {
    request<unknown>('initialize', {
      processId: null,
      clientInfo: { name: 'weft-loom', version: '0.1' },
      rootUri: opts.rootUri,
      workspaceFolders: [{ uri: opts.rootUri, name: opts.workspaceFolderName }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, willSave: false, willSaveWaitUntil: false },
          publishDiagnostics: { relatedInformation: true },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['plaintext'] },
        },
        workspace: {
          configuration: false,
          workspaceFolders: true,
        },
      },
    }).then(() => {
      notify('initialized', {});
      readyResolve();
    }).catch((e) => readyReject(e));
  });
  ws.addEventListener('error', (e) => readyReject(e));
  ws.addEventListener('close', () => {
    // Reject any in-flight requests so callers don't hang.
    for (const { reject } of pending.values()) reject(new Error('lsp closed'));
    pending.clear();
  });

  ws.addEventListener('message', (ev) => {
    let msg: RPCResponse | RPCNotification;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if ('id' in msg && (msg as RPCResponse).id !== undefined) {
      const r = msg as RPCResponse;
      const p = pending.get(r.id as number);
      if (p) {
        pending.delete(r.id as number);
        if (r.error) p.reject(new Error(r.error.message));
        else p.resolve(r.result);
      }
      return;
    }
    const n = msg as RPCNotification;
    if (n.method === 'textDocument/publishDiagnostics') {
      const params = n.params as { uri: string; diagnostics: LSPDiagnostic[] };
      diagnostics.set(params.uri, params.diagnostics ?? []);
      notifyObservers();
    }
    // Other notifications (window/showMessage, $/progress, …) are
    // dropped silently in V0.1.
  });

  return {
    ready,
    didOpen(uri, languageId, text) {
      versions.set(uri, 1);
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
    },
    didClose(uri) {
      versions.delete(uri);
      diagnostics.delete(uri);
      notify('textDocument/didClose', { textDocument: { uri } });
      notifyObservers();
    },
    didChange(uri, text) {
      const v = (versions.get(uri) ?? 0) + 1;
      versions.set(uri, v);
      notify('textDocument/didChange', {
        textDocument: { uri, version: v },
        contentChanges: [{ text }],
      });
    },
    dispose() {
      try { ws.close(); } catch { /* ignore */ }
    },
    diagnosticsFor(uri, view) {
      const list = diagnostics.get(uri) ?? [];
      const out: Diagnostic[] = [];
      const doc = view.state.doc;
      for (const d of list) {
        const fromLine = doc.line(Math.min(doc.lines, Math.max(1, d.range.start.line + 1)));
        const toLine = doc.line(Math.min(doc.lines, Math.max(1, d.range.end.line + 1)));
        const from = Math.min(doc.length, fromLine.from + d.range.start.character);
        const to = Math.min(doc.length, toLine.from + d.range.end.character);
        out.push({
          from,
          to: Math.max(from, to),
          severity: ({ 1: 'error', 2: 'warning', 3: 'info', 4: 'info' } as Record<number, Diagnostic['severity']>)[d.severity ?? 1] ?? 'error',
          message: d.message + (d.source ? ' [' + d.source + ']' : ''),
          source: d.source,
        });
      }
      return out;
    },
    onChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
    async completion(uri, line, character) {
      try {
        const r = await request<{ items?: LSPCompletionItem[] } | LSPCompletionItem[] | null>(
          'textDocument/completion',
          { textDocument: { uri }, position: { line, character } },
        );
        if (!r) return null;
        if (Array.isArray(r)) return r;
        return r.items ?? null;
      } catch { return null; }
    },
    async hover(uri, line, character) {
      try {
        const r = await request<{ contents?: unknown; range?: LSPHoverResult['range'] } | null>(
          'textDocument/hover',
          { textDocument: { uri }, position: { line, character } },
        );
        if (!r) return null;
        // contents can be string | { kind, value } | (string | { kind, value })[]
        const c = r.contents;
        let text = '';
        if (typeof c === 'string') text = c;
        else if (c && typeof c === 'object') {
          const obj = c as { kind?: string; value?: string } | { kind?: string; value?: string }[];
          if (Array.isArray(obj)) {
            text = obj.map(p => typeof p === 'string' ? p : (p.value ?? '')).join('\n\n');
          } else {
            text = obj.value ?? '';
          }
        }
        if (!text) return null;
        return { contents: text, range: r.range };
      } catch { return null; }
    },
    async definition(uri, line, character) {
      try {
        const r = await request<LSPLocation | LSPLocation[] | null>(
          'textDocument/definition',
          { textDocument: { uri }, position: { line, character } },
        );
        if (!r) return null;
        return Array.isArray(r) ? r : [r];
      } catch { return null; }
    },
  };
}

// availableLanguages : fetch the server's /api/lsp manifest so the
// SPA only attempts to open WS for languages whose binary is on
// $PATH. Returns the set ; falls back to empty on error.
export async function fetchAvailableLanguages(): Promise<Set<string>> {
  try {
    const r = await fetch('/api/lsp');
    if (!r.ok) return new Set();
    const data = await r.json() as { available?: string[] };
    return new Set(data.available ?? []);
  } catch { return new Set(); }
}
