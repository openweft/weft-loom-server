// settings.svelte.ts — global editor preferences store. One singleton
// $state-backed object that every editor + preview-style component
// reads from. Persisted to localStorage on every write so the
// session restores cleanly across reloads.
//
// Sticking to .svelte.ts (not .ts) so $state works at module scope —
// see `feedback_svelte5_runes_ts` memory for why.

export interface FontSettings {
  family: string;
  size: number;      // px
  lineHeight: number; // unitless
}

// Optional Vim / Emacs keymap layered on top of the default CM6
// bindings. Lazy-loaded from editorKeymap.ts so the cold-load bundle
// stays slim — see Editor.svelte's keymapCompartment + $effect.
export type EditorKeymap = 'default' | 'vim' | 'emacs';

export interface EditorSettings {
  font: FontSettings;
  tabSize: number;
  insertSpaces: boolean;
  lineNumbers: boolean;
  wordWrap: boolean;
  bracketMatching: boolean;
  autocomplete: boolean;
  // Minimap : a thumbnail of the document docked on the right side
  // of the editor. Useful for navigating long files ; OFF by default
  // so first-time users aren't surprised by the extra column.
  minimap: boolean;
  // `theme` is the daisyUI theme name applied at document level
  // (light/dark/cupcake/dracula/...). The Editor reads this to pick
  // the matching CodeMirror palette.
  theme: string;
  // Modal-editor preference — 'default' keeps the stock CM6 keymap,
  // 'vim' / 'emacs' load the corresponding @replit/codemirror-* pack
  // and layer it on top via a Compartment.
  editorKeymap: EditorKeymap;
  // Zotero library sync : the user pastes their numeric userID +
  // a personal API key (https://www.zotero.org/settings/keys) into
  // the SettingsPanel ; the BibliographyPanel exposes a "Sync from
  // Zotero" button that POSTs to /api/projects/{name}/zotero/sync
  // and appends the returned BibTeX to refs.bib. Both fields default
  // to empty — the button stays disabled until the user fills them in.
  zoteroUserId: string;
  zoteroApiKey: string;
}

const DEFAULT: EditorSettings = {
  font: {
    family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", Consolas, monospace',
    size: 14,
    lineHeight: 1.45,
  },
  tabSize: 2,
  insertSpaces: true,
  lineNumbers: true,
  wordWrap: false,
  bracketMatching: true,
  autocomplete: true,
  minimap: true,
  theme: 'cupcake',
  editorKeymap: 'default',
  zoteroUserId: '',
  zoteroApiKey: '',
};

const STORAGE_KEY = 'weft-loom-editor-settings-v1';

function load(): EditorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT, font: { ...DEFAULT.font } };
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    return {
      ...DEFAULT,
      ...parsed,
      font: { ...DEFAULT.font, ...(parsed.font ?? {}) },
    };
  } catch {
    return { ...DEFAULT, font: { ...DEFAULT.font } };
  }
}

class SettingsStore {
  current = $state<EditorSettings>(load());

  set<K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) {
    this.current = { ...this.current, [key]: value };
    this.persist();
  }

  setFont(font: Partial<FontSettings>) {
    this.current = { ...this.current, font: { ...this.current.font, ...font } };
    this.persist();
  }

  reset() {
    this.current = { ...DEFAULT, font: { ...DEFAULT.font } };
    this.persist();
  }

  private persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current)); } catch { /* ignore */ }
  }
}

export const settings = new SettingsStore();

// ----- Per-language compile-command overrides ----------------------
//
// Surfaces in SettingsPanel as a small table {language: command} so
// users can pin project-specific build commands without touching the
// server defaults. Sent on every Run via CompileSpec.command — the
// server's runCommandFor() takes the verbatim string when present
// and runs it inside the workspace μVM via `sh -c`.
//
// Storage : separate localStorage key (versioned -v1) so adding new
// languages later doesn't require a migration of the editor-settings
// blob.

export type CompileCommands = Record<string, string>;

const COMPILE_CMD_KEY = 'weft-loom-compile-commands-v1';

