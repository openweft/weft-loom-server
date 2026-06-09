<script lang="ts">
  // AIChatPanel — right-side panel hosting a chat with an LLM assistant.
  // Cuts a vertical column off the main layout when `open`. The backend
  // route is POST /api/projects/{p}/chat ; today it's a stub returning
  // a canned 'configure a model' reply. Future wiring routes to Ollama
  // (already in openweft via weft-doctor) or to Anthropic / OpenAI
  // via a configured key.
  //
  // The current file's content travels with each request as context so
  // the model can answer questions about what the user is editing.
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    project: string;
    currentFile: string;
    fileContent: () => string;
    open: boolean;
    onClose: () => void;
  }

  let { project, currentFile, fileContent, open = $bindable(), onClose }: Props = $props();

  interface Message {
    role: 'user' | 'assistant' | 'system';
    text: string;
    ts: number;
  }

  let messages = $state<Message[]>([]);
  let input = $state('');
  let busy = $state(false);
  let width = $state<number>(360);
  let dragging = $state(false);

  onMount(() => {
    const v = localStorage.getItem('weft-loom-ai-width');
    if (v) {
      const n = Number(v);
      if (!Number.isNaN(n) && n >= 240 && n <= 800) width = n;
    }
    // Greet on first open per session, not per visit — so the user
    // sees a hint about how to talk to the assistant.
    if (messages.length === 0) {
      messages = [
        {
          role: 'system',
          ts: Date.now(),
          text: 'Hi — ask me anything about the current file. I can summarise, suggest edits, explain LaTeX / Marp / code, or help with structure.',
        },
      ];
    }
  });

  function startDrag(ev: MouseEvent) {
    ev.preventDefault();
    dragging = true;
    const startX = ev.clientX;
    const startW = width;
    function move(e: MouseEvent) {
      const next = Math.max(240, Math.min(800, startW - (e.clientX - startX)));
      width = next;
    }
    function up() {
      dragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-ai-width', String(width)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    input = '';
    messages = [...messages, { role: 'user', text, ts: Date.now() }];
    busy = true;
    try {
      const resp = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messages
              .filter((m) => m.role !== 'system')
              .map((m) => ({ role: m.role, content: m.text })),
            file: currentFile,
            file_content: fileContent(),
          }),
        },
      );
      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()));
      }
      const j = await resp.json();
      messages = [
        ...messages,
        { role: 'assistant', text: j.reply || '(no reply)', ts: Date.now() },
      ];
    } catch (e) {
      messages = [
        ...messages,
        { role: 'system', text: 'Error: ' + String(e), ts: Date.now() },
      ];
    } finally {
      busy = false;
    }
  }

  function clear() {
    messages = [
      {
        role: 'system',
        ts: Date.now(),
        text: 'Conversation cleared.',
      },
    ];
  }

  onDestroy(() => { dragging = false; });
</script>

{#if open}
  <div
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    class="w-1.5 cursor-col-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
    class:bg-primary={dragging}
    onmousedown={startDrag}
    title="Drag to resize the AI panel"
  ></div>
  <aside
    class="flex-none flex flex-col bg-base-100 border-l border-base-300 overflow-hidden"
    style="width: {width}px"
  >
    <header class="flex items-center gap-2 px-3 py-2 border-b border-base-300 bg-base-200">
      <span class="font-semibold text-sm">🤖 Assistant</span>
      <span class="text-xs opacity-50 truncate">{currentFile || '(no file)'}</span>
      <div class="ml-auto flex gap-1">
        <button class="btn btn-ghost btn-xs" onclick={clear} title="Clear conversation">🧹</button>
        <button class="btn btn-ghost btn-xs" onclick={onClose} title="Hide panel">✕</button>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto p-3 space-y-3">
      {#each messages as m (m.ts + m.role)}
        <div
          class="chat"
          class:chat-start={m.role !== 'user'}
          class:chat-end={m.role === 'user'}
        >
          <div class="chat-header text-xs opacity-60">
            {m.role}
            <time class="opacity-50">{new Date(m.ts).toLocaleTimeString()}</time>
          </div>
          <div
            class="chat-bubble text-sm"
            class:chat-bubble-primary={m.role === 'user'}
            class:chat-bubble-secondary={m.role === 'assistant'}
            class:chat-bubble-accent={m.role === 'system'}
          >
            <pre class="whitespace-pre-wrap font-sans m-0">{m.text}</pre>
          </div>
        </div>
      {/each}
      {#if busy}
        <div class="chat chat-start">
          <div class="chat-bubble chat-bubble-secondary text-sm">
            <span class="loading loading-dots loading-sm"></span>
          </div>
        </div>
      {/if}
    </div>

    <form
      class="border-t border-base-300 p-2 flex gap-1"
      onsubmit={(e) => { e.preventDefault(); send(); }}
    >
      <textarea
        bind:value={input}
        rows="2"
        class="textarea textarea-bordered textarea-sm flex-1 resize-none"
        placeholder="Ask about this file… (⌘+Enter to send)"
        onkeydown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      ></textarea>
      <button class="btn btn-primary btn-sm self-end" disabled={busy || input.trim() === ''} type="submit">
        Send
      </button>
    </form>
  </aside>
{/if}
