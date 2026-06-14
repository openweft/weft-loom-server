<script lang="ts">
  // MetadataPanel — parses the document's preamble / front-matter
  // and surfaces title / author / date / class. Lives in the left
  // side-bar (under Outline) as an accordion section.
  //
  // LaTeX preamble : `\title{...}` `\author{...}` `\date{...}`
  // `\documentclass[opts]{class}`.
  //
  // Markdown front-matter (YAML between leading `---` markers) :
  // `title:` `author:` `date:` `theme:` (Marp).
  //
  // Poll every 1.5 s + ETag short-circuit, same cadence as
  // OutlinePanel so the two never fight for the same file twice.

  import { onDestroy } from 'svelte';
  import { parseRTF } from '../rtf';
  import { parseODT } from '../odt';

  interface Props {
    project: string;
    file: string;
    collapsed?: boolean;
    onToggle?: () => void;
  }
  let { project, file, collapsed = $bindable(true), onToggle }: Props = $props();

  interface Meta {
    key: string;
    label: string;
    value: string;
  }
  let entries = $state<Meta[]>([]);
  let lang = $state<'latex' | 'markdown' | 'rtf' | 'odt' | null>(null);
  let lastSig = '';
  let poll: ReturnType<typeof setInterval> | undefined;
  // T10 V0.1.5 : user-defined ODT variables editor. The local state
  // mirrors parsed.meta.userDefined ; mutations propagate to the
  // WysiwygEditor via window.weftLoomODTVars.set() which triggers
  // a save.
  let userVars = $state<Array<{ name: string; value: string }>>([]);
  let newVarName = $state('');
  let newVarValue = $state('');

  function pickGroup(src: string, name: string): string | null {
    const m = new RegExp('\\\\' + name + '\\{([^{}]*)\\}').exec(src);
    return m ? m[1].trim() : null;
  }
  function parseLatex(src: string): Meta[] {
    const out: Meta[] = [];
    const dclass = /\\documentclass(?:\[[^\]]*\])?\{([^{}]+)\}/.exec(src);
    if (dclass) out.push({ key: 'class', label: 'Class', value: dclass[1] });
    const title = pickGroup(src, 'title');
    if (title) out.push({ key: 'title', label: 'Title', value: title });
    const author = pickGroup(src, 'author');
    if (author) out.push({ key: 'author', label: 'Author', value: author });
    const date = pickGroup(src, 'date');
    if (date) out.push({ key: 'date', label: 'Date', value: date });
    // Packages — collapsed display ; first 3 listed inline, rest
    // hidden behind a "+N more".
    const pkgs: string[] = [];
    const pkgRe = /\\usepackage(?:\[[^\]]*\])?\{([^{}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = pkgRe.exec(src))) pkgs.push(...m[1].split(',').map((s) => s.trim()));
    if (pkgs.length) out.push({ key: 'packages', label: 'Packages', value: pkgs.length <= 4 ? pkgs.join(', ') : pkgs.slice(0, 3).join(', ') + ' +' + (pkgs.length - 3) + ' more' });
    return out;
  }
  function parseMarkdown(src: string): Meta[] {
    const out: Meta[] = [];
    // YAML front-matter : `---\n...\n---` at the very top.
    const fm = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(src);
    if (!fm) return out;
    for (const line of fm[1].split('\n')) {
      const kv = /^(\w+)\s*:\s*(.+?)\s*$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      let value = kv[2];
      // Unquote.
      value = value.replace(/^['"]/, '').replace(/['"]$/, '');
      if (['title', 'author', 'date', 'theme', 'marp', 'class', 'size', 'paginate', 'header', 'footer'].includes(key)) {
        out.push({ key, label: key[0].toUpperCase() + key.slice(1), value });
      }
    }
    return out;
  }

  function fromMetaObj(m: { title?: string; author?: string; date?: string }): Meta[] {
    const out: Meta[] = [];
    if (m.title)  out.push({ key: 'title',  label: 'Title',  value: m.title });
    if (m.author) out.push({ key: 'author', label: 'Author', value: m.author });
    if (m.date)   out.push({ key: 'date',   label: 'Date',   value: m.date });
    return out;
  }

  async function refresh() {
    const ext = file && file.toLowerCase();
    const nextLang: typeof lang =
      ext && ext.endsWith('.tex') ? 'latex' :
      ext && (ext.endsWith('.md') || ext.endsWith('.markdown') || ext.endsWith('.mdown')) ? 'markdown' :
      ext && ext.endsWith('.rtf') ? 'rtf' :
      ext && ext.endsWith('.odt') ? 'odt' :
      null;
    lang = nextLang;
    if (!file || !nextLang) { entries = []; return; }
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
        { headers: lastSig ? { 'If-None-Match': lastSig } : undefined },
      );
      if (r.status === 304) return;
      if (!r.ok) return;
      const tag = r.headers.get('etag') ?? '';
      if (tag) lastSig = tag;
      if (nextLang === 'odt') {
        // ODT is a zip ; pull as ArrayBuffer + decode with jszip.
        const buf = await r.arrayBuffer();
        if (buf.byteLength === 0) { entries = []; userVars = []; return; }
        const parsed = await parseODT(buf);
        entries = fromMetaObj(parsed.meta);
        const ud = parsed.meta.userDefined ?? {};
        userVars = Object.entries(ud).map(([name, value]) => ({ name, value }));
        return;
      }
      // Non-ODT files don't carry user-defined vars (RTF V0.2 work).
      userVars = [];
      const text = await r.text();
      if (nextLang === 'latex')    entries = parseLatex(text);
      else if (nextLang === 'markdown') entries = parseMarkdown(text);
      else if (nextLang === 'rtf')      entries = fromMetaObj(parseRTF(text).meta);
    } catch {}
  }

  // Reset etag whenever the file changes — the next refresh has to
  // re-fetch the body because content is keyed per-path.
  $effect(() => { file; lastSig = ''; });
  // H5 (perf-audit 2026-06-14) : gate the 1.5 s poll on the collapsed
  // prop. The panel renders nothing while collapsed (template
  // line 210), so the fetch+parse loop is pure overhead. This $effect
  // re-runs whenever `collapsed` or `file` flips :
  //   - collapsed=true  : tear down any interval, do nothing.
  //   - collapsed=false : refresh once + setInterval(refresh, 1500).
  // The teardown closure clears the interval, covering both the
  // expanded→collapsed transition and component unmount.
  $effect(() => {
    if (collapsed) {
      if (poll) { clearInterval(poll); poll = undefined; }
      return;
    }
    refresh();
    poll = setInterval(refresh, 1500);
    return () => {
      if (poll) { clearInterval(poll); poll = undefined; }
    };
  });
  // Backup clear in case any future refactor sidesteps the $effect
  // cleanup path.
  onDestroy(() => { if (poll) { clearInterval(poll); poll = undefined; } });

  function toggleCollapsed() { onToggle?.(); }

  // T10 V0.1.5 : push the locally-edited userVars to the WysiwygEditor's
  // exposed setter. The editor's setter rebuilds odtUserDefined +
  // triggers a save, which round-trips through writeODT into meta.xml.
  function pushUserVars(next: Array<{ name: string; value: string }>) {
    const obj: Record<string, string> = {};
    for (const v of next) {
      const n = v.name.trim();
      if (!n) continue;
      obj[n] = v.value;
    }
    const fn = (window as unknown as {
      weftLoomODTVars?: { set: (v: Record<string, string>) => void };
    }).weftLoomODTVars;
    if (fn) fn.set(obj);
    userVars = next;
  }

  function addUserVar() {
    const name = newVarName.trim();
    if (!name) return;
    if (userVars.some(v => v.name === name)) {
      alert('Une variable nommée "' + name + '" existe déjà.');
      return;
    }
    pushUserVars([...userVars, { name, value: newVarValue }]);
    newVarName = '';
    newVarValue = '';
  }

  function updateUserVar(idx: number, patch: Partial<{ name: string; value: string }>) {
    const next = userVars.map((v, i) => i === idx ? { ...v, ...patch } : v);
    pushUserVars(next);
  }

  function deleteUserVar(idx: number) {
    pushUserVars(userVars.filter((_, i) => i !== idx));
  }