function loadCompileCommands(): CompileCommands {
  try {
    const raw = localStorage.getItem(COMPILE_CMD_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as CompileCommands;
    return {};
  } catch {
    return {};
  }
}

class CompileCommandStore {
  current = $state<CompileCommands>(loadCompileCommands());

  get(language: string): string {
    return this.current[language] ?? '';
  }

  set(language: string, command: string) {
    const trimmed = command.trim();
    const next = { ...this.current };
    if (trimmed === '') {
      delete next[language];
    } else {
      next[language] = trimmed;
    }
    this.current = next;
    this.persist();
  }

  clear() {
    this.current = {};
    this.persist();
  }

  private persist() {
    try { localStorage.setItem(COMPILE_CMD_KEY, JSON.stringify(this.current)); } catch { /* ignore */ }
  }
}

export const compileCommands = new CompileCommandStore();

// ----- Per-project LaTeX compiler selection -----------------------
//
// The CompilerSelector UI binds against this store. Engine = pdflatex
// / lualatex / xelatex. Bib = bibtex / biber. One pair per project so
// switching projects restores the previous choice ; the backend
// `start-compile` body carries `engine` + `bib` so the dispatcher
// invokes the matching binary inside the workspace μVM.
//
// Default = pdflatex + bibtex (broadest TeX Live coverage, what
// pre-V0.7 hard-coded).

export type LatexEngine = 'pdflatex' | 'lualatex' | 'xelatex' | 'gotex';
export type BibEngine = 'bibtex' | 'biber';

export interface CompilerChoice {
  engine: LatexEngine;
  bib: BibEngine;
}

const COMPILER_CHOICE_KEY = 'weft-loom-compiler-choices-v1';

function loadCompilerChoices(): Record<string, CompilerChoice> {
  try {
    const raw = localStorage.getItem(COMPILER_CHOICE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, CompilerChoice>;
    return {};
  } catch {
    return {};
  }
}

const COMPILER_DEFAULT: CompilerChoice = { engine: 'pdflatex', bib: 'bibtex' };

class CompilerChoiceStore {
  current = $state<Record<string, CompilerChoice>>(loadCompilerChoices());

  get(project: string): CompilerChoice {
    const c = this.current[project];
    if (!c) return { ...COMPILER_DEFAULT };
    return { ...COMPILER_DEFAULT, ...c };
  }

  setEngine(project: string, engine: LatexEngine) {
    const next = { ...this.current };
    next[project] = { ...this.get(project), engine };
    this.current = next;
    this.persist();
  }

  setBib(project: string, bib: BibEngine) {
    const next = { ...this.current };
    next[project] = { ...this.get(project), bib };
    this.current = next;
    this.persist();
  }

  private persist() {
    try { localStorage.setItem(COMPILER_CHOICE_KEY, JSON.stringify(this.current)); } catch { /* ignore */ }
  }
}

export const compilerChoices = new CompilerChoiceStore();

// VSCode theme import — TextMate-style colour theme JSON, as
// exported by VSCode's `Developer: Generate Color Theme From
// Current Settings`. We keep the raw JSON + extract the few fields
// the editor needs (editor background / foreground / line number
// / selection / matching bracket).
export interface VSCodeTheme {
  name: string;
  type: 'light' | 'dark' | 'hc-dark' | 'hc-light';
  colors: Record<string, string>;
  tokenColors?: Array<{
    name?: string;
    scope?: string | string[];
    settings: { foreground?: string; background?: string; fontStyle?: string };
  }>;
}

const VSCODE_THEMES_KEY = 'weft-loom-vscode-themes-v1';

class VSCodeThemeStore {
  themes = $state<VSCodeTheme[]>(loadVSCodeThemes());
  active = $state<string | null>(localStorage.getItem('weft-loom-vscode-theme-active') || null);

  add(theme: VSCodeTheme) {
    this.themes = [...this.themes.filter((t) => t.name !== theme.name), theme];
    try { localStorage.setItem(VSCODE_THEMES_KEY, JSON.stringify(this.themes)); } catch { /* ignore */ }
  }
  setActive(name: string | null) {
    this.active = name;
    try {
      if (name) localStorage.setItem('weft-loom-vscode-theme-active', name);
      else localStorage.removeItem('weft-loom-vscode-theme-active');
    } catch { /* ignore */ }
  }
  remove(name: string) {
    this.themes = this.themes.filter((t) => t.name !== name);
    if (this.active === name) this.active = null;
    try { localStorage.setItem(VSCODE_THEMES_KEY, JSON.stringify(this.themes)); } catch { /* ignore */ }
  }
  resolve(): VSCodeTheme | null {
    return this.themes.find((t) => t.name === this.active) ?? null;
  }
}

function loadVSCodeThemes(): VSCodeTheme[] {
  try {
    const raw = localStorage.getItem(VSCODE_THEMES_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as VSCodeTheme[];
  } catch {
    return [];
  }
}

export const vscodeThemes = new VSCodeThemeStore();
