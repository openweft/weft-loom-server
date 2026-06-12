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
  // Provider configuration (Albert / OpenAI / Anthropic / OpenRouter /
  // Ollama / custom) lives in lib/aiProvider.svelte — click ⚙ in the
  // panel header to open the provider editor.
  import { onMount, onDestroy } from 'svelte';
  import { ai, type ProviderKind, type AIProvider } from '../aiProvider.svelte';

  interface Props {
    project: string;
    currentFile: string;
    fileContent: () => string;
    open: boolean;
    onClose: () => void;
    // embedded == true when AIChatPanel sits inside a parent that
    // owns the column width + side border (Chat-under-AI stack).
    // Drop the self-managed drag handle + border to integrate
    // seamlessly with the host column.
    embedded?: boolean;
    // When `collapsed` (only meaningful in embedded mode), render
    // ONLY the header bar — body is hidden, no flex-1 needed. The
    // host (App.svelte) is responsible for sizing the wrapper. Lets
    // the right column be a stack of two accordions like Outline +
    // Metadata in the left sidebar.
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
  }

  let { project, currentFile, fileContent, open = $bindable(), onClose, embedded = false, collapsed = false, onToggleCollapsed }: Props = $props();

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
  let providerPanel = $state(false);

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
      const active = ai.active();
      const reply = active && active.kind !== 'server'
        ? await callExternalProvider(active)
        : await callServerStub();
      messages = [...messages, { role: 'assistant', text: reply, ts: Date.now() }];
    } catch (e) {
      messages = [
        ...messages,
        { role: 'system', text: 'Error: ' + String(e), ts: Date.now() },
      ];
    } finally {
      busy = false;
    }
  }

  // Server-stub path : the legacy POST /api/projects/{p}/chat ; the
  // loom-server can prepend project-context server-side (file picker,
  // sandbox tooling). Used when the user hasn't configured an
  // external provider.
  async function callServerStub(): Promise<string> {
    const resp = await fetch('/api/projects/' + encodeURIComponent(project) + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.text })),
        file: currentFile,
        file_content: fileContent(),
      }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()));
    const j = await resp.json();
    return j.reply || '(no reply)';
  }

  // Direct call to an OpenAI-compatible chat-completions endpoint.
  // Albert (DINUM), OpenRouter, raw OpenAI, Ollama, and any
  // self-hosted relay all answer this shape. Anthropic uses a
  // slightly different envelope ; we branch on `kind`.
  async function callExternalProvider(p: AIProvider): Promise<string> {
    const sys = currentFile
      ? `You are an assistant inside weft-loom. The user is editing ${currentFile}. File content follows :\n\`\`\`\n${fileContent().slice(0, 8000)}\n\`\`\``
      : 'You are an assistant inside weft-loom.';
    const conv = [
      { role: 'system', content: sys },
      ...messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.text })),
    ];
    if (p.kind === 'anthropic') {
      const r = await fetch(p.baseURL + '/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': p.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: p.model,
          max_tokens: 1024,
          system: sys,
          messages: conv.filter((m) => m.role !== 'system'),
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()));
      const j = await r.json();
      return (j.content?.[0]?.text ?? '(no reply)').toString();
    }
    // OpenAI-compatible chat/completions (Albert / OpenAI /
    // OpenRouter / Ollama / custom)
    const r = await fetch(p.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {}),
      },
      body: JSON.stringify({ model: p.model, messages: conv, max_tokens: 1024 }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()));
    const j = await r.json();
    return (j.choices?.[0]?.message?.content ?? '(no reply)').toString();
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
  {#if !embedded}
    <!-- Standalone : left-edge drag handle to resize the column +
         its own border. Hidden when embedded in a parent stack. -->
    <div
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      class="w-1.5 cursor-col-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
      class:bg-primary={dragging}
      onmousedown={startDrag}
      title="Drag to resize the AI panel"
    ></div>
  {/if}
  <aside
    class="flex flex-col bg-base-100 overflow-hidden"
    class:flex-none={!embedded}
    class:border-l={!embedded}
    class:border-base-300={!embedded}
    class:h-full={embedded}
    class:w-full={embedded}
    style={embedded ? '' : `width: ${width}px`}
  >
    <header class="flex items-center gap-2 px-3 h-9 border-b border-base-300 bg-base-200">
      <!-- Chevron + label is the accordion toggle ; the action
           buttons (⚙ 🧹 ✕) live on the right and stopPropagation
           so they don't fold the panel when clicked. -->
      <button
        type="button"
        class="flex items-center gap-1 min-w-0 flex-1 text-left h-full hover:bg-base-300/30"
        onclick={() => onToggleCollapsed?.()}
        title={collapsed ? 'Expand AI Assistant' : 'Collapse AI Assistant'}
        aria-expanded={!collapsed}
      >
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="currentColor"
          aria-hidden="true"
          class="transition-transform shrink-0"
          class:rotate-90={!collapsed}
        >
          <path d="M5.7 13.7L4.3 12.3 8.6 8 4.3 3.7 5.7 2.3l5.7 5.7-5.7 5.7z"/>
        </svg>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" class="shrink-0">
          <path d="M6.09 8.5c.32.31.7.54 1.12.67.42.13.87.16 1.3.07v.01c.52-.11 1-.36 1.37-.74l.7.71c-.69.68-1.61 1.07-2.58 1.07-.49 0-.97-.1-1.42-.29-.45-.18-.85-.45-1.19-.79l.7-.71z"/>
          <path d="M6.49 7.5h-1v-1h1v1z M10.49 6.5v1h-1v-1h1z"/>
          <path fill-rule="evenodd" clip-rule="evenodd" d="M8 1c.27 0 .52.1.71.29.19.19.29.44.29.71-.01.17-.06.34-.15.48-.09.15-.22.27-.37.35V4h4l.5.5v2.03H13l.5.5v.97l-.5.5h-.52v3l-.5.5H9.36l-2.5 2.76L6 14.4V12H3.5L3 11.36V8.5h-.5L2 8v-.97L2.5 6.53H3V4.36L3.53 4h4V2.86c-.16-.08-.29-.21-.38-.36-.09-.15-.15-.32-.15-.5C7 1.73 7.11 1.48 7.29 1.29 7.48 1.11 7.73 1 8 1zM4 10.86l2.5.14H7v2.19l1.8-2.04.35-.15H12V5H4v5.86z"/>
        </svg>
        <span class="font-semibold text-sm">Assistant</span>
        <span class="text-xs opacity-50 truncate">{currentFile || '(no file)'}</span>
      </button>
      <span class="badge badge-ghost badge-xs font-mono" title="Active AI provider">{ai.active()?.name ?? 'server'}</span>
      <div class="flex gap-1">
        <button class="btn btn-ghost btn-xs" onclick={(e) => { e.stopPropagation(); providerPanel = !providerPanel; }} title="Configure AI provider">⚙</button>
        <button class="btn btn-ghost btn-xs" onclick={(e) => { e.stopPropagation(); clear(); }} title="Clear conversation">🧹</button>
      </div>
    </header>

    {#if !collapsed}
    {#if providerPanel}
      <!-- Inline provider editor — switch active OR add Albert /
           OpenAI / OpenRouter / Anthropic / Ollama keys. Stored in
           localStorage only — never sent to the loom-server. -->
      <div class="p-3 border-b border-base-300 bg-base-200/40 text-xs space-y-2">
        <div class="flex items-center gap-2">
          <span class="font-semibold">Provider :</span>
          <select
            class="select select-bordered select-xs flex-1"
            value={ai.activeKind}
            onchange={(e) => ai.setActive((e.target as HTMLSelectElement).value as ProviderKind)}
          >
            {#each ai.providers as p}
              <option value={p.kind}>{p.name}</option>
            {/each}
          </select>
        </div>
        <div class="flex flex-wrap gap-1">
          <span class="opacity-60">Add :</span>
          {#each ['albert', 'openai', 'openrouter', 'anthropic', 'ollama', 'custom'] as k}
            {#if !ai.providers.find((p) => p.kind === k)}
              <button
                class="btn btn-ghost btn-xs font-mono"
                onclick={() => {
                  const d = ai.defaultsFor(k as ProviderKind);
                  ai.upsert({ kind: k as ProviderKind, name: d.name, baseURL: d.baseURL, model: d.model, apiKey: '' });
                  ai.setActive(k as ProviderKind);
                }}
              >+ {k}</button>
            {/if}
          {/each}
        </div>
        {#if ai.active() && ai.activeKind !== 'server'}
          {@const p = ai.active()!}
          <label class="flex items-center gap-2">
            <span class="w-20 opacity-60">Base URL</span>
            <input
              class="input input-bordered input-xs flex-1 font-mono"
              value={p.baseURL}
              oninput={(e) => ai.upsert({ ...p, baseURL: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="flex items-center gap-2">
            <span class="w-20 opacity-60">API key</span>
            <input
              type="password"
              class="input input-bordered input-xs flex-1 font-mono"
              value={p.apiKey}
              placeholder="sk-… or Albert token"
              oninput={(e) => ai.upsert({ ...p, apiKey: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="flex items-center gap-2">
            <span class="w-20 opacity-60">Model</span>
            <input
              class="input input-bordered input-xs flex-1 font-mono"
              value={p.model}
              oninput={(e) => ai.upsert({ ...p, model: (e.target as HTMLInputElement).value })}
            />
          </label>
          <button
            class="btn btn-error btn-xs"
            onclick={() => ai.remove(ai.activeKind)}
          >Remove {p.name}</button>
        {/if}
        <p class="text-[10px] opacity-50 italic">
          Albert API (DINUM) : https://albert.api.etalab.gouv.fr — request a token, paste it above.
          Credentials stay in localStorage on this device.
        </p>
      </div>
    {/if}

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
    {/if}
  </aside>
{/if}
