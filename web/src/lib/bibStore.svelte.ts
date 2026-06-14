// bibStore.svelte.ts — project-wide BibTeX cache. Discovers all
// `.bib` files in the active project, parses them, exposes an entry
// map to the LaTeX autocomplete + lint pipelines.
//
// Polls every 30 s with per-file ETag tracking. Each refresh sends
// `If-None-Match: <last-etag>` per .bib path so unchanged files
// short-circuit on 304 without re-parse. An explicit
// `bibStore.refresh()` is also wired so the FileExplorer's "write
// file" path can prime the store immediately after a save (active
// edits don't have to wait for the next poll tick).

import { parseBib, type BibEntry } from './bibtex';
import { listFiles } from './api';

interface CacheRow {
  etag: string;
  entries: BibEntry[];
}

class BibStore {
  // The active project — re-set by the Editor as the user switches.
  project = $state<string>('');
  entries = $state<BibEntry[]>([]);
  byKey = $state<Map<string, BibEntry>>(new Map());
  loading = $state<boolean>(false);
  err = $state<string | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;
  // Per-file cache : etag + last parsed entries. Keyed by .bib path.
  // Cleared on project switch so a project A → B move can't leak
  // stale entries into B.
  private cache = new Map<string, CacheRow>();

  setProject(p: string) {
    if (p === this.project) return;
    this.project = p;
    this.cache.clear();
    this.refresh();
  }

  start() {
    if (this.timer) return;
    // 30 s : most .bib files don't change often, and the explicit
    // refresh hook from the file-write path catches active edits.
    this.timer = setInterval(() => this.refresh(), 30_000);
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
      // Drop cache entries for files that have disappeared.
      const live = new Set(bibs.map((b) => b.path));
      for (const k of [...this.cache.keys()]) {
        if (!live.has(k)) this.cache.delete(k);
      }
      for (const f of bibs) {
        try {
          const prev = this.cache.get(f.path);
          const headers: Record<string, string> = {};
          if (prev?.etag) headers['If-None-Match'] = prev.etag;
          const r = await fetch(
            '/api/projects/' + encodeURIComponent(this.project) + '/files/' + encodeURIComponent(f.path),
            { headers },
          );
          if (r.status === 304 && prev) {
            // Unchanged : keep cached parsed entries as-is.
            continue;
          }
          if (!r.ok) continue;
          const text = await r.text();
          const etag = r.headers.get('etag') ?? r.headers.get('ETag') ?? '';
          const parsed = parseBib(text);
          this.cache.set(f.path, { etag, entries: parsed });
        } catch { /* ignore per-file errors */ }
      }
      // Merge every cached file into a flat entries list + byKey map.
      const all: BibEntry[] = [];
      for (const row of this.cache.values()) all.push(...row.entries);
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
