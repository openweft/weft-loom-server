<script lang="ts">
  // ChatRoom — real-time chat between co-editors. Backed by a list part of the
  // same collab document the editor uses, so messages propagate through
  // the existing y-websocket relay — no separate channel, no extra
  // backend. Each entry is {id, clientID, name, color, avatar, text, ts}.
  //
  // History persists for the lifetime of the y-websocket room on the
  // server. A future server-side persistence layer (the seed-from-disk
  // / weft-block path the editor uses) would write chat to a sidecar
  // file too ; V0.4 follow-up.
  import { onDestroy, untrack } from 'svelte';
  import { records, encode, watch, type List, type Session } from '../collab';
  import Avatar from './Avatar.svelte';
  import type { Identity } from '../identity';

  interface Props {
    session: Session | undefined;
    identity: Identity;
    open: boolean;
    // embedded == true when ChatRoom sits inside another container
    // (left-sidebar under Collaborators) : drop the standalone drag
    // handle + `border-l` so it integrates seamlessly with the host
    // column rather than reading as a separately-docked panel.
    embedded?: boolean;
    // Accordion-style collapse — only the header bar is rendered
    // when true. Same UX as OutlinePanel / MetadataPanel inside the
    // left sidebar.
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
  }

  let { session, identity, open = $bindable(), embedded = false, collapsed = false, onToggleCollapsed }: Props = $props();

  interface Message {
    id: string;
    // Who wrote it. It used to be the awareness clientID, a number; a replica
    // identity does not fit one, so it travels as the decimal string collab
    // reports. Old messages carry a number and still render: this is only ever
    // compared and shown.
    clientID: string | number;
    name: string;
    color: string;
    avatar?: string;
    text: string;
    ts: number;
  }

  let messages = $state<Message[]>([]);
  let draft = $state('');
  let scroll: HTMLDivElement | undefined = $state();

  // Resizable panel width — drag the left edge to grow / shrink.
  // Persisted via localStorage so user's choice survives reloads.
  let width = $state<number>(
    (() => {
      try {
        const v = Number(localStorage.getItem('weft-loom-chat-width'));
        if (!Number.isNaN(v) && v >= 240 && v <= 800) return v;
      } catch {}
      return 288; // w-72 default
    })(),
  );
  let dragging = $state<boolean>(false);
  function startDrag(ev: MouseEvent) {
    ev.preventDefault();
    dragging = true;
    const startX = ev.clientX;
    const startW = width;
    function move(e: MouseEvent) {
      const next = Math.max(240, Math.min(800, startW + (startX - e.clientX)));
      width = next;
    }
    function up() {
      dragging = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('weft-loom-chat-width', String(width)); } catch {}
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  let ymsgs: List | undefined;
  // What stops watching when the session changes. A handler left registered on
  // a session nobody is looking at keeps this component alive with it.
  let unwatch: (() => void) | undefined;

  function refresh() {
    if (!ymsgs) {
      messages = [];
      return;
    }
    messages = records<Message>(ymsgs);
    if (open) {
      requestAnimationFrame(() => {
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
      });
    }
  }

  // Read the session as the effect's only reactive dep ; the body's writes
  // (messages, unreadCount, ymsgs) run untracked so they don't recursively
  // retrigger the effect. Without untrack the initial messages=[] write made
  // Svelte queue another effect pass → effect_update_depth_exceeded → blocked
  // microtask queue → file list fetch (and every other await) never resolved.
  $effect(() => {
    const live = session;
    untrack(() => {
      unwatch?.();
      unwatch = undefined;
      ymsgs = undefined;
      messages = [];
      if (!live) return;
      let stopped = false;
      unwatch = () => {
        stopped = true;
      };
      void (async () => {
        const list = await live.list('chat');
        if (stopped) return;
        ymsgs = list;
        refresh();
        // A list part reports only that it moved, so this reads it back whole.
        // That is what the views written against one do, and a chat holds
        // messages rather than the hundreds of thousands of characters a
        // document holds.
        await watch(live, {
          list: (name) => {
            if (name === 'chat' && !stopped) refresh();
          },
        });
      })().catch((err) => console.error('collab: chat', err));
    });
  });

  onDestroy(() => {
    unwatch?.();
  });

  function send() {
    const txt = draft.trim();
    if (!txt || !ymsgs || !session) return;
    const msg: Message = {
      id: cryptoRandom(),
      clientID: session.site,
      name: identity.name,
      color: identity.color,
      avatar: identity.avatar,
      text: txt,
      ts: Date.now(),
    };
    void ymsgs.append(encode(msg)).catch((err) => console.error('collab: sending', err));
    draft = '';
  }

  function cryptoRandom(): string {
    // 8 bytes hex — enough for collision-free message ids inside one
    // room. Falls back to Math.random when crypto isn't available
    // (test envs, ancient browsers).
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const b = new Uint8Array(8);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(36).slice(2, 18);
  }

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
</script>

{#if open}
  {#if !embedded}
    <!-- Left-edge drag handle : matches the Preview / AIChatPanel
         pattern so all right-docked panels share the same resize
         affordance. Persistent via localStorage. Hidden when the
         panel is embedded in the left sidebar under Collaborators. -->
    <div
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      class="w-1.5 cursor-col-resize bg-base-300 hover:bg-primary/50 active:bg-primary transition-colors flex-none"
      class:bg-primary={dragging}
      onmousedown={startDrag}
      title="Drag to resize the chat"
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
    <header class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200">
      <button
        type="button"
        class="flex items-center gap-1 min-w-0 flex-1 text-left h-full hover:bg-base-300/30"
        onclick={() => onToggleCollapsed?.()}
        title={collapsed ? 'Expand Chat' : 'Collapse Chat'}
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
          <path d="M14.56 7.44C14.28 7.16 13.9 7 13.5 7H13V4c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v5c0 1.1.9 2 2 2v1c0 .82.93 1.29 1.59.81L7 11.05v.45c0 .4.16.78.44 1.06.28.28.66.44 1.06.44h1.79l1.86 1.85c.04.05.1.09.16.11.06.03.12.04.19.04.07 0 .13-.01.19-.04.09-.04.17-.1.23-.18.05-.08.08-.18.08-.28V13h.5c.4 0 .78-.16 1.06-.44.28-.28.44-.66.44-1.06v-3c0-.4-.16-.78-.44-1.06zM6.75 10L4 12v-2H3c-.55 0-1-.45-1-1V4c0-.55.45-1 1-1h8c.55 0 1 .45 1 1v3H8.5c-.4 0-.78.16-1.06.44-.28.28-.44.66-.44 1.06V10h-.25zM14 11.5c0 .13-.05.26-.15.35-.09.1-.22.15-.35.15h-1c-.13 0-.26.05-.35.15-.1.09-.15.22-.15.35v.79l-1.15-1.14c-.04-.05-.1-.09-.16-.11-.06-.03-.12-.04-.19-.04h-2c-.13 0-.26-.05-.35-.15-.1-.09-.15-.22-.15-.35v-3c0-.13.05-.26.15-.35.09-.1.22-.15.35-.15h5c.13 0 .26.05.35.15.1.09.15.22.15.35v3z"/>
        </svg>
        <span class="font-semibold text-sm">Chat</span>
        <span class="badge badge-ghost badge-xs">{messages.length}</span>
      </button>
    </header>

    {#if !collapsed}
    <div bind:this={scroll} class="flex-1 overflow-y-auto p-2 space-y-2">
      {#if messages.length === 0}
        <p class="text-xs opacity-50 italic px-2">
          No messages yet. Start the conversation with your co-editors.
        </p>
      {/if}
      {#each messages as m (m.id)}
        <div class="flex gap-2">
          <Avatar name={m.name} color={m.color} avatar={m.avatar} size={28} title={m.name} />
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-1">
              <span class="text-xs font-semibold truncate">{m.name}</span>
              <span class="text-[10px] opacity-50">{fmtTime(m.ts)}</span>
            </div>
            <div class="text-sm whitespace-pre-wrap break-words leading-snug">{m.text}</div>
          </div>
        </div>
      {/each}
    </div>

    <form
      class="border-t border-base-300 p-2 flex gap-1"
      onsubmit={(e) => { e.preventDefault(); send(); }}
    >
      <textarea
        bind:value={draft}
        rows="2"
        class="textarea textarea-bordered textarea-sm flex-1 resize-none"
        placeholder="Message co-editors… (⌘+Enter to send)"
        onkeydown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      ></textarea>
      <button class="btn btn-primary btn-sm self-end" type="submit" disabled={draft.trim() === ''}>
        Send
      </button>
    </form>
    {/if}
  </aside>
{/if}
