// compileDiagnostics.svelte.ts — global cache of compile-time
// diagnostics surfaced into the editor's lint gutter. The
// CompileLogPanel feeds it as new error lines stream in ; the
// Editor's lint extension reads from it on every doc change.
//
// Why a store rather than props : the diagnostics live for the
// lifetime of the SPA (a freshly-mounted Editor needs to see the
// errors from the last compile) and multiple editors (rich-text +
// notebook + future split-view) all want the same gutter markers.

export interface CompileDiagnostic {
  severity: 'error' | 'warning';
  file: string | null;   // project-relative ; null = current file
  line: number | null;   // 1-based
  message: string;
}

class CompileDiagnosticsStore {
  items = $state<CompileDiagnostic[]>([]);

  push(d: CompileDiagnostic) {
    this.items = [...this.items, d];
  }
  clear() {
    this.items = [];
  }
  // Filter to the diagnostics that apply to the given file. When
  // a diagnostic has no file (typical for pdfTeX `l.42` markers)
  // we attribute it to the currently-active file — pdfTeX errors
  // are almost always in the document being compiled.
  forFile(file: string): CompileDiagnostic[] {
    return this.items.filter((d) => d.file === null || d.file === file || file.endsWith('/' + d.file));
  }
}

export const compileDiagnostics = new CompileDiagnosticsStore();
