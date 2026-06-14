// gitStatusStore.svelte.ts — shared, reference-counted poll of
// `/api/projects/<p>/git/status`. Mirrors the bibStore shape : one
// module-scope singleton, start()/stop() reference counted so multiple
// subscribers (GitSidebar + FileExplorer today) share a single 15 s
// poll instead of each running their own setInterval.
//
// ETag wiring : sends `If-None-Match: <last-etag>` if the server
// emitted an etag on the previous response. If the server doesn't
// emit etags on /git/status (current backend doesn't), we just skip
// the conditional and behave like a plain poll — H6 mandates etag for
// bibs, the etag here is purely a forward-compat affordance.

import { getStatus, type GitStatus } from './git';

class GitStatusStore {
  // Active project — last value passed to setProject.
  project = $state<string>('');
  status = $state<GitStatus | null>(null);
  err = $state<string | null>(null);
  loading = $state<boolean>(false);

  private timer: ReturnType<typeof setInterval> | null = null;
  private refCount = 0;
  private lastEtag = '';

  setProject(p: string) {
    if (p === this.project) return;
    this.project = p;
    this.status = null;
    this.lastEtag = '';
    if (this.refCount > 0) this.refresh();
  }

  // Reference-counted lifecycle : every subscriber calls start() in
  // onMount + stop() in onDestroy. The poller spins up on the first
  // start and tears down when the last subscriber leaves.
  start() {
    this.refCount++;
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 15_000);
  }

  stop() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh() {
    if (!this.project) return;
    this.loading = true;
    this.err = null;
    try {
      // We bypass the typed `getStatus` helper here so we can attach
      // `If-None-Match` + read the response etag. If the backend
      // starts emitting etags this skips parse on 304 ; until then
      // we just always get the JSON body.
      const headers: Record<string, string> = {};
      if (this.lastEtag) headers['If-None-Match'] = this.lastEtag;
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(this.project) + '/git/status',
        { headers },
      );
      if (r.status === 304) {
        return; // keep current status as-is
      }
      if (!r.ok) {
        // Fall back to the typed helper so we get the standard error
        // surface (and so a 4xx body propagates as the toast string).
        this.status = await getStatus(this.project);
        return;
      }
      const etag = r.headers.get('etag') ?? r.headers.get('ETag') ?? '';
      if (etag) this.lastEtag = etag;
      this.status = (await r.json()) as GitStatus;
    } catch (e) {
      this.err = String(e);
    } finally {
      this.loading = false;
    }
  }

  // Convenience accessor used by template consumers that want a
  // non-null narrowing site.
  current(): GitStatus | null {
    return this.status;
  }
}

export const gitStatus = new GitStatusStore();
