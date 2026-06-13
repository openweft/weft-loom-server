<script lang="ts">
  // CompileLogPanel — collapsible bottom panel that holds the compile
  // output (log lines + result + Run button). Persistent across compile
  // runs ; unlike the old modal-based CompileDrawer the user can keep
  // it open while editing so log lines stream in live without taking
  // their hands off the editor.
  import { onMount, onDestroy } from 'svelte';
  import { startCompile } from '../api';
  import { compileCommands } from '../settings.svelte';
  import { logError } from '../logbus';

  interface Props {
    project: string;
    language: string;
    // entry threads the active file path to the compile dispatcher.
    // Without it the server falls back to `main.<ext>` which doesn't
    // exist for ad-hoc files like `untitled-abcd.go` — leading to
    // `stat main.go: no such file or directory`.
    entry?: string;
    open: boolean;
    onArtifact?: (url: string) => void;
    onCloseRequest?: () => void;
    // onJump : called when the user clicks a parsed error / warning
    // row. The editor (via App.svelte's jumpToLine prop) scrolls
    // the caret to the matching line. `file` is null when the
    // log doesn't carry a file context — App.svelte then opens
    // the currently-active file at that line.
    onJump?: (line: number, file: string | null) => void;
    // Surface each parsed diagnostic to the parent. Used by App.svelte
    // to push compile errors into the editor's lint gutter so the
    // user sees a red squiggle on the offending line + a dot in the
    // left margin.
    onDiagnostic?: (d: { severity: 'error' | 'warning'; file: string | null; line: number | null; message: string }) => void;
    // Called when a new compile run starts ; the parent should clear
    // any compile-derived diagnostics so stale errors don't linger.
    onCompileReset?: () => void;
  }

  let { project, language, entry = '', open = $bindable(), onArtifact, onCloseRequest, onJump, onDiagnostic, onCompileReset }: Props = $props();

  interface LogLine {
    kind: 'log' | 'result' | 'error';
    text: string;
    ts: number;
  }

  let lines = $state<LogLine[]>([]);
  let inFlight = $state(false);
  // Hoisted so onDestroy can close the stream even mid-run.
  let es: EventSource | null = null;

  // Language-agnostic : every file gets a Run button. The
  // server-side dispatcher decides what to do per language ; if
  // the language has no compiler wired, the failure surfaces in
  // the log with a clear error. Keeping the UI permissive avoids
  // the "why is Run disabled on my .go file?" footgun.
  const compilable = $derived(true);
  let resultURL = $state<string | null>(null);
  let activeTab = $state<'log' | 'errors'>('log');

  // Parsed diagnostics extracted from the streaming compile log.
  // pdflatex / latexmk / pandoc all sprinkle file + line info in
  // distinct shapes ; we run every incoming line through a small
  // bank of regexes and surface the matches under the "Errors" tab
  // for the user to click through.
  interface Diagnostic {
    severity: 'error' | 'warning';
    file: string | null;   // absolute or project-relative path, when present
    line: number | null;   // 1-based source line
    message: string;
  }
  let diagnostics = $state<Diagnostic[]>([]);
  // pdfTeX emits two-line errors : `! Undefined control sequence.` on
  // one line, `l.42 \tetbf` two lines later. We remember the pending
  // `!` message + flush it when the matching `l.N` line arrives.
  let pendingError: string | null = null;

  // Plain-language hint per common pdfTeX error class. Glued onto
  // the diagnostic message so the Errors tab reads "what went wrong
  // + what to check" rather than the cryptic pdfTeX wording alone.
  function pdfTeXHint(message: string): string | null {
    if (/Emergency stop/i.test(message)) {
      return 'Often : missing \\documentclass{…} at the top of the file, or no \\begin{document} at all. pdfTeX bails before it can parse anything.';
    }
    if (/Undefined control sequence/i.test(message)) {
      return 'Typo in a command name OR you forgot to \\usepackage{…} the package that defines it.';
    }
    if (/File\s+`.*?`\s+not found/i.test(message) || /not\s+found/i.test(message)) {
      return 'The file or package referenced is missing from the project / texlive image. Add it to the project tree or install the package.';
    }
    if (/Missing\s+\$\s+inserted/i.test(message)) {
      return 'A math command (\\frac, _, ^, …) used outside math mode. Wrap with $…$ or $$…$$.';
    }
    if (/Runaway argument|File ended while scanning/i.test(message)) {
      return 'Unbalanced braces — search for an unmatched { in the lines above.';
    }
    if (/Environment\s+(.*?)\s+undefined/i.test(message)) {
      return 'Used \\begin{X} where X isn\'t known. Check the package providing X is loaded (e.g. \\usepackage{amsmath} for align).';
    }
    if (/Paragraph ended before/i.test(message)) {
      return 'A command that expects an inline argument hit a blank line. Remove blank lines inside the command.';
    }
    if (/dimension too large/i.test(message)) {
      return 'A size value (in pt/mm/in) exceeds TeX\'s max length (~16384pt). Cap the dimension or split the content.';
    }
    return null;
  }

  function parseDiagnostic(text: string): Diagnostic | null {
    // pdfTeX "l.<N> <ctx>" — pairs with the previous `!` message.
    let m = /^l\.(\d+)\s+(.*)$/.exec(text);
    if (m && pendingError) {
      const hint = pdfTeXHint(pendingError);
      const d: Diagnostic = {
        severity: 'error',
        file: null,
        line: Number(m[1]),
        message: pendingError
          + (m[2] ? ' — ' + m[2].trim() : '')
          + (hint ? '\nHint : ' + hint : ''),
      };
      pendingError = null;
      return d;
    }
    // pdfTeX error introducer.
    if (/^!\s+/.test(text) && !/^!\s*$/.test(text)) {
      pendingError = text.replace(/^!\s+/, '');
      // Some errors (Emergency stop, Fatal error, "File ended …")
      // don't get a following `l.<N>` line because pdfTeX gives up
      // before resolving the location. Flush immediately with a
      // line=1 fallback so the Errors tab still surfaces them.
      if (/Emergency stop|Fatal error|File ended while/i.test(pendingError)) {
        const hint = pdfTeXHint(pendingError);
        const d: Diagnostic = {
          severity: 'error',
          file: null,
          line: 1,
          message: pendingError + (hint ? '\nHint : ' + hint : ''),
        };
        pendingError = null;
        return d;
      }
      return null;
    }
    // !  ==> Fatal error occurred — same fast-path as Emergency stop.
    if (/Fatal error occurred/i.test(text)) {
      const hint = pdfTeXHint(text);
      return {
        severity: 'error',
        file: null,
        line: 1,
        message: text.trim() + (hint ? '\nHint : ' + hint : ''),
      };
    }
    // LaTeX Warning : on input line N.
    m = /LaTeX\s+(?:Font\s+)?Warning:\s+(.*?)\s+on input line\s+(\d+)/i.exec(text);
    if (m) {
      return { severity: 'warning', file: null, line: Number(m[2]), message: m[1] };
    }
    // Overfull / Underfull \hbox at lines N--M
    m = /^(Overfull|Underfull)\s+\\.*\s+at lines\s+(\d+)/i.exec(text);
    if (m) {
      return { severity: 'warning', file: null, line: Number(m[2]), message: text };
    }
    // pandoc / general "file:line:col: message" or "file:line: message"
    m = /^(\S+?):(\d+)(?::\d+)?:\s+(.*)$/.exec(text);
    if (m) {
      return {
        severity: /warn/i.test(m[3]) ? 'warning' : 'error',
        file: m[1],
        line: Number(m[2]),
        message: m[3],
      };
    }
    return null;
  }

  // Persist panel height + open state across reloads.
  onMount(() => {
    // Panel height is now owned by BottomPanel ; the in-component
    // resize state was removed, so the localStorage read is dead.
  });

  function push(line: LogLine) {
    lines = [...lines, line];
  }

  async function run() {
    lines = [];
    diagnostics = [];
    pendingError = null;
    resultURL = null;
    inFlight = true;
    onCompileReset?.();
    push({ kind: 'log', text: `running compile (${language})…`, ts: Date.now() });
    // Flush any in-flight autosave debounce on every mounted editor
    // so the compile picks up the user's latest keystrokes. Without
    // this the 250 ms debounce window means a fast "type → Compile"
    // round-trip might compile the previous version. Editor.svelte's
    // listener attaches a Promise to ev.detail.ack ; we await it.
    try {
      const ev = new CustomEvent<{ ack: Promise<void> | null }>(
        'weft-loom-flush-saves',
        { detail: { ack: null } },
      );
      window.dispatchEvent(ev);
      if (ev.detail.ack) {
        await ev.detail.ack;
        push({ kind: 'log', text: 'flushed editor buffer to disk', ts: Date.now() });
      } else {
        push({ kind: 'log', text: 'WARN : no editor flush listener responded — disk may be stale', ts: Date.now() });
      }
    } catch (e) {
      push({ kind: 'log', text: 'WARN : flush-saves failed : ' + String(e), ts: Date.now() });
    }
    try {
      const customCmd = compileCommands.get(language);
      const id = await startCompile(project, {
        language,
        entry: entry || undefined,
        command: customCmd || undefined,
      });
      if (customCmd) push({ kind: 'log', text: 'custom command : ' + customCmd, ts: Date.now() });
      push({ kind: 'log', text: `job ${id} started`, ts: Date.now() });
      es?.close();
      es = new EventSource(
        `/api/projects/${encodeURIComponent(project)}/compile/${id}`,
      );
      // Track whether the server already delivered the 'result' event ;
      // an 'error' fired afterwards is the normal SSE close, before it
      // is a genuine network interruption worth surfacing.
      let gotResult = false;
      es.addEventListener('log', (e) => {
        const ev = e as MessageEvent;
        let text = ev.data as string;
        try {
          const j = JSON.parse(ev.data);
          if (typeof j.line === 'string') text = j.line;
        } catch { /* ignore */ }
        push({ kind: 'log', text, ts: Date.now() });
        const d = parseDiagnostic(text);
        if (d) {
          diagnostics = [...diagnostics, d];
          // First error : auto-switch to the Errors tab + bubble up
          // to the parent (App.svelte) so the editor's lint gutter
          // can highlight the line + the BottomPanel can flag.
          if (d.severity === 'error' && activeTab !== 'errors') {
            activeTab = 'errors';
          }
          onDiagnostic?.(d);
        }
      });
      es.addEventListener('result', (e) => {
        const ev = e as MessageEvent;
        try {
          const r = JSON.parse(ev.data);
          push({
            kind: r.success ? 'result' : 'error',
            text: r.success
              ? `compiled in ${r.duration_ms} ms`
              : (r.message || 'compile failed'),
            ts: Date.now(),
          });
          if (r.artifact) {
            resultURL = r.artifact;
            onArtifact?.(r.artifact);
          }
        } catch {
          push({ kind: 'result', text: ev.data, ts: Date.now() });
        }
        gotResult = true;
        es?.close();
        es = null;
        inFlight = false;
      });
      es.addEventListener('error', () => {
        if (!gotResult) {
          push({ kind: 'error', text: 'stream interrupted', ts: Date.now() });
          logError('compile', 'stream_interrupted', new Error('SSE error before result'), { project, language });
        }
        es?.close();
        es = null;
        inFlight = false;
      });
    } catch (e) {
      push({ kind: 'error', text: String(e), ts: Date.now() });
      inFlight = false;
    }
  }

  // Errors tab : filtered view over `lines` keeping only lines flagged
  // as errors PLUS any line containing a LaTeX-like ! Error / Warning
  // prefix. Pure derivation — no extra state to keep in sync.
  const errorLines = $derived(
    lines.filter(
      (l) =>
        l.kind === 'error' ||
        /^!|error|warning/i.test(l.text),
    ),
  );

  function clear() {
    lines = [];
    resultURL = null;
  }

  // Resize handle is now owned by BottomPanel ; the in-panel drag
  // handler that lived here is removed to avoid dead code.

  onDestroy(() => {
    es?.close();
    es = null;
  });

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour12: false });
  }
