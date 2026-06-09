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
    case 'ts':
    case 'tsx':
      return 'javascript';
    default:
      return 'markdown';
  }
}