</script>

<aside class="flex flex-col bg-base-100 text-xs h-full w-full">
  <button
    type="button"
    class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200 select-none gap-1 w-full text-left hover:bg-base-300"
    onclick={toggleCollapsed}
    title={collapsed ? 'Expand metadata' : 'Collapse metadata'}
    aria-expanded={!collapsed}
  >
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      class="transition-transform shrink-0"
      class:rotate-90={!collapsed}
    >
      <path d="M5.7 13.7L4.3 12.3 8.6 8 4.3 3.7 5.7 2.3l5.7 5.7-5.7 5.7z"/>
    </svg>
    <!-- codicon `info` glyph — same 14×14 metric as the other panel
         headers. -->
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm9-3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 7v5h2V7H7z"/>
    </svg>
    <span class="font-semibold text-sm">Metadata</span>
    {#if entries.length > 0}
      <span class="ml-2 badge badge-ghost badge-xs">{entries.length}</span>
    {/if}
  </button>

  {#if collapsed}
    <!-- accordion closed -->
  {:else if !file || !lang}
    <p class="px-3 py-2 opacity-50 italic">Open a .tex / .md / .rtf / .odt file to see metadata.</p>
  {:else}
    <div class="overflow-auto flex-1">
      {#if entries.length > 0}
        <dl class="py-1 px-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 content-start items-baseline">
          {#each entries as e (e.key)}
            <dt class="font-mono text-[10px] uppercase opacity-60">{e.label}</dt>
            <dd class="font-mono text-xs truncate" title={e.value}>{e.value}</dd>
          {/each}
        </dl>
      {:else}
        <p class="px-3 py-2 opacity-50 italic">No metadata found in the preamble.</p>
      {/if}

      {#if lang === 'odt'}
        <!-- T10 V0.1.5 : editable user-defined ODT variables. Each
             pair maps to a <meta:user-defined> entry on save, and
             can be referenced inline via the "{f}" Insert-field
             toolbar button → user-field-get path. -->
        <div class="border-t border-base-300 mt-1 pt-2 px-2">
          <div class="text-[10px] uppercase opacity-60 mb-1 flex items-center gap-2">
            <span>Variables</span>
            <span class="badge badge-ghost badge-xs">{userVars.length}</span>
            <span class="ml-auto opacity-50 normal-case text-[10px] italic">interpolées dans le doc</span>
          </div>
          <!-- visually-hidden column headers : screen readers read
               them out, sighted users keep the compact layout. -->
          <div class="sr-only" aria-hidden="false">
            <span id="mp-var-col-name">Nom de la variable</span>
            <span id="mp-var-col-value">Valeur de la variable</span>
          </div>
          {#each userVars as v, idx (v.name + ':' + idx)}
            <div class="flex items-center gap-1 mb-1" data-testid="meta-var-row">
              <label for={'mp-var-name-' + idx} class="sr-only">Nom de la variable {idx + 1}</label>
              <input
                id={'mp-var-name-' + idx}
                type="text"
                class="input input-bordered input-xs font-mono w-28"
                value={v.name}
                onchange={(e) => updateUserVar(idx, { name: (e.currentTarget).value })}
                placeholder="nom"
                data-testid="meta-var-name"
              />
              <label for={'mp-var-value-' + idx} class="sr-only">Valeur de la variable {idx + 1}</label>
              <input
                id={'mp-var-value-' + idx}
                type="text"
                class="input input-bordered input-xs font-mono flex-1 min-w-0"
                value={v.value}
                onchange={(e) => updateUserVar(idx, { value: (e.currentTarget).value })}
                placeholder="valeur"
                data-testid="meta-var-value"
              />
              <button
                type="button"
                class="btn btn-ghost btn-xs text-error"
                onclick={() => deleteUserVar(idx)}
                title="Supprimer cette variable"
                aria-label="Supprimer cette variable"
                data-testid="meta-var-delete"
              >×</button>
            </div>
          {/each}
          <div class="flex items-center gap-1 pt-1 border-t border-base-300/50">
            <label for="mp-var-new-name" class="sr-only">Nom de la nouvelle variable</label>
            <input
              id="mp-var-new-name"
              type="text"
              class="input input-bordered input-xs font-mono w-28"
              placeholder="nom"
              bind:value={newVarName}
              onkeydown={(e) => { if (e.key === 'Enter') addUserVar(); }}
              data-testid="meta-var-new-name"
            />
            <label for="mp-var-new-value" class="sr-only">Valeur de la nouvelle variable</label>
            <input
              id="mp-var-new-value"
              type="text"
              class="input input-bordered input-xs font-mono flex-1 min-w-0"
              placeholder="valeur"
              bind:value={newVarValue}
              onkeydown={(e) => { if (e.key === 'Enter') addUserVar(); }}
              data-testid="meta-var-new-value"
            />
            <button
              type="button"
              class="btn btn-primary btn-xs"
              onclick={addUserVar}
              disabled={!newVarName.trim()}
              title="Ajouter la variable"
              aria-label="Ajouter la variable"
              data-testid="meta-var-add"
            >+</button>
          </div>
          {#if userVars.length > 0}
            <p class="opacity-50 italic text-[10px] mt-1">
              Insère <code>{`{f}`}</code> dans la barre WYSIWYG → "v" → choisis une variable pour la référencer.
            </p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</aside>
