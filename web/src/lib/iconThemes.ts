// iconThemes.ts — file-type icon themes for the FileExplorer +
// QuickOpen + breadcrumb. Each theme maps an extension → a glyph ;
// the chosen theme is stored in localStorage and read by
// iconForPath() at every render.
//
// Themes ship as plain ext→string maps so adding a new theme is one
// dictionary literal — no font load, no SVG import.
//
// Alignment with VSCode's canonical icon-theme catalogue
// (https://code.visualstudio.com/blogs/2016/09/08/icon-themes) :
//
//   VSCode built-in    : Minimal (Visual Studio Code), Seti (Visual Studio Code)
//   Popular Marketplace : Material Icon Theme, vscode-icons
//
// `minimal`, `seti`, `material`, and `vscode-icons` below are ports
// of those four. They keep VSCode's display names verbatim so users
// recognise the option in the Settings menu. The rest (`emoji`,
// `codicons-mono`, `nerd-glyphs`, `colored`, `cupertino`, `redmond`)
// are openweft-original themes — labelled `(openweft)` so users
// can tell them apart at a glance.

export type IconThemeName = 'emoji' | 'minimal' | 'codicons-mono' | 'nerd-glyphs' | 'colored' | 'material' | 'vscode-icons' | 'cupertino' | 'redmond' | 'seti';

export interface IconTheme {
  name: string;       // Display label for the Settings combo
  key: IconThemeName; // Persisted key
  byExt: Record<string, string>;
  dir: string;
  defaultFile: string;
}

// Base map shared by every theme — pulled from the original emoji
// set so an exhaustive list of extensions stays in one place. Each
// theme overrides the extensions it has custom glyphs for ; missing
// entries fall back to defaultFile.
const EMOJI: Record<string, string> = {
  md: '📝', markdown: '📝', mdown: '📝',
  tex: '📐', sty: '📐', cls: '📐',
  bib: '📚',
  pdf: '📕',
  go: '🐹', py: '🐍', rs: '🦀',
  js: '🟨', mjs: '🟨', cjs: '🟨',
  ts: '🟦', tsx: '🟦', jsx: '🟦', mts: '🟦', cts: '🟦',
  svelte: '🔶',
  c: '⚙️', cc: '⚙️', cpp: '⚙️', cxx: '⚙️', h: '⚙️', hpp: '⚙️',
  json: '🔧', yaml: '🔧', yml: '🔧', toml: '🔧', hcl: '🔧', tf: '🔧', tfvars: '🔧',
  hcl2: '🔧', tfstate: '🔧', tftpl: '🔧', pkr: '🔧', pkrvars: '🔧', nomad: '🔧',
  sh: '🐚', bash: '🐚', zsh: '🐚',
  css: '🎨', scss: '🎨', sass: '🎨',
  html: '🌐', htm: '🌐', xhtml: '🌐', xml: '🌐',
  svg: '🖼️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️',
  rb: '💎', pl: '🐪', pm: '🐪', zig: '⚡',
  lock: '🔒',
  ipynb: '📓',
  log: '📋',
  txt: '📄',
  rtf: '📰',
};

// Minimal mono : single-character ASCII glyphs, fastest to render +
// keeps the explorer compact. No colour cues.
const MINIMAL: Record<string, string> = {
  md: '#', tex: 'T', bib: 'B', pdf: 'P',
  go: 'G', py: 'P', rs: 'R',
  js: 'J', ts: 'T', svelte: 'S',
  c: 'C', cc: 'C', cpp: 'C', h: 'H',
  json: '{', yaml: 'Y', toml: 'Y', hcl: 'H',
  hcl2: 'H', tfstate: 'H', tftpl: 'H', pkr: 'H', pkrvars: 'H', nomad: 'H',
  sh: '$',
  css: '*', html: '<',
  svg: 'I', png: 'I', jpg: 'I',
  rb: 'R', pl: 'P', zig: 'Z',
};

// Codicons-mono : the same shape family as VSCode's @vscode/codicons
// font but expressed with unicode "geometric"-like characters. Looks
// uniform + tidy in dense lists.
const CODICONS_MONO: Record<string, string> = {
  md: '◧', markdown: '◧',
  tex: '∑', sty: '∑', cls: '∑', bib: '⌘',
  pdf: '⏍',
  go: '▣', py: '▣', rs: '▣',
  js: '◉', ts: '◉', svelte: '◉', jsx: '◉', tsx: '◉',
  c: '◆', cc: '◆', cpp: '◆', cxx: '◆', h: '◇', hpp: '◇',
  json: '⚙', yaml: '⚙', yml: '⚙', toml: '⚙', hcl: '⚙', tf: '⚙',
  hcl2: '⚙', tfstate: '⚙', tftpl: '⚙', pkr: '⚙', pkrvars: '⚙', nomad: '⚙',
  sh: '⌬', bash: '⌬', zsh: '⌬',
  css: '✦', scss: '✦', sass: '✦',
  html: '◫', htm: '◫', xml: '◫',
  svg: '◈', png: '◈', jpg: '◈', jpeg: '◈', gif: '◈', webp: '◈',
  rb: '◆', pl: '◆', zig: '◆',
  ipynb: '⊞',
  log: '☰',
  lock: '⌐',
};

