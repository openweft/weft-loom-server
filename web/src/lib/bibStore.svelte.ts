// bibStore.svelte.ts — project-wide BibTeX cache. Discovers all
// `.bib` files in the active project, parses them, exposes an entry
// map to the LaTeX autocomplete + lint pipelines.
//
// Polls every 5 s. Stale data (a .bib edited externally) refreshes
// at the next tick ; an explicit `bibStore.refresh()` is also wired
// so the FileExplorer's "write file" path can prime it immediately
// after a save.

import { parseBib, type BibEntry } from './bibtex';
import { listFiles } from './api';

class BibStore {
  // The active project — re-set by the Editor as the user switches.
  project = $state<string>('');
  entries = $state<BibEntry[]>([]);
  byKey = $state<Map<string, BibEntry>>(new Map());
  loading = $state<boolean>(false);
  err = $state<string | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;

  setProject(p: string) {
    if (p === this.project) return;
    this.project = p;
    this.refresh();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), 5000);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async refresh() {
    if (!this.project) return;
    this.loading = true;
    this.err = null;
    try {
      const files = await listFiles(this.project);
      const bibs = files.filter((f) => !f.dir && f.path.endsWith('.bib'));
      const all: BibEntry[] = [];
      for (const f of bibs) {
        try {
          const r = await fetch(
            '/api/projects/' + encodeURIComponent(this.project) + '/files/' + encodeURIComponent(f.path),
          );
          if (!r.ok) continue;
          const text = await r.text();
          all.push(...parseBib(text));
        } catch { /* ignore per-file errors */ }
      }
      this.entries = all;
      const m = new Map<string, BibEntry>();
      for (const e of all) m.set(e.key, e);
      this.byKey = m;
    } catch (e) {
      this.err = String(e);
    } finally {
      this.loading = false;
    }
  }
}

export const bib = new BibStore();
