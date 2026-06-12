// theme.ts — picks the daisyUI theme and persists the choice in
// localStorage so the next session lands on the same one. The
// "auto" option follows the OS preference via the
// `prefers-color-scheme` media query.

export type Theme = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'weft-loom-theme';

export function loadTheme(): Theme {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'auto') return v;
  return 'auto';
}

export function applyTheme(theme: Theme) {
  const html = document.documentElement;
  if (theme === 'auto') {
    // daisyUI 5 reads `data-theme` ; the `--prefersdark` directive
    // in app.css makes the absence of data-theme pick light or dark
    // based on prefers-color-scheme. Remove the attribute to follow
    // the OS.
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('data-theme', theme);
  }
  localStorage.setItem(STORAGE_KEY, theme);
}

// iconForPath maps a file extension to a small glyph the FileExplorer
// uses as a VSCode-style file-type indicator. The chosen icon theme
// is read from localStorage at every call ; switching themes via the
// Settings combo updates icons everywhere on the next render.
//
// For the `seti` theme we look up the official jesseweed/seti-ui
// font's codepoint per extension + return the matching PUA char.
// The renderer wraps icon spans in `class="seti-icon"` so the seti
// font kicks in only for those code points (emoji are unaffected
// because the seti font doesn't claim their Unicode range).
import { ICON_THEMES, loadIconTheme } from './iconThemes';
import { SETI_EXT_TO_CODEPOINT } from './setiMappings';

export function iconForPath(path: string, isDir = false): string {
  const themeName = loadIconTheme();
  const theme = ICON_THEMES[themeName];
  if (themeName === 'seti') {
    // Seti font ships its own folder + default glyphs in the PUA.
    // Folders use codepoint E032 ; unknown extensions fall through
    // to E023 (the 'default' file glyph) ; both render via the
    // `seti-icon` font-family wrapping span on the call site.
    if (isDir) return '';
    const lower = path.toLowerCase();
    const dot = lower.lastIndexOf('.');
    const ext = dot < 0 ? '' : lower.slice(dot + 1);
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const code = SETI_EXT_TO_CODEPOINT[ext] ?? SETI_EXT_TO_CODEPOINT[base] ?? '0023';
    return String.fromCharCode(parseInt(code, 16));
  }
  if (isDir) return theme.dir;
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return theme.defaultFile;
  const ext = lower.slice(dot + 1);
  return theme.byExt[ext] ?? theme.defaultFile;
}

// languageForPath maps a file extension to the editor language the
// CodeMirror lang-pack + PreviewPane understand. Unknown extensions
// fall back to 'markdown' so the preview pane still shows something
// useful.
export function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'markdown';
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case 'md':
    case 'markdown':
    case 'mdown':
      return 'markdown';
    case 'tex':
    case 'sty':
    case 'cls':
    case 'bib':
      return 'latex';
    case 'go':
      return 'go';
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hpp':
      return 'cpp';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'typescript';
    case 'svelte':
      return 'svelte';
    case 'rtf':
      return 'rtf';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'toml':
      return 'toml';
    case 'hcl':
    case 'hcl2':
    case 'tf':
    case 'tfvars':
    case 'tfstate':
    case 'nomad':
    case 'pkr':       // Packer (HCL2)
    case 'pkrvars':   // Packer var files
    case 'tftpl':     // Terraform template files
      return 'hcl';
    case 'rb':
    case 'ruby':
      return 'ruby';
    case 'pl':
    case 'pm':
    case 'perl':
      return 'perl';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'zig':
      return 'zig';
    case 'html':
    case 'htm':
    case 'xhtml':
    case 'xml':
    case 'svg':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'json':
      return 'json';
    default:
      return 'markdown';
  }
}