// Nerd-glyphs : unicode "powerline / nerd-font-ish" code points.
// Renders best with a Nerd Font installed ; falls back to a square
// box on default fonts, so a note in the Settings panel warns the
// user.
const NERD: Record<string, string> = {
  md: '',
  tex: '', bib: '',
  pdf: '',
  go: '', py: '', rs: '',
  js: '', ts: '', svelte: '', jsx: '', tsx: '',
  c: '', cpp: '', h: '', hpp: '',
  json: '', yaml: '', yml: '', toml: '', hcl: '',
  hcl2: '', tfstate: '', tftpl: '', pkr: '', pkrvars: '', nomad: '',
  sh: '', bash: '', zsh: '',
  css: '', scss: '',
  html: '', htm: '', xml: '',
  svg: 'ﰟ', png: '', jpg: '', jpeg: '', gif: '',
  rb: '', pl: '', zig: '',
  ipynb: '',
  log: '',
  lock: '',
};

// Colored : same shape as emoji but biased toward the simpler
// universal coverage (no fancy compound emoji). Best for terminals
// + low-DPI screens.
const COLORED: Record<string, string> = {
  md: '🟢', tex: '🟣', bib: '🟤', pdf: '🔴',
  go: '🐹', py: '🐍', rs: '🦀',
  js: '🟨', ts: '🟦', svelte: '🟧',
  c: '🟪', cpp: '🟪', h: '⬛',
  json: '🟫', yaml: '🟫', toml: '🟫', hcl: '🟫',
  hcl2: '🟫', tfstate: '🟫', tftpl: '🟫', pkr: '🟫', pkrvars: '🟫', nomad: '🟫',
  sh: '⬜',
  css: '🟩', html: '🟪',
  svg: '🖼️', png: '🖼️', jpg: '🖼️',
  rb: '💎', pl: '🐪', zig: '⚡',
};

// Material Icon Theme port — approximation of the popular
// material-extensions/vscode-material-icon-theme palette using
// emoji + colored squares that mimic its signature look (colored
// rounded rectangles with a language glyph). Not a 1:1 SVG port :
// shipping the full ~5 MB SVG set is overkill for the editor's
// dense file list ; the most-frequently-seen language colours line
// up with their Material counterparts.
const MATERIAL: Record<string, string> = {
  // Markup + docs : blue family.
  md: '📘', markdown: '📘', mdown: '📘',
  tex: '🟦', sty: '🟦', cls: '🟦',
  bib: '📓',
  pdf: '🔴',
  // Backend langs.
  go: '🐹', py: '🐍', rs: '🦀',
  // JS / TS / Svelte trio — Material gives these strong identity.
  js: '🟨', mjs: '🟨', cjs: '🟨', jsx: '🟨',
  ts: '🟦', tsx: '🟦', mts: '🟦', cts: '🟦',
  svelte: '🟧',
  // System.
  c: '🟦', cc: '🟦', cpp: '🟦', cxx: '🟦', h: '⬜', hpp: '⬜',
  // Data / config — Material colours these distinctly.
  json: '🟨', yaml: '🟥', yml: '🟥', toml: '🟫', hcl: '🟪', tf: '🟪', tfvars: '🟪',
  hcl2: '🟪', tfstate: '🟪', tftpl: '🟪', pkr: '🟪', pkrvars: '🟪', nomad: '🟪',
  // Shell + scripting.
  sh: '🟩', bash: '🟩', zsh: '🟩',
  rb: '🟥', pl: '🟦', zig: '🟧',
  // Style + web.
  css: '🟦', scss: '🟧', sass: '🟧',
  html: '🟧', htm: '🟧', xhtml: '🟧', xml: '🟪',
  // Media.
  svg: '🟪', png: '🟦', jpg: '🟦', jpeg: '🟦', gif: '🟦', webp: '🟦',
  // Notebooks + logs.
  ipynb: '🟧',
  log: '⬜',
  // Locks / configs flagged in Material's UI.
  lock: '🔒',
  // Common bare filenames Material treats specially — keyed by full
  // name in fileNames in the real theme, we approximate by mapping
  // their typical extensions.
  env: '🟢',
  gitignore: '⬛',
};

