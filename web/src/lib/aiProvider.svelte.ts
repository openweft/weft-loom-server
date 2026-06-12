// aiProvider.svelte.ts — AI assistant provider settings store.
// Holds the configured providers + the currently-active one. The
// AIChatPanel posts directly to the selected provider's HTTP endpoint
// (Albert / OpenAI / OpenRouter / a local Ollama instance) instead
// of going through the loom-server stub — that way the user's
// credentials never leave the browser.
//
// Albert (https://albert.api.etalab.gouv.fr) is the French DINUM
// state platform ; OpenAI-compatible chat-completions API, Bearer
// token auth. We surface it as a first-class provider since the
// user explicitly asked for it.

export type ProviderKind = 'albert' | 'openai' | 'openrouter' | 'anthropic' | 'ollama' | 'custom' | 'server';

export interface AIProvider {
  kind: ProviderKind;
  // Human-visible label.
  name: string;
  // OpenAI-compatible base URL (everything before `/chat/completions`).
  // Ignored for `server` (uses the loom-server's own /chat endpoint).
  baseURL: string;
  // Bearer token / API key. Stored in localStorage — see warning in
  // the Settings panel about copying keys to disk.
  apiKey: string;
  // Default model id (e.g. `gpt-4o-mini`, `meta-llama/Llama-3-70b`,
  // `claude-haiku-4-5-20251001`).
  model: string;
}

const DEFAULTS: Record<ProviderKind, Pick<AIProvider, 'name' | 'baseURL' | 'model'>> = {
  server: {
    name: 'weft-loom server stub',
    baseURL: '',
    model: '',
  },
  albert: {
    name: 'Albert (DINUM)',
    baseURL: 'https://albert.api.etalab.gouv.fr/v1',
    model: 'AgentPublic/llama3-instruct-8b',
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-haiku-4-5',
  },
  anthropic: {
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-4-5-20251001',
  },
  ollama: {
    name: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    model: 'llama3',
  },
  custom: {
    name: 'Custom OpenAI-compatible',
    baseURL: '',
    model: '',
  },
};

const KEY = 'weft-loom-ai-providers-v1';

function load(): { providers: AIProvider[]; activeKind: ProviderKind } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  // Default config : the server stub is always available so a fresh
  // session has a working AI panel without any setup.
  return {
    providers: [{ kind: 'server', name: DEFAULTS.server.name, baseURL: '', apiKey: '', model: '' }],
    activeKind: 'server',
  };
}

class AIStore {
  providers = $state<AIProvider[]>(load().providers);
  activeKind = $state<ProviderKind>(load().activeKind);

  active(): AIProvider | undefined {
    return this.providers.find((p) => p.kind === this.activeKind);
  }

  upsert(p: AIProvider) {
    const i = this.providers.findIndex((x) => x.kind === p.kind);
    if (i >= 0) this.providers[i] = { ...p };
    else this.providers = [...this.providers, p];
    this.providers = [...this.providers]; // trigger reactivity
    this.persist();
  }

  remove(kind: ProviderKind) {
    if (kind === 'server') return; // can't remove the stub
    this.providers = this.providers.filter((p) => p.kind !== kind);
    if (this.activeKind === kind) this.activeKind = 'server';
    this.persist();
  }

  setActive(kind: ProviderKind) {
    if (!this.providers.find((p) => p.kind === kind)) return;
    this.activeKind = kind;
    this.persist();
  }

  defaultsFor(kind: ProviderKind) {
    return DEFAULTS[kind];
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        providers: this.providers,
        activeKind: this.activeKind,
      }));
    } catch { /* ignore */ }
  }
}

export const ai = new AIStore();
