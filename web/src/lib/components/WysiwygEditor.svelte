<script lang="ts">
  // WysiwygEditor — Word-like editing surface for word-processing
  // formats nobody hand-edits as source : `.rtf` + `.odt`. RTF is
  // control-word markup, ODT is a zipped XML container — CodeMirror
  // on either was bad UX. The editor swaps the raw view for a
  // contenteditable surface so authoring feels like LibreOffice
  // Writer or Word, while the save path serialises back to the
  // original format for round-trip with the rest of the toolchain.

  import { onMount, onDestroy, untrack } from 'svelte';
  import { parseRTF, writeRTF } from '../rtf';
  import { parseODT, writeODT } from '../odt';

  interface Props {
    project: string;
    file: string;
  }
  let { project, file }: Props = $props();

  let editorEl: HTMLDivElement;
  let status = $state<'loading' | 'ready' | 'saving' | 'error'>('loading');
  let errorMessage = $state('');
  let etag = '';
  // Debounce timer for save-on-change : ~600 ms after the last
  // keystroke we serialise + PUT. Keeps the keystroke loop tight.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function format(): 'rtf' | 'odt' {
    return file.toLowerCase().endsWith('.odt') ? 'odt' : 'rtf';
  }

  async function load() {
    status = 'loading';
    try {
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
      );
      if (!r.ok) throw new Error('HTTP ' + r.status);
      etag = r.headers.get('etag') ?? '';
      let html = '';
      if (format() === 'odt') {
        // ODT is binary (zip) ; fetch as ArrayBuffer + decode via the
        // jszip-backed parser.
        const buf = await r.arrayBuffer();
        if (buf.byteLength === 0) {
          html = '<p><br></p>';
        } else {
          const parsed = await parseODT(buf);
          html = parsed.html || '<p><br></p>';
        }
      } else {
        const text = await r.text();
        const parsed = parseRTF(text);
        html = parsed.html || '<p><br></p>';
      }
      editorEl.innerHTML = html;
      status = 'ready';
    } catch (e) {
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  async function save() {
    if (status !== 'ready' && status !== 'saving') return;
    status = 'saving';
    try {
      let body: BodyInit;
      if (format() === 'odt') {
        const bytes = await writeODT(editorEl.innerHTML);
        // BodyInit accepts BufferSource ; wrap to a Blob so fetch
        // sets the proper Content-Length without copying the buffer
        // through a string round-trip.
        // Wrap as Blob. The cast routes around a TS narrowing
        // complaint : Uint8Array's generic buffer type
        // (ArrayBufferLike | SharedArrayBuffer) doesn't satisfy
        // BlobPart's stricter ArrayBuffer-only requirement. Runtime
        // shape is fine — Blob accepts any TypedArray.
        body = new Blob(
          [bytes as unknown as BlobPart],
          { type: 'application/vnd.oasis.opendocument.text' },
        );
      } else {
        body = writeRTF(editorEl.innerHTML);
      }
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
        { method: 'PUT', body },
      );
      if (!r.ok && r.status !== 204) throw new Error('PUT ' + r.status);
      etag = r.headers.get('etag') ?? etag;
      status = 'ready';
    } catch (e) {
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  function onInput() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }

  // Toolbar actions wrap document.execCommand. The API is deprecated
  // in spec but still works in every shipping browser engine + it's
  // the most reliable way to apply rich-text edits in a
  // contenteditable surface without pulling in a 200 kB editor
  // library. The day execCommand truly disappears, the replacement
  // is the Selection / Range API — same shape, more code.
  function exec(cmd: string, arg?: string) {
    editorEl.focus();
    document.execCommand(cmd, false, arg);
    onInput();
  }

  // insertTable : drops a fresh 2×2 table at the caret. The
  // contenteditable doesn't have a built-in execCommand for this
  // (insertHTML works but lands inside the current block ; we use
  // the Selection API to splice the table as a sibling of the
  // current paragraph instead).
  function insertTable(rows: number = 2, cols: number = 2) {
    editorEl.focus();
    const html = '<table><tbody>'
      + Array.from({ length: rows }, () =>
          '<tr>' + Array.from({ length: cols }, () => '<td><br></td>').join('') + '</tr>',
        ).join('')
      + '</tbody></table><p><br></p>';
    document.execCommand('insertHTML', false, html);
    onInput();
  }

  // Keyboard shortcuts : Cmd/Ctrl+B/I/U for bold/italic/underline.
  // The contenteditable surface handles these natively via
  // execCommand, but we wire them explicitly so the parent App's
  // keymap doesn't intercept them.
  function onKeyDown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (e.key === 'b') { e.preventDefault(); exec('bold'); }
    else if (e.key === 'i') { e.preventDefault(); exec('italic'); }
    else if (e.key === 'u') { e.preventDefault(); exec('underline'); }
    else if (e.key === 's') { e.preventDefault(); save(); }
  }

  // Reload when the active file changes (the parent wraps us in
  // `{#key currentFile}` so the component already remounts, but
  // an extra effect lets the same instance follow successive opens
  // if the wrapper changes its strategy later).
  $effect(() => {
    project; file;
    untrack(() => { if (editorEl) load(); });
  });

  onMount(() => { load(); });
  onDestroy(() => { if (saveTimer) clearTimeout(saveTimer); });