// Cupertino — Apple HIG-flavoured palette. Rounded geometric
// shapes + Apple emoji shapes that render natively on macOS / iOS.
// Where Apple ships an emoji that matches the file type we use it,
// otherwise we use the soft rounded square ⬤ ◉ family with subtle
// hue cues.
const CUPERTINO: Record<string, string> = {
  md: '📓', markdown: '📓', mdown: '📓',
  tex: '⌘', sty: '⌘', cls: '⌘',
  bib: '📑',
  pdf: '📕',
  go: '🐹', py: '🐍', rs: '🦀',
  js: '🌕', mjs: '🌕', cjs: '🌕', jsx: '🌕',
  ts: '🌐', tsx: '🌐', mts: '🌐', cts: '🌐',
  svelte: '🔆',
  c: '⚙', cc: '⚙', cpp: '⚙', cxx: '⚙', h: '◌', hpp: '◌',
  json: '{', yaml: '⌥', yml: '⌥', toml: '⌥', hcl: '✦', tf: '✦', tfvars: '✦',
  hcl2: '✦', tfstate: '✦', tftpl: '✦', pkr: '✦', pkrvars: '✦', nomad: '✦',
  sh: '⌘', bash: '⌘', zsh: '⌘',
  rb: '◇', pl: '◇', zig: '◈',
  css: '⌘', scss: '⌘', sass: '⌘',
  html: '◉', htm: '◉', xhtml: '◉', xml: '◉',
  svg: '⬛', png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', webp: '🖼',
  ipynb: '⌘',
  log: '☰',
  lock: '🔒',
};

// Redmond — Windows 11 / Fluent-flavoured palette. Sharp angular
// glyphs (◼ ◆ ▣ ▢) that mirror Microsoft's Segoe Fluent Icons
// aesthetic. Avoids emoji entirely so the look stays uniform across
// dark / light themes — the dense angular grid is the signature.
const REDMOND: Record<string, string> = {
  md: '▣', markdown: '▣', mdown: '▣',
  tex: '◆', sty: '◆', cls: '◆',
  bib: '▤',
  pdf: '▥',
  go: '◊', py: '◇', rs: '◈',
  js: '◧', mjs: '◧', cjs: '◧', jsx: '◧',
  ts: '◨', tsx: '◨', mts: '◨', cts: '◨',
  svelte: '◑',
  c: '◫', cc: '◫', cpp: '◫', cxx: '◫', h: '◰', hpp: '◰',
  json: '⌬', yaml: '⌬', yml: '⌬', toml: '⌬', hcl: '⏣', tf: '⏣', tfvars: '⏣',
  hcl2: '⏣', tfstate: '⏣', tftpl: '⏣', pkr: '⏣', pkrvars: '⏣', nomad: '⏣',
  sh: '◰', bash: '◰', zsh: '◰',
  rb: '◇', pl: '◇', zig: '◈',
  css: '◐', scss: '◐', sass: '◐',
  html: '◑', htm: '◑', xhtml: '◑', xml: '◑',
  svg: '▦', png: '▩', jpg: '▩', jpeg: '▩', gif: '▩', webp: '▩',
  ipynb: '▦',
  log: '⏤',
  lock: '⌐',
};

// vscode-icons port : the original (Roberto Huertas, 5M+ installs)
// ships PNG/SVG icons with vibrant per-language hues. We can't bundle
// the SVG library in a glyph-based set, so this port uses the most
// recognisable per-language emoji the source theme is associated
// with. Different intent from `emoji` : here we picked the visual
// cues vscode-icons users specifically learned to look for (gopher
// for Go, snake for Python, etc).
const VSCODE_ICONS: Record<string, string> = {
  md: '📝', markdown: '📝', mdown: '📝',
  tex: '📐', sty: '📐', cls: '📐', bib: '📚',
  pdf: '📕',
  go: '🐹', py: '🐍', rs: '🦀',
  js: '🟨', mjs: '🟨', cjs: '🟨',
  ts: '🟦', tsx: '🟦', jsx: '🟦', mts: '🟦', cts: '🟦',
  svelte: '🔶', vue: '🟩',
  c: '🔷', cc: '➕', cpp: '➕', cxx: '➕', h: '🔷', hpp: '🔷',
  java: '☕', kt: '🟪',
  json: '🟫', yaml: '📜', yml: '📜', toml: '📜',
  hcl: '🟪', hcl2: '🟪', tf: '🟪', tfvars: '🟪', pkr: '🟪', nomad: '🟪',
  sh: '🐚', bash: '🐚', zsh: '🐚', fish: '🐠',
  css: '🎨', scss: '🎨', sass: '🎨',
  html: '🌐', htm: '🌐', xhtml: '🌐', xml: '🌐',
  svg: '🖼️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️',
  rb: '💎', pl: '🐪', pm: '🐪', zig: '⚡',
  lock: '🔒',
  ipynb: '📓',
  log: '📋',
  txt: '📄',
  dockerfile: '🐳', docker: '🐳',
  gitignore: '🔖', gitattributes: '🔖',
};

