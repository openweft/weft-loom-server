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
  // Raw <office:automatic-styles> XML from the loaded ODT (pass-through
  // on save so user-customised paragraph/cell/list styles still
  // resolve in the round-tripped file).
  let odtPreservedAutoStyles = '';
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
          odtPreservedAutoStyles = parsed.preservedAutoStyles ?? '';
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
        const bytes = await writeODT(
          editorEl.innerHTML,
          new Date().toISOString(),
          odtPreservedAutoStyles,
        );
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

  // insertLink : wraps the current selection in an <a href="…">. If
  // nothing is selected, inserts a fresh link with the URL as visible
  // text + leaves the cursor inside the new <a> so the user can
  // continue typing.
  function insertLink() {
    const url = prompt('URL :');
    if (!url) return;
    editorEl.focus();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && editorEl.contains(sel.getRangeAt(0).startContainer)) {
      document.execCommand('createLink', false, url);
    } else {
      // Restore caret to the end of the contenteditable if the prompt
      // dropped the selection.
      if (sel) {
        const range = document.createRange();
        if (sel.rangeCount === 0 || !editorEl.contains(sel.getRangeAt(0).startContainer)) {
          range.selectNodeContents(editorEl);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      document.execCommand('insertHTML', false,
        '<a href="' + escapeAttr(url) + '">' + escapeHTML(url) + '</a>');
    }
    onInput();
  }

  // insertFootnote : drops a <sup class="footnote"> citation at the
  // caret + lets the user fill in the body via prompt(). The
  // citation number auto-increments from the count of existing
  // sup.footnote elements ; data-id mirrors the citation so the
  // writer round-trips a stable ftnN identifier.
  //
  // The selection is restored to the end of the contenteditable
  // before the insertHTML so the call doesn't no-op when the prompt
  // dialog dropped the original range.
  function insertFootnote() {
    const body = prompt('Footnote body :');
    if (!body) return;
    const existing = editorEl.querySelectorAll('sup.footnote').length;
    const idx = existing + 1;
    editorEl.focus();
    // Build the <sup> in JS rather than insertHTML — Chrome's
    // execCommand('insertHTML') silently rewrites <sup> as
    // <span style="vertical-align: super"> (sanitiser thinks it's
    // a stylistic alias), which destroys the round-trip path.
    const sup = document.createElement('sup');
    sup.className = 'footnote';
    sup.setAttribute('data-id', 'ftn' + idx);
    sup.setAttribute('data-body', body);
    sup.textContent = String(idx);
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount > 0 && editorEl.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(editorEl);
      range.collapse(false);
    }
    range.insertNode(sup);
    // Place the caret immediately after the inserted node so the
    // user can keep typing.
    range.setStartAfter(sup);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    onInput();
  }

  // setAlign : applies the named alignment to the currently selected
  // block(s). Inline-style on the paragraph survives the ODT round-
  // trip via the V0.7 pickAlign path in the writer.
  function setAlign(dir: 'left' | 'center' | 'right' | 'justify') {
    editorEl.focus();
    const cmd = 'justify' + dir.charAt(0).toUpperCase() + dir.slice(1);
    document.execCommand(cmd);
    onInput();
  }

  // setColor / setHighlight : applies a per-span colour or
  // background-colour. Round-trips through ODT's fo:color /
  // fo:background-color in the V0.9 writer.
  function setColor(hex: string) {
    editorEl.focus();
    document.execCommand('foreColor', false, hex);
    onInput();
  }
  function setHighlight(hex: string) {
    editorEl.focus();
    // Chrome supports 'hiliteColor' ; Firefox uses 'backColor' for
    // the same effect on selections. Try both for portability.
    if (!document.execCommand('hiliteColor', false, hex)) {
      document.execCommand('backColor', false, hex);
    }
    onInput();
  }

  // insertPageBreak : drops <hr class="page-break"> at the caret.
  // Round-trips to ODF's <text:p text:style-name="P_pagebreak"/>
  // (paragraph with fo:break-before="page" in auto-styles).
  function insertPageBreak() {
    editorEl.focus();
    const hr = document.createElement('hr');
    hr.className = 'page-break';
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount > 0 && editorEl.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(editorEl);
      range.collapse(false);
    }
    range.insertNode(hr);
    range.setStartAfter(hr);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    onInput();
  }

  // insertComment : drops an <office:annotation>-shaped <span> at
  // the caret. Body is plain text in V0.10 ; rich-body lands later
  // alongside the footnote rich-body pattern.
  function insertComment() {
    const body = prompt('Comment :');
    if (!body) return;
    editorEl.focus();
    const span = document.createElement('span');
    span.className = 'odt-annotation';
    span.setAttribute('data-creator', 'me');
    span.setAttribute('data-date', new Date().toISOString());
    span.setAttribute('data-body', body);
    span.setAttribute('title', 'me — ' + body);
    span.textContent = '💬';
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount > 0 && editorEl.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(editorEl);
      range.collapse(false);
    }
    range.insertNode(span);
    range.setStartAfter(span);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    onInput();
  }

  function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
  function escapeHTML(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    <button type="button" title="Bold (⌘B)"        class="btn btn-ghost btn-xs font-bold"        onclick={() => exec('bold')}>B</button>
    <button type="button" title="Italic (⌘I)"      class="btn btn-ghost btn-xs italic"           onclick={() => exec('italic')}>I</button>
    <button type="button" title="Underline (⌘U)"   class="btn btn-ghost btn-xs underline"        onclick={() => exec('underline')}>U</button>
    <button type="button" title="Strikethrough"    class="btn btn-ghost btn-xs line-through"     onclick={() => exec('strikeThrough')}>S</button>
    <button type="button" title="Superscript"      class="btn btn-ghost btn-xs"                   onclick={() => exec('superscript')}>X²</button>
    <button type="button" title="Subscript"        class="btn btn-ghost btn-xs"                   onclick={() => exec('subscript')}>X₂</button>
    <span class="divider divider-horizontal mx-0"></span>
    <button type="button" title="Align left"       class="btn btn-ghost btn-xs"                   onclick={() => setAlign('left')}>⇤</button>
    <button type="button" title="Align centre"     class="btn btn-ghost btn-xs"                   onclick={() => setAlign('center')}>≡</button>
    <button type="button" title="Align right"      class="btn btn-ghost btn-xs"                   onclick={() => setAlign('right')}>⇥</button>
    <button type="button" title="Justify"          class="btn btn-ghost btn-xs"                   onclick={() => setAlign('justify')}>☰</button>
    <span class="divider divider-horizontal mx-0"></span>
    <button type="button" title="Bullet list"      class="btn btn-ghost btn-xs" onclick={() => exec('insertUnorderedList')}>•</button>
    <button type="button" title="Numbered list"    class="btn btn-ghost btn-xs" onclick={() => exec('insertOrderedList')}>1.</button>
    <button type="button" title="Insert 2×2 table" class="btn btn-ghost btn-xs" onclick={() => insertTable()}>▦</button>
    <button type="button" title="Insert link"        class="btn btn-ghost btn-xs" onclick={() => insertLink()}>🔗</button>
    <button type="button" title="Insert footnote"    class="btn btn-ghost btn-xs" onclick={() => insertFootnote()}>†</button>
    <button type="button" title="Insert comment"     class="btn btn-ghost btn-xs" onclick={() => insertComment()}>💬</button>
    <button type="button" title="Insert page break"  class="btn btn-ghost btn-xs" onclick={() => insertPageBreak()}>⤓</button>
    <span class="divider divider-horizontal mx-0"></span>
    <label title="Text colour" class="btn btn-ghost btn-xs px-1 inline-flex items-center gap-1">
      <span class="font-bold">A</span>
      <input type="color" value="#000000" class="w-4 h-4 p-0 border-0 bg-transparent cursor-pointer"
             onchange={(e) => setColor((e.currentTarget as HTMLInputElement).value)} />
    </label>
    <label title="Highlight" class="btn btn-ghost btn-xs px-1 inline-flex items-center gap-1">
      <span>▮</span>
      <input type="color" value="#ffff00" class="w-4 h-4 p-0 border-0 bg-transparent cursor-pointer"
             onchange={(e) => setHighlight((e.currentTarget as HTMLInputElement).value)} />
    </label>
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
