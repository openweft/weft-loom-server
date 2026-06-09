// marpAutocomplete.ts — CodeMirror 6 autocomplete for Marp YAML
// front-matter. Two modes :
//
//   1. KEY mode  — cursor at the start of a line inside the
//      front-matter, before any ":". Suggests known Marp directives.
//   2. VALUE mode — cursor after "key:" on a line. Suggests valid
//      values for the directive on that line.
//
// All directives are sourced from the Marp Core 4.x reference + the
// most common community packages. Values that are free-form (e.g.
// "header", "style") return null from the value suggester so the
// autocomplete UI doesn't get in the user's way.

import { CompletionContext, type CompletionResult, type Completion } from '@codemirror/autocomplete';
import { MARP_THEMES } from './marp';

// inFrontMatter returns true when pos sits inside a "---\n...\n---"
// block at the top of the document. Lenient on the closing fence so
// the autocomplete works while the user is still editing the block.
function inFrontMatter(doc: string, pos: number): boolean {
  if (!doc.startsWith('---')) return false;
  const closeIdx = doc.indexOf('\n---', 3);
  if (closeIdx < 0) return pos > 3;
  return pos < closeIdx + 4;
}

interface Directive {
  key: string;
  description: string;
  // type drives the value suggester :
  //   'enum'     — fixed list of allowed values
  //   'bool'     — true / false
  //   'theme'    — Marp theme catalogue
  //   'color'    — common CSS colors + hex hint
  //   'size'     — preset aspect ratios
  //   'lang'     — common language codes
  //   'freeform' — no suggestions ; user types whatever
  type:
    | 'enum'
    | 'bool'
    | 'theme'
    | 'color'
    | 'size'
    | 'lang'
    | 'freeform';
  enum?: Array<{ value: string; info?: string }>;
}

// DIRECTIVES is the canonical Marp directive catalogue. New entries
// here surface in both key + value autocomplete with zero extra
// wiring.
const DIRECTIVES: Directive[] = [
  { key: 'marp', description: 'Enable Marp parsing for this file', type: 'bool' },
  { key: 'theme', description: 'Slide theme', type: 'theme' },
  { key: 'paginate', description: 'Show page numbers', type: 'bool' },
  {
    key: 'size',
    description: 'Slide aspect ratio',
    type: 'size',
  },
  { key: 'header', description: 'Page header text (HTML allowed)', type: 'freeform' },
  { key: 'footer', description: 'Page footer text (HTML allowed)', type: 'freeform' },
  {
    key: 'class',
    description: 'Theme-defined slide class (global)',
    type: 'enum',
    enum: [
      { value: 'lead', info: 'Centered hero layout (built-in themes)' },
      { value: 'invert', info: 'Swap foreground / background (gaia, uncover)' },
    ],
  },
  {
    key: '_class',
    description: 'Theme-defined slide class (local to next slide)',
    type: 'enum',
    enum: [
      { value: 'lead', info: 'Centered hero layout' },
      { value: 'invert', info: 'Swap fg / bg' },
    ],
  },
  { key: 'style', description: 'Inline CSS (use | for multiline)', type: 'freeform' },
  { key: 'backgroundColor', description: 'Slide background color', type: 'color' },
  { key: 'color', description: 'Slide text color', type: 'color' },
  { key: 'backgroundImage', description: 'Background image URL', type: 'freeform' },
  {
    key: 'backgroundPosition',
    description: 'Background image position',
    type: 'enum',
    enum: [
      { value: 'center' }, { value: 'top' }, { value: 'bottom' },
      { value: 'left' }, { value: 'right' },
      { value: 'top left' }, { value: 'top right' },
      { value: 'bottom left' }, { value: 'bottom right' },
    ],
  },
  {
    key: 'backgroundSize',
    description: 'Background image sizing',
    type: 'enum',
    enum: [
      { value: 'cover', info: 'Crop to fill slide' },
      { value: 'contain', info: 'Fit entirely within slide' },
      { value: 'auto' },
    ],
  },
  {
    key: 'backgroundRepeat',
    description: 'Background image tiling',
    type: 'enum',
    enum: [
      { value: 'no-repeat' }, { value: 'repeat' },
      { value: 'repeat-x' }, { value: 'repeat-y' },
    ],
  },
  {
    key: 'transition',
    description: 'Slide transition (Marp 4.0+)',
    type: 'enum',
    enum: [
      { value: 'fade' }, { value: 'fade-out' }, { value: 'slide' },
      { value: 'slide-up' }, { value: 'slide-down' },
      { value: 'cover' }, { value: 'reveal' },
      { value: 'flip' }, { value: 'cube' }, { value: 'iris' },
      { value: 'pivot' }, { value: 'pull' }, { value: 'push' },
      { value: 'wipe' }, { value: 'zoom' }, { value: 'fall' },
      { value: 'drop' }, { value: 'explode' }, { value: 'implode' },
      { value: 'in' }, { value: 'out' }, { value: 'swap' }, { value: 'swoosh' },
    ],
  },
  {
    key: 'math',
    description: 'Math typesetting engine',
    type: 'enum',
    enum: [
      { value: 'katex', info: 'Fast, recommended (default)' },
      { value: 'mathjax', info: 'Wider TeX coverage, heavier runtime' },
    ],
  },
  { key: 'lang', description: 'Document language (BCP 47 code)', type: 'lang' },
  {
    key: 'headingDivider',
    description: 'Auto-split slides on heading level',
    type: 'enum',
    enum: [
      { value: '1', info: 'Split on every h1' },
      { value: '2', info: 'Split on every h2' },
      { value: '3', info: 'Split on every h3' },
      { value: 'false', info: 'Disable auto-split' },
    ],
  },
  { key: 'title', description: 'Document title (metadata only)', type: 'freeform' },
  { key: 'description', description: 'Document description (metadata)', type: 'freeform' },
  { key: 'author', description: 'Author name (metadata)', type: 'freeform' },
  { key: 'keywords', description: 'SEO keywords (comma-separated)', type: 'freeform' },
  { key: 'url', description: 'Canonical URL (metadata)', type: 'freeform' },
  { key: 'image', description: 'OG image URL (metadata)', type: 'freeform' },
];

