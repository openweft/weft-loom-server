<script lang="ts">
  import { startCompile } from '../api';

  interface Props {
    open: boolean;
    project: string;
    language: string;
  }

  let { open = $bindable(), project, language }: Props = $props();

  interface LogLine {
    kind: 'log' | 'result' | 'error';
    text: string;
  }

  let lines = $state<LogLine[]>([]);
  let inFlight = $state(false);
  let resultURL = $state<string | null>(null);

  async function run() {
    lines = [];
    resultURL = null;
    inFlight = true;
    try {
      const id = await startCompile(project, { language });
      lines = [...lines, { kind: 'log', text: `job ${id} started` }];

      const es = new EventSource(
        `/api/projects/${encodeURIComponent(project)}/compile/${id}`,
      );
      es.addEventListener('log', (e) => {
        const ev = e as MessageEvent;
        try {
          const { line } = JSON.parse(ev.data);
          lines = [...lines, { kind: 'log', text: line }];
        } catch {
          lines = [...lines, { kind: 'log', text: ev.data }];
        }
      });
      es.addEventListener('result', (e) => {
        const ev = e as MessageEvent;
        try {
          const r = JSON.parse(ev.data);
          lines = [
            ...lines,
            {
              kind: 'result',
              text: r.success
                ? `compiled in ${r.duration_ms} ms`
                : 'compile failed',
            },
          ];
          if (r.artifact) resultURL = r.artifact;
        } catch {
          lines = [...lines, { kind: 'result', text: ev.data }];
        }
        es.close();
        inFlight = false;
      });
      es.addEventListener('error', () => {
        lines = [...lines, { kind: 'error', text: 'stream interrupted' }];
        es.close();
        inFlight = false;
      });
    } catch (e) {
      lines = [...lines, { kind: 'error', text: String(e) }];
      inFlight = false;
    }
  }
</script>

<dialog class="modal" class:modal-open={open}>
  <div class="modal-box w-11/12 max-w-3xl">
    <h3 class="text-lg font-bold">
      Compile <span class="font-mono opacity-70">{project}</span>
      <span class="badge badge-ghost badge-sm ml-2">{language}</span>
    </h3>
    <div class="mt-4 flex gap-2">
      <button
        class="btn btn-primary btn-sm"
        disabled={inFlight}
        onclick={run}
      >
        {#if inFlight}
          <span class="loading loading-spinner loading-xs"></span>
        {/if}
        Run
      </button>
      {#if resultURL}
        <a class="btn btn-outline btn-sm" href={resultURL} download>
          Download artifact
        </a>
      {/if}
    </div>
    <div class="mockup-code mt-4 max-h-96 overflow-y-auto bg-base-300 p-3 text-xs">
      {#each lines as l}
        <pre
          class:text-success={l.kind === 'result'}
          class:text-error={l.kind === 'error'}>
          <code>{l.text}</code>
        </pre>
      {/each}
      {#if lines.length === 0 && !inFlight}
        <span class="opacity-50">Click Run to start a compile job.</span>
      {/if}
    </div>
    <div class="modal-action">
      <button class="btn" onclick={() => (open = false)}>Close</button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop">
    <button onclick={() => (open = false)}>close</button>
  </form>
</dialog>
