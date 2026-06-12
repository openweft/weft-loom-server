// vscodeThemeApply.svelte.ts — translate a VSCode color theme JSON
// into a CodeMirror EditorView.theme + HighlightStyle extension.
//
// VSCode themes carry two halves :
//   - `colors`     : workbench / UI palette  (`editor.background`,
//                    `editor.foreground`, `editor.selectionBackground`,
//                    `editorLineNumber.foreground`, …)
//   - `tokenColors`: TextMate-style scope rules (`comment`, `keyword`,
//                    `string`, …) with `foreground` / `background` /
//                    `fontStyle`.
//
// We map the most-used UI keys onto CodeMirror's `.cm-*` selectors
// and the common TextMate scopes onto `@codemirror/highlight` tags
// (the source highlight pipeline already in Editor.svelte). Anything
// we don't recognise stays at the daisyUI default — that's intended,
// we want the theme to enhance, not replace, the editor look.

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { type Extension, Compartment } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import type { VSCodeTheme } from './settings.svelte';

// Map TextMate scopes → CodeMirror tags. We pick the dominant
// scope of each TextMate group ; multi-scope rules degrade to the
// first match the loop hits (good enough for the common themes).
const SCOPE_TO_TAG: Array<[RegExp, typeof t.comment]> = [
  [/\bcomment\b/, t.comment],
  [/\bstring\b/, t.string],
  [/\bkeyword\.control\b/, t.controlKeyword],
  [/\bkeyword\.operator\b/, t.operator],
  [/\bkeyword\b/, t.keyword],
  [/\bstorage\.type\b/, t.typeName],
  [/\bstorage\.modifier\b/, t.modifier],
  [/\bconstant\.numeric\b/, t.number],
  [/\bconstant\.language\b/, t.atom],
  [/\bconstant\b/, t.literal],
  [/\bvariable\.parameter\b/, t.local(t.variableName)],
  [/\bvariable\.other\.constant\b/, t.constant(t.variableName)],
  [/\bvariable\b/, t.variableName],
  [/\bentity\.name\.function\b/, t.function(t.variableName)],
  [/\bentity\.name\.class\b/, t.className],
  [/\bentity\.name\.type\b/, t.typeName],
  [/\bentity\.name\.tag\b/, t.tagName],
  [/\bentity\.other\.attribute-name\b/, t.attributeName],
  [/\bsupport\.function\b/, t.function(t.variableName)],
  [/\bsupport\.class\b/, t.className],
  [/\bsupport\.type\b/, t.typeName],
  [/\bsupport\.variable\b/, t.standard(t.variableName)],
  [/\bpunctuation\b/, t.punctuation],
  [/\binvalid\b/, t.invalid],
  [/\bmarkup\.heading\b/, t.heading],
  [/\bmarkup\.bold\b/, t.strong],
  [/\bmarkup\.italic\b/, t.emphasis],
];

function tagForScope(scope: string): typeof t.comment | undefined {
  for (const [re, tag] of SCOPE_TO_TAG) {
    if (re.test(scope)) return tag;
  }
  return undefined;
}

export function buildVSCodeThemeExtension(theme: VSCodeTheme): Extension {
  const c = theme.colors ?? {};
  const editorBg = c['editor.background'] ?? '#1e1e1e';
  const editorFg = c['editor.foreground'] ?? '#d4d4d4';
  const gutterBg = c['editorGutter.background'] ?? editorBg;
  const gutterFg = c['editorLineNumber.foreground'] ?? 'rgba(255,255,255,0.4)';
  const gutterActiveFg = c['editorLineNumber.activeForeground'] ?? editorFg;
  const cursorColor = c['editorCursor.foreground'] ?? editorFg;
  const selBg = c['editor.selectionBackground'] ?? 'rgba(70, 110, 200, 0.4)';
  const activeLineBg = c['editor.lineHighlightBackground'] ?? 'rgba(255,255,255,0.04)';
  const matchBracket = c['editorBracketMatch.background'] ?? 'rgba(255,255,255,0.1)';

  const themeExt = EditorView.theme(
    {
      '&': {
        color: editorFg,
        backgroundColor: editorBg,
      },
      '.cm-content': {
        caretColor: cursorColor,
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: cursorColor,
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
        backgroundColor: selBg,
      },
      '.cm-activeLine': {
        backgroundColor: activeLineBg,
      },
      '.cm-gutters': {
        backgroundColor: gutterBg,
        color: gutterFg,
        border: 'none',
      },
      '.cm-activeLineGutter': {
        backgroundColor: activeLineBg,
        color: gutterActiveFg,
      },
      '.cm-matchingBracket': {
        backgroundColor: matchBracket,
      },
    },
    { dark: theme.type === 'dark' || theme.type === 'hc-dark' },
  );

  // Build the HighlightStyle from tokenColors. We accumulate per-tag
  // style overrides so the FIRST matching rule wins (TextMate
  // ordering — same as VSCode).
  const seenTags = new Set<typeof t.comment>();
  const specs: Array<{ tag: typeof t.comment; color?: string; background?: string; fontStyle?: string; fontWeight?: string; textDecoration?: string }> = [];
  for (const rule of theme.tokenColors ?? []) {
    const scopes = Array.isArray(rule.scope) ? rule.scope : rule.scope ? rule.scope.split(',') : [];
    for (const sRaw of scopes) {
      const s = sRaw.trim();
      const tag = tagForScope(s);
      if (!tag || seenTags.has(tag)) continue;
      seenTags.add(tag);
      const fs = rule.settings.fontStyle ?? '';
      specs.push({
        tag,
        color: rule.settings.foreground,
        background: rule.settings.background,
        fontStyle: fs.includes('italic') ? 'italic' : undefined,
        fontWeight: fs.includes('bold') ? 'bold' : undefined,
        textDecoration: fs.includes('underline') ? 'underline' : undefined,
      });
    }
  }
  const hl = HighlightStyle.define(specs);

  return [themeExt, syntaxHighlighting(hl)];
}

// Compartment so the Editor can swap themes live when the user
// activates a new VSCode theme in the Settings panel.
export const vscodeThemeCompartment = new Compartment();
