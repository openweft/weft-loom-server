// marp.ts — catalogue of Marp slide themes the in-window preview can
// render. The list is what the preview KNOWS how to style ; the real
// PDF compile uses whatever Marp + the loom-marp OCI image ship,
// which is a superset. Future work : query the image at runtime via
// a `/api/marp/themes` endpoint that walks /node_modules/@marp-team
// inside the container and merges with this static list.

export interface MarpTheme {
  id: string;
  label: string;
  // origin : 'built-in' (default, gaia, uncover ship with marp-core),
  // 'community' (popular packages like marp-theme-am, marp-theme-academic),
  // 'custom' (in-repo CSS).
  origin: 'built-in' | 'community' | 'custom';
  description: string;
  // CSS the in-window preview applies to each slide card. Inline
  // style string ; falls back to neutral colors if the theme is
  // documented but not yet styled here.
  style: string;
}

export const MARP_THEMES: MarpTheme[] = [
  // ---- Built-in (ship with marp-core) ----
  {
    id: 'default',
    label: 'Default',
    origin: 'built-in',
    description: 'Classic white background, dark text.',
    style: 'background:#fff;color:#222;border-color:#bbb',
  },
  {
    id: 'gaia',
    label: 'Gaia',
    origin: 'built-in',
    description: 'Dark purple with cream accents.',
    style: 'background:#2e2057;color:#ffd0a8;border-color:#5b3a8e',
  },
  {
    id: 'uncover',
    label: 'Uncover',
    origin: 'built-in',
    description: 'Minimal light grey, large typography.',
    style: 'background:#fafafa;color:#222;border-color:#ddd',
  },
  // ---- Community : marp-theme-am ----
  {
    id: 'am_brown',
    label: 'AM Brown',
    origin: 'community',
    description: 'Warm earth tones.',
    style: 'background:#fef9f3;color:#5d3a1f;border-color:#c8a17a',
  },
  {
    id: 'am_dark',
    label: 'AM Dark',
    origin: 'community',
    description: 'Charcoal background, near-white text.',
    style: 'background:#1e1e1e;color:#e4e4e4;border-color:#3a3a3a',
  },
  {
    id: 'am_green',
    label: 'AM Green',
    origin: 'community',
    description: 'Forest green accents on cream.',
    style: 'background:#f3f8f1;color:#1f3a1f;border-color:#7ac87a',
  },
  {
    id: 'am_blue',
    label: 'AM Blue',
    origin: 'community',
    description: 'Cool slate blue.',
    style: 'background:#f1f5f9;color:#1e3a5f;border-color:#7da3c8',
  },
  {
    id: 'am_pink',
    label: 'AM Pink',
    origin: 'community',
    description: 'Soft pink + magenta accents.',
    style: 'background:#fdf2f8;color:#831843;border-color:#f9a8d4',
  },
  {
    id: 'am_purple',
    label: 'AM Purple',
    origin: 'community',
    description: 'Royal purple gradient feel.',
    style: 'background:#f5f3ff;color:#4c1d95;border-color:#a78bfa',
  },
  {
    id: 'am_red',
    label: 'AM Red',
    origin: 'community',
    description: 'Bold red accents on cream.',
    style: 'background:#fef2f2;color:#7f1d1d;border-color:#fca5a5',
  },
  // ---- Community : marp-theme-academic ----
  {
    id: 'academic',
    label: 'Academic',
    origin: 'community',
    description: 'Conference-paper aesthetic.',
    style: 'background:#fff;color:#1a1a1a;border-color:#2a4365',
  },
  // ---- Community : popular Beamer-likes ----
  {
    id: 'beam',
    label: 'Beam',
    origin: 'community',
    description: 'LaTeX Beamer aesthetic in markdown.',
    style: 'background:#fdfbf3;color:#1a1a1a;border-color:#b08d57',
  },
  {
    id: 'rose-pine',
    label: 'Rose Pine',
    origin: 'community',
    description: 'Soft mauve palette.',
    style: 'background:#faf4ed;color:#575279;border-color:#cecacd',
  },
  {
    id: 'olive',
    label: 'Olive',
    origin: 'community',
    description: 'Muted olive-green academic.',
    style: 'background:#f7f7f0;color:#3a4a1f;border-color:#a6b87a',
  },
  // ---- Institutional themes (openweft) ----
  // Each ships as its own OCI artifact at
  // ghcr.io/openweft/weft-loom-theme-<name>:<tag> ; the
  // weft-loom-markdown image consumes them via multi-stage COPY.
  // Preview styles below mirror the brand-validated signature so
  // the in-window preview matches the PDF output of the real
  // marp-cli render.
  {
    id: 'polytechnique',
    label: 'École polytechnique',
    origin: 'community',
    description: 'PANTONE 7694C navy (École polytechnique 2021 charter).',
    style: 'background:#fff;color:#1f2226;border-color:#01426a',
  },
  {
    id: 'ip-paris',
    label: 'Institut Polytechnique de Paris',
    origin: 'community',
    description: 'Cyan-blue + green + orange triad (ip-paris.fr identity).',
    style: 'background:#fff;color:#212529;border-color:#008bd2',
  },
  {
    id: 'cnrs',
    label: 'CNRS',
    origin: 'community',
    description: 'Electric blue #0660FF + Chivo / Libre Franklin.',
    style: 'background:#fff;color:#151723;border-color:#0660ff',
  },
  {
    id: 'dinum',
    label: 'DINUM (DSFR)',
    origin: 'community',
    description: 'République française signature — Marianne blue + red.',
    style: 'background:#fff;color:#161616;border-color:#000091',
  },
  {
    id: 'paris-saclay',
    label: 'Université Paris-Saclay',
    origin: 'community',
    description: 'Aubergine #62003C (logo SVG fill) + Avenir.',
    style: 'background:#fff;color:#333;border-color:#62003c',
  },
  {
    id: 'ihes',
    label: 'IHES',
    origin: 'community',
    description: 'Navy #1C528A + Raleway (sober academic).',
    style: 'background:#fff;color:#2b2b2b;border-color:#1c528a',
  },
  // ---- Custom (in-repo) ----
  {
    id: 'minimal',
    label: 'Minimal',
    origin: 'custom',
    description: 'No borders, generous whitespace.',
    style: 'background:transparent;color:inherit;border-color:transparent',
  },
];

export function marpThemeStyle(id: string): string {
  const t = MARP_THEMES.find((x) => x.id === id);
  if (t) return t.style;
  // Unknown theme → default-ish neutral so the preview still renders.
  return 'background:#fff;color:#222;border-color:#bbb';
}