</script>

<div class="flex flex-col h-full bg-base-100">
  <!-- Toolbar : minimal Word-style cluster. Headings + B/I/U +
       lists. We deliberately skip font-family / size pickers ; the
       RTF writer fixes those at the document level (Helvetica 12pt).
       Add them when there's an explicit user ask. -->
  <div class="flex items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200 text-sm">
    <select
      class="select select-bordered select-xs"
      onchange={(e) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        if (v === 'p') exec('formatBlock', 'p');
        else if (v === 'h1' || v === 'h2' || v === 'h3') exec('formatBlock', v);
        (e.currentTarget as HTMLSelectElement).value = '';
      }}
    >
      <option value="" disabled selected>Style</option>
      <option value="p">Paragraph</option>
      <option value="h1">Heading 1</option>
      <option value="h2">Heading 2</option>
      <option value="h3">Heading 3</option>
    </select>
    <span class="divider divider-horizontal mx-0"></span>
    <button type="button" title="Bold (⌘B)"      class="btn btn-ghost btn-xs font-bold"     onclick={() => exec('bold')}>B</button>
    <button type="button" title="Italic (⌘I)"    class="btn btn-ghost btn-xs italic"        onclick={() => exec('italic')}>I</button>
    <button type="button" title="Underline (⌘U)" class="btn btn-ghost btn-xs underline"     onclick={() => exec('underline')}>U</button>
    <span class="divider divider-horizontal mx-0"></span>
    <button type="button" title="Bullet list"      class="btn btn-ghost btn-xs" onclick={() => exec('insertUnorderedList')}>•</button>
    <button type="button" title="Numbered list"    class="btn btn-ghost btn-xs" onclick={() => exec('insertOrderedList')}>1.</button>
    <button type="button" title="Insert 2×2 table" class="btn btn-ghost btn-xs" onclick={() => insertTable()}>▦</button>
    <span class="divider divider-horizontal mx-0"></span>
    <button type="button" title="Undo (⌘Z)"  class="btn btn-ghost btn-xs" onclick={() => exec('undo')}>↶</button>
    <button type="button" title="Redo (⌘⇧Z)" class="btn btn-ghost btn-xs" onclick={() => exec('redo')}>↷</button>
    <div class="flex-1"></div>
    {#if status === 'saving'}
      <span class="opacity-60 text-xs">saving…</span>
    {:else if status === 'error'}
      <span class="text-error text-xs" title={errorMessage}>error</span>
    {:else if status === 'ready'}
      <span class="opacity-50 text-xs uppercase">{format()}</span>
    {/if}
  </div>

  <!-- Editing surface -->
  <div
    bind:this={editorEl}
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-label="Rich text editor"
    aria-multiline="true"
    spellcheck="true"
    oninput={onInput}
    onkeydown={onKeyDown}
    class="flex-1 overflow-auto px-8 py-6 outline-none prose prose-sm max-w-none bg-base-100 wysiwyg-surface"
    style="line-height: 1.6; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;"
  ></div>
</div>

<style>
  .wysiwyg-surface :global(p) { margin: 0 0 0.6em; }
  .wysiwyg-surface :global(h1) { font-size: 1.6em; font-weight: 700; margin: 0.4em 0; }
  .wysiwyg-surface :global(h2) { font-size: 1.35em; font-weight: 700; margin: 0.4em 0; }
  .wysiwyg-surface :global(h3) { font-size: 1.15em; font-weight: 700; margin: 0.3em 0; }
  .wysiwyg-surface :global(ul) { padding-left: 1.5em; list-style: disc; }
  .wysiwyg-surface :global(ol) { padding-left: 1.5em; list-style: decimal; }
  /* Tables : visible borders + sensible cell padding so the user
     can see what they're editing. ODT round-trip preserves the
     cell content + spans ; styling lives only in the WYSIWYG
     surface (the ODT file itself stays unstyled — Word /
     LibreOffice apply their own default table style on open). */
  .wysiwyg-surface :global(table) { border-collapse: collapse; margin: 0.6em 0; }
  .wysiwyg-surface :global(th),
  .wysiwyg-surface :global(td) { border: 1px solid currentColor; padding: 0.3em 0.5em; min-width: 4em; }
  .wysiwyg-surface :global(th) { font-weight: 600; background: rgba(0,0,0,0.04); }
</style>
