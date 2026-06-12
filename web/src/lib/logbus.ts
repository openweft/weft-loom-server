// logbus.ts — SPA → server event POST helper. The DoctorPanel
// consumes the merged stream (server + client events) via SSE from
// /api/events ; this module is how SPA code surfaces what it's
// doing so the loom-server can fan it back out.
//
// Usage : import { logEvent } from '$lib/logbus';
//         logEvent('editor', 'mount', { file, mountID });
//
// The post is fire-and-forget ; we never block the caller waiting on
// the server. Failures are silent — observability must never break
// the editor.

export interface ClientEvent {
  component: string;
  verb: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  project?: string;
  fields?: Record<string, unknown>;
}

let projectHint: string | undefined;

// setProjectHint lets App.svelte tell logbus what the current project
// is, so every event is tagged automatically — the DoctorPanel filters
// on this so an operator sees only their workspace's events.
export function setProjectHint(p: string | undefined) {
  projectHint = p;
}

export function logEvent(
  component: string,
  verb: string,
  fieldsOrMessage?: Record<string, unknown> | string,
  opts: Partial<Pick<ClientEvent, 'level' | 'message' | 'project'>> = {},
): void {
  const ev: ClientEvent = {
    component,
    verb,
    level: opts.level ?? 'info',
    project: opts.project ?? projectHint,
  };
  if (typeof fieldsOrMessage === 'string') {
    ev.message = fieldsOrMessage;
  } else if (fieldsOrMessage) {
    ev.fields = fieldsOrMessage;
    if (opts.message) ev.message = opts.message;
  }
  // fire-and-forget ; no await chain back to the caller
  fetch('/api/events/client', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev),
    keepalive: true,
  }).catch(() => {
    /* swallow — observability is best-effort */
  });
}

// logError specialises for errors caught in catch{} blocks. Pulls
// the error name + stack out and tags level=error.
export function logError(
  component: string,
  verb: string,
  err: unknown,
  fields: Record<string, unknown> = {},
): void {
  const e = err as Error | undefined;
  logEvent(component, verb, {
    ...fields,
    err_name: e?.name ?? typeof err,
    err_msg: e?.message ?? String(err),
    err_stack: e?.stack?.split('\n').slice(0, 6).join('\n'),
  }, { level: 'error' });
}