// Common CSS color names — short list, the user can type a hex
// directly if they want something specific.
const COMMON_COLORS = [
  'white', 'black', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta',
  'orange', 'purple', 'pink', 'brown', 'gray', 'lightgray', 'darkgray',
  'navy', 'teal', 'silver', 'gold', 'maroon', 'olive', 'aqua', 'fuchsia',
  'lime', 'transparent',
];

const COMMON_LANGS = [
  { value: 'en', info: 'English' },
  { value: 'en-US', info: 'English (US)' },
  { value: 'en-GB', info: 'English (UK)' },
  { value: 'fr', info: 'French' },
  { value: 'fr-FR', info: 'French (France)' },
  { value: 'de', info: 'German' },
  { value: 'es', info: 'Spanish' },
  { value: 'it', info: 'Italian' },
  { value: 'ja', info: 'Japanese' },
  { value: 'zh', info: 'Chinese' },
  { value: 'zh-CN', info: 'Chinese (Simplified)' },
  { value: 'ko', info: 'Korean' },
  { value: 'pt', info: 'Portuguese' },
  { value: 'ru', info: 'Russian' },
  { value: 'nl', info: 'Dutch' },
];

function valueCompletions(d: Directive): Completion[] | null {
  switch (d.type) {
    case 'bool':
      return [
        { label: 'true', type: 'keyword' },
        { label: 'false', type: 'keyword' },
      ];
    case 'theme':
      return MARP_THEMES.map((t) => ({
        label: t.id,
        detail: t.label,
        info: t.origin + ' · ' + t.description,
        type:
          t.origin === 'built-in'
            ? 'class'
            : t.origin === 'community'
              ? 'enum'
              : 'variable',
      }));
    case 'size':
      return [
        { label: '16:9', info: 'Widescreen (1280×720)' },
        { label: '4:3', info: 'Classic (960×720)' },
      ];
    case 'color':
      return COMMON_COLORS.map((c) => ({
        label: c,
        type: 'constant',
        info: 'CSS color',
      }));
    case 'lang':
      return COMMON_LANGS.map((l) => ({
        label: l.value,
        info: l.info,
        type: 'enum',
      }));
    case 'enum':
      return (d.enum ?? []).map((e) => ({
        label: e.value,
        info: e.info,
        type: 'enum',
      }));
    case 'freeform':
    default:
      return null;
  }
}

export function marpMetadataCompletion(
  ctx: CompletionContext,
): CompletionResult | null {
  const doc = ctx.state.doc.toString();
  if (!inFrontMatter(doc, ctx.pos)) return null;

  const line = ctx.state.doc.lineAt(ctx.pos);
  const upto = line.text.slice(0, ctx.pos - line.from);

  // The opening / closing fence lines themselves : skip.
  if (line.text.trim() === '---') return null;

  // Value mode : we've passed a ":" on this line.
  const valueMatch = upto.match(/^\s*(\w+)\s*:\s*(\S*)$/);
  if (valueMatch) {
    const key = valueMatch[1];
    const partial = valueMatch[2];
    const d = DIRECTIVES.find((x) => x.key === key);
    if (!d) return null;
    const opts = valueCompletions(d);
    if (!opts) return null;
    return {
      from: ctx.pos - partial.length,
      options: opts,
      validFor: /^\S*$/,
    };
  }

  // Key mode : start of line, partial word before any colon.
  const keyMatch = upto.match(/^(\s*)(\w*)$/);
  if (keyMatch) {
    const partial = keyMatch[2];
    return {
      from: ctx.pos - partial.length,
      options: DIRECTIVES.map((d) => ({
        label: d.key,
        info: d.description,
        type: 'property',
        apply: d.key + ': ',
      })),
      validFor: /^\w*$/,
    };
  }

  return null;
}

// Re-export the old name as an alias so existing imports keep working.
export const marpThemesCompletion = marpMetadataCompletion;