</script>

{#if open}
  <!-- Embedded inside BottomPanel : it provides the outer height +
       drag handle, we just render the inner sub-tabs + actions +
       log body. -->
  <div class="flex flex-col h-full bg-base-100">
    <!-- Sub-tab bar (Log / Errors) + actions -->
    <div class="flex items-center px-2 py-1 border-b border-base-300 bg-base-200">
      <div role="tablist" class="tabs tabs-sm">
        <button
          role="tab"
          class="tab gap-1"
          class:tab-active={activeTab === 'log'}
          onclick={() => (activeTab = 'log')}
        >
          <!-- codicon `output` : matches the outer BottomPanel
               "Compile log" tab so the two icons read as the same
               family + size. -->
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M14 4H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zM2 13V5h12v8H2zm10-2h-1v-1h1v1zm0-2h-1V8h1v1zm0-2h-1V6h1v1z"/>
          </svg>
          Log
          <span class="badge badge-xs badge-ghost">{lines.length}</span>
        </button>
        <button
          role="tab"
          class="tab gap-1"
          class:tab-active={activeTab === 'errors'}
          onclick={() => (activeTab = 'errors')}
        >
          <!-- codicon `warning` (same 16x16 viewbox so vertical
               alignment matches the Log tab pixel-for-pixel). -->
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"/>
          </svg>
          Errors
          <!-- Badge counts parsed diagnostics (clickable rows with
               file + line). Falls back to raw error-line scrape when
               the parser missed something. -->
          <span class="badge badge-xs" class:badge-error={diagnostics.length + errorLines.length > 0}>
            {diagnostics.length || errorLines.length}
          </span>
        </button>
      </div>
      <div class="ml-auto flex gap-1">
        {#if compilable}
          <button
            class="btn btn-primary btn-xs"
            disabled={inFlight}
            onclick={run}
            title="Run compile ({language})"
          >
            {#if inFlight}
              <span class="loading loading-spinner loading-xs"></span>
            {:else}
              ▶
            {/if}
            Run
          </button>
        {:else}
          <span
            class="text-[10px] opacity-50 italic px-2 py-0.5"
            title="In-window PDF compile only runs for LaTeX + Markdown. For other languages use the terminal (Cmd+`) — pkgx supplies the toolchain on demand."
          >
            no in-window compile for {language}
          </span>
        {/if}
        <button
          class="btn btn-ghost btn-xs"
          onclick={clear}
          title="Clear log"
        >
          🧹
        </button>
        {#if resultURL}
          <a class="btn btn-ghost btn-xs" href={resultURL} download title="Download artifact">
            ⬇
          </a>
        {/if}
        <button
          class="btn btn-ghost btn-xs"
          onclick={() => onCloseRequest?.()}
          title="Hide panel"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- Log content -->
    <div class="flex-1 overflow-auto p-2 font-mono text-xs bg-base-300/30">
      {#if activeTab === 'log'}
        {#if lines.length === 0}
          <div class="opacity-50 italic">
            {#if compilable}
              No output yet. Click <span class="font-semibold">Run</span> to compile.
            {:else}
              No in-window compile for <span class="font-mono">{language}</span>. Open a terminal (Ctrl+`) — pkgx fournit la toolchain on-demand (try <span class="font-mono">go run main.go</span>, <span class="font-mono">python3 main.py</span>, etc.).
            {/if}
          </div>
        {/if}
        {#each lines as l}
          <div
            class="whitespace-pre-wrap leading-snug"
            class:text-success={l.kind === 'result'}
            class:text-error={l.kind === 'error'}
          >
            <span class="opacity-40">{fmtTime(l.ts)}</span>
            {l.text}
          </div>
        {/each}
      {:else}
        {#if diagnostics.length === 0 && errorLines.length === 0}
          <div class="opacity-50 italic">No errors.</div>
        {/if}
        <!-- Parsed diagnostics with click-to-jump. Each row carries
             a 1-based source line ; the parent App.svelte routes
             the click into the Editor via its jumpToLine prop. -->
        {#each diagnostics as d (d.message + ':' + d.line)}
          <button
            type="button"
            class="w-full text-left flex items-start gap-2 px-2 py-1 hover:bg-base-200 rounded text-xs"
            class:text-error={d.severity === 'error'}
            class:text-warning={d.severity === 'warning'}
            onclick={() => { if (d.line != null) onJump?.(d.line, d.file); }}
            title={d.file ? `${d.file}:${d.line}` : `line ${d.line}`}
          >
            <span class="font-mono opacity-70 w-16 shrink-0">
              {d.severity === 'error' ? '✕' : '⚠'} L{d.line ?? '?'}
            </span>
            <!-- whitespace-pre-line preserves the `\n` we insert
                 between the raw error + the actionable hint so the
                 message renders on two distinct lines. -->
            <span class="flex-1 break-words whitespace-pre-line">{d.message}</span>
            {#if d.file}
              <span class="opacity-50 font-mono shrink-0">{d.file}</span>
            {/if}
          </button>
        {/each}
        <!-- Fallback : raw error lines we couldn't parse stay
             visible so the user doesn't lose context. -->
        {#each errorLines as l}
          <div class="whitespace-pre-wrap leading-snug text-error/70 text-xs px-2">
            <span class="opacity-40">{fmtTime(l.ts)}</span>
            {l.text}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}
