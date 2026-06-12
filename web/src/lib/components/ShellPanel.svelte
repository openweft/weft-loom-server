<script lang="ts">
  // ShellPanel — xterm.js terminal connected to the loom-server's
  // /api/projects/{p}/shell WS endpoint. The wire protocol is the
  // 1-byte-prefix scheme from api_shell.go : 'i'+data for stdin,
  // 'r'+cols(u16)+rows(u16) for resize, 'o'+data for stdout.
  //
  // Lives in a collapsible panel at the bottom of the editor next
  // to the CompileLogPanel (also resizable). The PTY runs in the
  // loom-server host's working tree for the project — handy for
  // running latexmk, git commands, etc. directly on the project
  // files without leaving the editor.
  import { onDestroy } from 'svelte';
  import { Terminal } from 'xterm';
  import { FitAddon } from 'xterm-addon-fit';
  import 'xterm/css/xterm.css';

  interface Props {
    project: string;
    open: boolean;
  }

  let { project, open = $bindable() }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let ws: WebSocket | undefined;
  let connected = $state(false);

  function sendInput(data: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = new TextEncoder().encode(data);
    const frame = new Uint8Array(enc.length + 1);
    frame[0] = 'i'.charCodeAt(0);
    frame.set(enc, 1);
    ws.send(frame);
  }

  function sendResize(cols: number, rows: number) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(5);
    frame[0] = 'r'.charCodeAt(0);
    frame[1] = (cols >> 8) & 0xff;
    frame[2] = cols & 0xff;
    frame[3] = (rows >> 8) & 0xff;
    frame[4] = rows & 0xff;
    ws.send(frame);
  }

  function connect() {
    if (!project) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/projects/${encodeURIComponent(project)}/shell`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      connected = true;
      if (term && fit) {
        fit.fit();
        sendResize(term.cols, term.rows);
      }
    };
    ws.onmessage = (ev) => {
      if (!term) return;
      const data = ev.data;
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (typeof data === 'string') {
        // Server-sent text band : red for errors, yellow for info.
        const isInfo = data.startsWith('info:');
        const colour = isInfo ? '\x1b[33m' : '\x1b[31m';
        term.write('\r\n' + colour + data + '\x1b[0m\r\n');
        return;
      } else return;
      if (bytes.length === 0) return;
      // 'o' = stdout
      if (bytes[0] === 'o'.charCodeAt(0)) {
        term.write(bytes.subarray(1));
      }
    };
    ws.onclose = () => {
      connected = false;
      if (term) term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');
    };
    ws.onerror = () => {
      if (term) term.write('\r\n\x1b[31m[ws error]\x1b[0m\r\n');
    };
  }

  let resizeObserver: ResizeObserver | undefined;
  let attachedHost: HTMLDivElement | undefined;

  // host is only populated AFTER the user first clicks the Shell tab :
  // the BottomPanel mounts ShellPanel from the start but its body is
  // hidden via `{#if open}`, so onMount sees host === undefined and
  // used to return early forever. We now watch host with $effect and
  // wire up the terminal the first time it appears.
  //
  // Toggle scenario : user opens Shell → term attaches to host_v1.
  // User switches to Compile log → ShellPanel.open=false → {#if open}
  // unmounts the body → host becomes undefined. User flips back to
  // Shell → host_v2 appears (different DOM node). Without re-attach,
  // term stays bound to host_v1 (detached) → keystrokes go to a
  // stranded xterm → user sees "shell hang". We detect host changing
  // + re-open() the existing terminal onto the new host.
  $effect(() => {
    if (term && host && attachedHost !== host) {
      try { term.open(host); fit?.fit(); } catch {}
      attachedHost = host;
      return;
    }
    if (term || !host) return;
    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", Consolas, monospace',
      theme: { background: '#0f1115' },
      scrollback: 5000,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    attachedHost = host;
    fit.fit();
    term.onData((d) => sendInput(d));
    term.onResize((s) => sendResize(s.cols, s.rows));

    connect();

    resizeObserver = new ResizeObserver(() => {
      try { fit?.fit(); } catch { /* terminal not ready */ }
    });
    resizeObserver.observe(host);

  });

  onDestroy(() => {
    try { ws?.close(); } catch {}
    try { term?.dispose(); } catch {}
    try { resizeObserver?.disconnect(); } catch {}
  });

  // Height + in-panel drag handle used to live here ; both are now
  // owned by BottomPanel, so the local copies were dead code.

  function clear() {
    try { term?.clear(); } catch {}
  }
</script>

<!-- Embedded inside BottomPanel : it provides the outer height +
     drag handle + tab strip. Visibility is controlled via the `open`
     prop driving a CSS hide (NOT a #if unmount) — switching tabs
     must keep the xterm DOM + WS alive, otherwise the terminal
     unmounts every time the user peeks at Compile log and comes
     back with a dead session. -->
<div class="flex flex-col h-full bg-base-100" class:hidden={!open}>
  <div class="flex items-center px-3 py-1 border-b border-base-300 bg-base-200/50">
    <span class="badge badge-xs" class:badge-success={connected} class:badge-error={!connected}>
      {connected ? 'connected' : 'disconnected'}
    </span>
    <span class="ml-2 opacity-50 font-mono text-[10px] truncate">{project}</span>
    <div class="ml-auto flex gap-1">
      {#if !connected}
        <button class="btn btn-ghost btn-xs" onclick={connect} title="Reconnect">↻</button>
      {/if}
      <button class="btn btn-ghost btn-xs" onclick={clear} title="Clear scrollback">🧹</button>
    </div>
  </div>
  <div bind:this={host} class="flex-1 overflow-hidden" style="background:#0f1115"></div>
</div>
