// editorKeymap.ts — vim / emacs / default keymap extension loader.
//
// The vim + emacs CodeMirror packages weigh in at ~80 KB each ; we
// don't want them in the cold-load chunk for users who stick to the
// default keymap. Same lazy-load pattern as loadLanguagePack() in
// Editor.svelte : the call site holds a Compartment, dispatches a
// reconfigure once the dynamic import() promise resolves, and the
// editor swaps the bindings in live with no remount.
//
// `'default'` resolves to `[]` so the Compartment becomes a no-op
// — CodeMirror's defaultKeymap (registered separately in Editor.svelte)
// stays in charge.

import type { Extension } from '@codemirror/state';

export type KeymapMode = 'default' | 'vim' | 'emacs';

export const KEYMAP_MODES: readonly KeymapMode[] = ['default', 'vim', 'emacs'] as const;

/**
 * Returns the CodeMirror extension for the requested keymap.
 * - 'default' → resolves to [] synchronously (well, in a microtask)
 *   so the call site can use a single .then() path uniformly.
 * - 'vim'     → dynamic import of @replit/codemirror-vim, calls vim()
 * - 'emacs'   → dynamic import of @replit/codemirror-emacs, calls emacs()
 *
 * Errors during the dynamic import fall back to [] + a console.warn
 * so a broken chunk doesn't lock the editor into a half-mounted state.
 */
export async function loadKeymap(mode: KeymapMode): Promise<Extension> {
  switch (mode) {
    case 'default':
      return [];
    case 'vim':
      try {
        const mod = await import('@replit/codemirror-vim');
        return mod.vim();
      } catch (err) {
        console.warn('[editorKeymap] vim load failed', err);
        return [];
      }
    case 'emacs':
      try {
        const mod = await import('@replit/codemirror-emacs');
        return mod.emacs();
      } catch (err) {
        console.warn('[editorKeymap] emacs load failed', err);
        return [];
      }
    default: {
      // Exhaustiveness check : if KeymapMode grows a new variant the
      // compiler complains here.
      const _exhaustive: never = mode;
      void _exhaustive;
      return [];
    }
  }
}
