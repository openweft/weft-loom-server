// builtinThemes.svelte.ts — a handful of in-bundle VSCode-shaped
// color themes the user can pick from a dropdown without having to
// hunt down a JSON file. Each is hand-curated to look like its
// namesake VSCode community theme ; sizes are tiny since we only
// declare the workbench colours + the dozen tokenColors that
// vscodeThemeApply.ts actually maps.
//
// To add a theme : drop a new entry following the same shape ; the
// Settings panel picks it up automatically by reading the `BUILTIN`
// array.

import type { VSCodeTheme } from './settings.svelte';

const make = (name: string, type: 'light' | 'dark', colors: Record<string, string>, tokens: Array<{ scope: string | string[]; foreground?: string; fontStyle?: string }>): VSCodeTheme => ({
  name,
  type,
  colors,
  tokenColors: tokens.map((t) => ({
    name: Array.isArray(t.scope) ? t.scope.join(', ') : t.scope,
    scope: t.scope,
    settings: { foreground: t.foreground, fontStyle: t.fontStyle },
  })),
});

export const BUILTIN_THEMES: VSCodeTheme[] = [
  make('Default (daisyUI)', 'dark', {}, []),

  make('VSCode Dark+', 'dark', {
    'editor.background': '#1e1e1e',
    'editor.foreground': '#d4d4d4',
    'editor.selectionBackground': '#264f78',
    'editor.lineHighlightBackground': '#2a2d2e',
    'editorCursor.foreground': '#aeafad',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#c6c6c6',
    'editorBracketMatch.background': '#0064001a',
  }, [
    { scope: 'comment', foreground: '#6a9955', fontStyle: 'italic' },
    { scope: 'string', foreground: '#ce9178' },
    { scope: 'keyword', foreground: '#569cd6' },
    { scope: 'keyword.control', foreground: '#c586c0' },
    { scope: 'storage.type', foreground: '#569cd6' },
    { scope: 'constant.numeric', foreground: '#b5cea8' },
    { scope: 'constant.language', foreground: '#569cd6' },
    { scope: 'variable', foreground: '#9cdcfe' },
    { scope: 'entity.name.function', foreground: '#dcdcaa' },
    { scope: 'entity.name.class', foreground: '#4ec9b0' },
    { scope: 'entity.name.type', foreground: '#4ec9b0' },
    { scope: 'support.function', foreground: '#dcdcaa' },
    { scope: 'punctuation', foreground: '#d4d4d4' },
  ]),

  make('VSCode Light+', 'light', {
    'editor.background': '#ffffff',
    'editor.foreground': '#000000',
    'editor.selectionBackground': '#add6ff',
    'editor.lineHighlightBackground': '#f3f3f3',
    'editorCursor.foreground': '#000000',
    'editorLineNumber.foreground': '#237893',
    'editorLineNumber.activeForeground': '#0b216f',
    'editorBracketMatch.background': '#0064001a',
  }, [
    { scope: 'comment', foreground: '#008000', fontStyle: 'italic' },
    { scope: 'string', foreground: '#a31515' },
    { scope: 'keyword', foreground: '#0000ff' },
    { scope: 'keyword.control', foreground: '#af00db' },
    { scope: 'storage.type', foreground: '#0000ff' },
    { scope: 'constant.numeric', foreground: '#098658' },
    { scope: 'constant.language', foreground: '#0000ff' },
    { scope: 'variable', foreground: '#001080' },
    { scope: 'entity.name.function', foreground: '#795e26' },
    { scope: 'entity.name.class', foreground: '#267f99' },
    { scope: 'entity.name.type', foreground: '#267f99' },
    { scope: 'support.function', foreground: '#795e26' },
    { scope: 'punctuation', foreground: '#000000' },
  ]),

  make('Monokai', 'dark', {
    'editor.background': '#272822',
    'editor.foreground': '#f8f8f2',
    'editor.selectionBackground': '#49483e',
    'editor.lineHighlightBackground': '#3e3d32',
    'editorCursor.foreground': '#f8f8f0',
    'editorLineNumber.foreground': '#75715e',
    'editorLineNumber.activeForeground': '#f8f8f2',
  }, [
    { scope: 'comment', foreground: '#75715e', fontStyle: 'italic' },
    { scope: 'string', foreground: '#e6db74' },
    { scope: 'keyword', foreground: '#f92672' },
    { scope: 'keyword.control', foreground: '#f92672' },
    { scope: 'storage.type', foreground: '#66d9ef', fontStyle: 'italic' },
    { scope: 'constant.numeric', foreground: '#ae81ff' },
    { scope: 'constant.language', foreground: '#ae81ff' },
    { scope: 'variable', foreground: '#f8f8f2' },
    { scope: 'entity.name.function', foreground: '#a6e22e' },
    { scope: 'entity.name.class', foreground: '#a6e22e' },
    { scope: 'entity.name.type', foreground: '#66d9ef' },
    { scope: 'support.function', foreground: '#66d9ef' },
  ]),

  make('Dracula', 'dark', {
    'editor.background': '#282a36',
    'editor.foreground': '#f8f8f2',
    'editor.selectionBackground': '#44475a',
    'editor.lineHighlightBackground': '#44475a75',
    'editorCursor.foreground': '#f8f8f0',
    'editorLineNumber.foreground': '#6272a4',
    'editorLineNumber.activeForeground': '#f8f8f2',
  }, [
    { scope: 'comment', foreground: '#6272a4', fontStyle: 'italic' },
    { scope: 'string', foreground: '#f1fa8c' },
    { scope: 'keyword', foreground: '#ff79c6' },
    { scope: 'keyword.control', foreground: '#ff79c6' },
    { scope: 'storage.type', foreground: '#8be9fd', fontStyle: 'italic' },
    { scope: 'constant.numeric', foreground: '#bd93f9' },
    { scope: 'constant.language', foreground: '#bd93f9' },
    { scope: 'variable', foreground: '#f8f8f2' },
    { scope: 'entity.name.function', foreground: '#50fa7b' },
    { scope: 'entity.name.class', foreground: '#8be9fd' },
    { scope: 'entity.name.type', foreground: '#8be9fd' },
    { scope: 'support.function', foreground: '#50fa7b' },
  ]),

  make('Solarized Light', 'light', {
    'editor.background': '#fdf6e3',
    'editor.foreground': '#586e75',
    'editor.selectionBackground': '#eee8d5',
    'editor.lineHighlightBackground': '#eee8d5',
    'editorCursor.foreground': '#657b83',
    'editorLineNumber.foreground': '#93a1a1',
    'editorLineNumber.activeForeground': '#586e75',
  }, [
    { scope: 'comment', foreground: '#93a1a1', fontStyle: 'italic' },
    { scope: 'string', foreground: '#2aa198' },
    { scope: 'keyword', foreground: '#859900' },
    { scope: 'keyword.control', foreground: '#cb4b16' },
    { scope: 'storage.type', foreground: '#cb4b16' },
    { scope: 'constant.numeric', foreground: '#d33682' },
    { scope: 'constant.language', foreground: '#d33682' },
    { scope: 'variable', foreground: '#268bd2' },
    { scope: 'entity.name.function', foreground: '#268bd2' },
    { scope: 'entity.name.class', foreground: '#b58900' },
    { scope: 'entity.name.type', foreground: '#b58900' },
  ]),

  make('Solarized Dark', 'dark', {
    'editor.background': '#002b36',
    'editor.foreground': '#839496',
    'editor.selectionBackground': '#073642',
    'editor.lineHighlightBackground': '#073642',
    'editorCursor.foreground': '#93a1a1',
    'editorLineNumber.foreground': '#586e75',
    'editorLineNumber.activeForeground': '#93a1a1',
  }, [
    { scope: 'comment', foreground: '#586e75', fontStyle: 'italic' },
    { scope: 'string', foreground: '#2aa198' },
    { scope: 'keyword', foreground: '#859900' },
    { scope: 'keyword.control', foreground: '#cb4b16' },
    { scope: 'storage.type', foreground: '#cb4b16' },
    { scope: 'constant.numeric', foreground: '#d33682' },
    { scope: 'constant.language', foreground: '#d33682' },
    { scope: 'variable', foreground: '#268bd2' },
    { scope: 'entity.name.function', foreground: '#268bd2' },
    { scope: 'entity.name.class', foreground: '#b58900' },
    { scope: 'entity.name.type', foreground: '#b58900' },
  ]),

  make('GitHub Dark', 'dark', {
    'editor.background': '#0d1117',
    'editor.foreground': '#c9d1d9',
    'editor.selectionBackground': '#264f78',
    'editor.lineHighlightBackground': '#161b22',
    'editorCursor.foreground': '#c9d1d9',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#c9d1d9',
  }, [
    { scope: 'comment', foreground: '#8b949e', fontStyle: 'italic' },
    { scope: 'string', foreground: '#a5d6ff' },
    { scope: 'keyword', foreground: '#ff7b72' },
    { scope: 'keyword.control', foreground: '#ff7b72' },
    { scope: 'storage.type', foreground: '#ff7b72' },
    { scope: 'constant.numeric', foreground: '#79c0ff' },
    { scope: 'constant.language', foreground: '#79c0ff' },
    { scope: 'variable', foreground: '#c9d1d9' },
    { scope: 'entity.name.function', foreground: '#d2a8ff' },
    { scope: 'entity.name.class', foreground: '#ffa657' },
    { scope: 'entity.name.type', foreground: '#ffa657' },
  ]),

  make('GitHub Light', 'light', {
    'editor.background': '#ffffff',
    'editor.foreground': '#24292f',
    'editor.selectionBackground': '#0969da26',
    'editor.lineHighlightBackground': '#f6f8fa',
    'editorCursor.foreground': '#24292f',
    'editorLineNumber.foreground': '#6e7781',
    'editorLineNumber.activeForeground': '#24292f',
  }, [
    { scope: 'comment', foreground: '#6e7781', fontStyle: 'italic' },
    { scope: 'string', foreground: '#0a3069' },
    { scope: 'keyword', foreground: '#cf222e' },
    { scope: 'keyword.control', foreground: '#cf222e' },
    { scope: 'storage.type', foreground: '#cf222e' },
    { scope: 'constant.numeric', foreground: '#0550ae' },
    { scope: 'constant.language', foreground: '#0550ae' },
    { scope: 'variable', foreground: '#24292f' },
    { scope: 'entity.name.function', foreground: '#8250df' },
    { scope: 'entity.name.class', foreground: '#953800' },
    { scope: 'entity.name.type', foreground: '#953800' },
  ]),

  make('Nord', 'dark', {
    'editor.background': '#2e3440',
    'editor.foreground': '#d8dee9',
    'editor.selectionBackground': '#434c5e',
    'editor.lineHighlightBackground': '#3b4252',
    'editorCursor.foreground': '#d8dee9',
    'editorLineNumber.foreground': '#4c566a',
    'editorLineNumber.activeForeground': '#d8dee9',
  }, [
    { scope: 'comment', foreground: '#616e88', fontStyle: 'italic' },
    { scope: 'string', foreground: '#a3be8c' },
    { scope: 'keyword', foreground: '#81a1c1' },
    { scope: 'keyword.control', foreground: '#81a1c1' },
    { scope: 'storage.type', foreground: '#81a1c1' },
    { scope: 'constant.numeric', foreground: '#b48ead' },
    { scope: 'constant.language', foreground: '#b48ead' },
    { scope: 'variable', foreground: '#d8dee9' },
    { scope: 'entity.name.function', foreground: '#88c0d0' },
    { scope: 'entity.name.class', foreground: '#8fbcbb' },
    { scope: 'entity.name.type', foreground: '#8fbcbb' },
  ]),
];
