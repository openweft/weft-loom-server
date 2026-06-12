// git.ts — typed helpers for the project-git REST surface. The
// endpoints are wired in internal/server/api_git.go ; today they're
// stubs returning canned responses so the UI scaffold can be built
// against a stable contract. The real go-git wiring lands separately.

export type GitProvider = 'github' | 'gitlab' | 'forgejo' | 'generic';

export interface GitConfig {
  // provider drives the credentials shape + the web URL the UI can
  // open ("View on GitHub" etc.).
  provider: GitProvider;
  // remote_url is the clone URL :
  //   github  — https://github.com/<owner>/<repo>.git
  //   gitlab  — https://gitlab.com/<group>/<repo>.git
  //   forgejo — https://codeberg.org/<owner>/<repo>.git
  //   generic — any https/ssh URL
  remote_url: string;
  // branch defaults to "main" when unset ; the server resolves the
  // remote default when this is "".
  branch: string;
  // token is the credential the agent uses for pull / push.
  // GitHub/GitLab/Forgejo all accept PAT-style tokens over HTTPS.
  // Sent only on save ; never reflected back into responses.
  token: string;
}

export interface FileChange {
  path: string;
  // staged | modified | untracked | deleted | renamed
  status: string;
}

export interface GitStatus {
  configured: boolean;
  provider: GitProvider;
  remote_url: string;
  branch: string;
  ahead: number;
  behind: number;
  changes: FileChange[];
  last_sync_unix?: number;
  last_error?: string;
}

async function http<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j.error ?? JSON.stringify(j);
    } catch {
      detail = await resp.text();
    }
    throw new Error(`${method} ${url} ${resp.status}: ${detail}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export function getStatus(project: string): Promise<GitStatus> {
  return http('GET', `/api/projects/${encodeURIComponent(project)}/git/status`);
}

export function saveConfig(project: string, config: GitConfig): Promise<void> {
  return http('POST', `/api/projects/${encodeURIComponent(project)}/git/config`, config);
}

export interface LogEntry {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  subject: string;
  unix_time: number;
  ref_names?: string[];
}

export interface LogResponse {
  entries: LogEntry[];
  head_sha: string;
  branch: string;
}

export function getLog(project: string, limit = 200): Promise<LogResponse> {
  return http('GET', `/api/projects/${encodeURIComponent(project)}/git/log?limit=${limit}`);
}

export function pull(project: string): Promise<GitStatus> {
  return http('POST', `/api/projects/${encodeURIComponent(project)}/git/pull`);
}

export function push(project: string): Promise<GitStatus> {
  return http('POST', `/api/projects/${encodeURIComponent(project)}/git/push`);
}

export function cloneFromRemote(project: string, config: GitConfig): Promise<GitStatus> {
  return http('POST', `/api/projects/${encodeURIComponent(project)}/git/clone`, config);
}

// providerLabel renders the provider id as a human-friendly name.
export function providerLabel(p: GitProvider): string {
  switch (p) {
    case 'github': return 'GitHub';
    case 'gitlab': return 'GitLab';
    case 'forgejo': return 'Forgejo';
    case 'generic': return 'Generic (https/ssh)';
  }
}

// webURL converts a remote_url like
//   "https://github.com/openweft/weft-loom-server.git"
// to the corresponding "View on …" web URL. Best-effort : empty when
// the URL pattern doesn't match the provider.
export function webURL(p: GitProvider, remoteURL: string): string {
  let url = remoteURL.replace(/\.git$/, '');
  if (url.startsWith('git@')) {
    // git@github.com:owner/repo → https://github.com/owner/repo
    url = url.replace(/^git@([^:]+):/, 'https://$1/');
  }
  return url;
}