// Seti — VSCode's "Seti" (vs-seti) icon theme uses the Seti UI font
// (Nerd Font subset). The Private-Use-Area code points below match
// the Seti UI font's icon points ; when a Nerd Font or Seti UI font
// is installed in the browser they render as the proper Seti icons.
// Without a font the boxes show as tofu — the Settings panel notes
// this so the user knows to install a Nerd Font.
const SETI: Record<string, string> = {
  md: '', markdown: '', mdown: '',
  tex: '', sty: '', cls: '',
  bib: '',
  pdf: '',
  go: '', py: '', rs: '',
  js: '', mjs: '', cjs: '', jsx: '',
  ts: '', tsx: '', mts: '', cts: '',
  svelte: '',
  c: '', cc: '', cpp: '', cxx: '', h: '', hpp: '',
  json: '', yaml: '', yml: '', toml: '', hcl: '', tf: '', tfvars: '',
  hcl2: '', tfstate: '', tftpl: '', pkr: '', pkrvars: '', nomad: '',
  sh: '', bash: '', zsh: '',
  rb: '', pl: '', zig: '',
  css: '', scss: '', sass: '',
  html: '', htm: '', xhtml: '', xml: '',
  svg: '', png: '', jpg: '', jpeg: '', gif: '', webp: '',
  ipynb: '',
  log: '',
  lock: '',
};

export const ICON_THEMES: Record<IconThemeName, IconTheme> = {
  // VSCode-canonical names (kept verbatim so users recognise them).
  minimal: { name: 'Minimal (Visual Studio Code)', key: 'minimal', byExt: MINIMAL, dir: '▸', defaultFile: '·' },
  seti: { name: 'Seti (Visual Studio Code)', key: 'seti', byExt: SETI, dir: '', defaultFile: '' },
  material: { name: 'Material Icon Theme', key: 'material', byExt: MATERIAL, dir: '🗂️', defaultFile: '📄' },
  'vscode-icons': { name: 'vscode-icons', key: 'vscode-icons', byExt: VSCODE_ICONS, dir: '📁', defaultFile: '📄' },
  // openweft-original alternatives — non-VSCode-equivalent palettes
  // each tuned to a different aesthetic. Labelled `(openweft)` so
  // they're easy to spot in the Settings combo.
  emoji: { name: 'Emoji (openweft)', key: 'emoji', byExt: EMOJI, dir: '📁', defaultFile: '📄' },
  'codicons-mono': { name: 'Codicons mono (openweft)', key: 'codicons-mono', byExt: CODICONS_MONO, dir: '▾', defaultFile: '▢' },
  'nerd-glyphs': { name: 'Nerd glyphs (openweft, font required)', key: 'nerd-glyphs', byExt: NERD, dir: '', defaultFile: '' },
  colored: { name: 'Colored squares (openweft)', key: 'colored', byExt: COLORED, dir: '📁', defaultFile: '📄' },
  cupertino: { name: 'Cupertino (openweft, macOS-flavoured)', key: 'cupertino', byExt: CUPERTINO, dir: '🗂', defaultFile: '◌' },
  redmond: { name: 'Redmond (openweft, Windows-flavoured)', key: 'redmond', byExt: REDMOND, dir: '▤', defaultFile: '▢' },
};

const KEY = 'weft-loom-icon-theme';

export function loadIconTheme(): IconThemeName {
  try {
    const v = localStorage.getItem(KEY) as IconThemeName | null;
    if (v && ICON_THEMES[v]) return v;
  } catch { /* ignore */ }
  return 'emoji';
}

export function saveIconTheme(name: IconThemeName) {
  try {
    localStorage.setItem(KEY, name);
    // Fire a storage event so other panes (FileExplorer, QuickOpen)
    // refresh their iconForPath() callers without a manual re-render
    // sweep. Direct dispatch — the same-tab storage event isn't
    // fired by the platform.
    window.dispatchEvent(new CustomEvent('weft-loom-icon-theme-change', { detail: name }));
  } catch { /* ignore */ }
}
