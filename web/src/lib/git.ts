// git.ts — typed helpers for the project-git REST surface. The
// endpoints are wired in internal/server/api_git.go ; today they're
// stubs returning canned responses so the UI scaffold can be built
// against a stable contract. The real go-git wiring lands separately.
//
// Wire-level calls go through the openapi-fetch helpers in api.ts ;
// the locally-defined types below narrow the huma-generated shapes
// (e.g. `provider: string` → the `GitProvider` union) so callers
// can switch on a closed set without re-narrowing at every site.

import {
  gitStatus as apiGitStatus,
  gitConfig as apiGitConfig,
  gitClone as apiGitClone,
  gitPull as apiGitPull,
  gitPush as apiGitPush,
  gitLog as apiGitLog,
  type GitStatus as ApiGitStatus,
  type GitLogResponse as ApiGitLogResponse,
} from './api';

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

// adaptStatus narrows the huma-typed payload (provider:string,
// changes:FileChange[]|null) into the SPA-facing GitStatus shape
// (provider:GitProvider union, changes:[]).
function adaptStatus(s: ApiGitStatus): GitStatus {
  return {
    configured: s.configured,
    provider: s.provider as GitProvider,
    remote_url: s.remote_url,
    branch: s.branch,
    ahead: s.ahead,
    behind: s.behind,
    changes: (s.changes ?? []) as FileChange[],
    last_sync_unix: s.last_sync_unix,
    last_error: s.last_error,
  };
}

export async function getStatus(project: string): Promise<GitStatus> {
  return adaptStatus(await apiGitStatus(project));
}

export async function saveConfig(project: string, config: GitConfig): Promise<void> {
  await apiGitConfig(project, config);
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

function adaptLog(r: ApiGitLogResponse): LogResponse {
  const entries = (r.entries ?? []).map((e) => ({
    sha: e.sha,
    parents: (e.parents ?? []) as string[],
    author: e.author,
    email: e.email,
    subject: e.subject,
    unix_time: e.unix_time,
    ref_names: (e.ref_names ?? undefined) as string[] | undefined,
  }));
  return { entries, head_sha: r.head_sha, branch: r.branch };
}

export async function getLog(project: string, limit = 200): Promise<LogResponse> {
  return adaptLog(await apiGitLog(project, limit));
}

export async function pull(project: string): Promise<GitStatus> {
  return adaptStatus(await apiGitPull(project));
}

export async function push(project: string): Promise<GitStatus> {
  return adaptStatus(await apiGitPush(project));
}

export async function cloneFromRemote(project: string, config: GitConfig): Promise<GitStatus> {
  return adaptStatus(await apiGitClone(project, config));
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
export function webURL(_provider: GitProvider, remoteURL: string): string {
  let url = remoteURL.replace(/\.git$/, '');
  if (url.startsWith('git@')) {
    // git@github.com:owner/repo → https://github.com/owner/repo
    url = url.replace(/^git@([^:]+):/, 'https://$1/');
  }
  return url;
}
