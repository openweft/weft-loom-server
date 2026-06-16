<script lang="ts">
  // WysiwygEditor — Word-like editing surface for word-processing
  // formats nobody hand-edits as source : `.rtf` + `.odt`. RTF is
  // control-word markup, ODT is a zipped XML container — CodeMirror
  // on either was bad UX. The editor swaps the raw view for a
  // contenteditable surface so authoring feels like LibreOffice
  // Writer or Word, while the save path serialises back to the
  // original format for round-trip with the rest of the toolchain.

  import { onMount, onDestroy, untrack } from 'svelte';
  import DOMPurify from 'dompurify';
  import { parseRTF, writeRTF } from '../rtf';
  import { parseODT, writeODT } from '../odt';
  import { logError } from '../logbus';

  // Attribute allow-list preserved when sanitising rich-text we
  // generate ourselves (parseODT / parseRTF). DOMPurify drops these
  // data-* attributes by default ; we need them for the writeback path
  // (annotations, footnotes, bookmarks, fields, style hints).
  // Generated from `grep -hoE "data-[a-z][a-z0-9-]+" odt.ts rtf.ts | sort -u`.
  // Missing entries silently break the writer round-trip — the audit caught
  // data-fixed-date / data-date-value / data-time-value / data-result /
  // data-role / data-text-style-name / data-attrs being stripped here even
  // though the writer reads them back.
  const SANITIZE_OPTS = {
    ADD_ATTR: [
      'data-fmt', 'data-name', 'data-bookmark', 'data-anchor',
      'data-footnote-id', 'data-style-name', 'data-id', 'data-body',
      'data-kind', 'data-creator', 'data-date', 'data-band',
      'data-odt-style', 'data-placeholder',
      'data-attrs', 'data-date-value', 'data-time-value',
      'data-fixed-date', 'data-result', 'data-role',
      'data-text-style-name',
      // Note : 'contenteditable' deliberately NOT allowed. The host
      // editorEl is contenteditable via the Svelte template ; nested
      // contenteditable inside sanitised HTML would let an ODT/RTF
      // payload create confused-deputy editable regions (clicking a
      // label spawns an editor where the user didn't expect one).
    ],
    // RETURN_TRUSTED_TYPES is false by default — set explicitly so
    // the return type narrows to `string` for innerHTML / {@html}.
    RETURN_TRUSTED_TYPE: false as const,
  };

  function sanitize(html: string): string {
    return DOMPurify.sanitize(html, SANITIZE_OPTS) as unknown as string;
  }

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
  // T10 : user-defined meta vars carried across the load/save cycle.
  // The VariablesPanel writes here ; save() forwards to writeODT.
  let odtUserDefined = $state<Record<string, string>>({});
  // T10 V0.2 : header + footer content from styles.xml. Editable
  // bands in Pages mode ; round-trip into a re-emitted styles.xml
  // on save.
  let odtHeader = $state<string>('');
  let odtFooter = $state<string>('');
  // svelte-ignore non_reactive_update -- bind:this populates these; only read in handlers + save snapshot.
  let headerEl: HTMLDivElement | undefined;
  // svelte-ignore non_reactive_update -- same as headerEl
  let footerEl: HTMLDivElement | undefined;
  // Debounce timer for save-on-change : ~600 ms after the last
  // keystroke we serialise + PUT. Keeps the keystroke loop tight.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  // dirty flips true on every keystroke + false at the start of
  // save(). The toolbar status badge reads it to show "modifié"
  // vs "enregistré" so the user sees at a glance whether the file
  // is in sync with disk.
  let dirty = $state(false);
  // savedAt is the timestamp of the last successful save ; the
  // toolbar shows "il y a Ns" / "à HH:MM" so the user can audit the
  // auto-save cadence.
  let savedAt = $state<number | null>(null);

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
          odtUserDefined = parsed.meta.userDefined ?? {};
          odtHeader = parsed.header ?? '';
          odtFooter = parsed.footer ?? '';
          // Expose for the Variables sidebar : the panel reads
          // + mutates this object directly, and the next save()
          // call picks the latest snapshot up.
          (window as unknown as {
            weftLoomODTVars?: {
              get: () => Record<string, string>;
              set: (v: Record<string, string>) => void;
            };
          }).weftLoomODTVars = {
            get: () => odtUserDefined,
            set: (v) => { odtUserDefined = { ...v }; save(); },
          };
        }
      } else {
        const text = await r.text();
        const parsed = parseRTF(text);
        html = parsed.html || '<p><br></p>';
      }
      editorEl.innerHTML = sanitize(html);
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
        // Snapshot the H/F editable bands before serialising — the
        // contenteditable divs may have been edited since the last
        // load() ; if they haven't been mounted (continuous mode)
        // we fall back to the stashed string.
        const hSnap = headerEl ? headerEl.innerHTML : odtHeader;
        const fSnap = footerEl ? footerEl.innerHTML : odtFooter;
        const bytes = await writeODT(
          editorEl.innerHTML,
          new Date().toISOString(),
          odtPreservedAutoStyles,
          odtUserDefined,
          hSnap,
          fSnap,
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
      const headers: Record<string, string> = {};
      if (etag) headers['If-Match'] = etag;
      const r = await fetch(
        '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file),
        { method: 'PUT', body, headers },
      );
      if (r.status === 412) {
        logError('wysiwyg', 'put_precondition_failed', new Error('etag mismatch'), { project, file, etag });
        throw new Error('PUT 412 — la version sur disque a changé (recharger pour fusionner)');
      }
      if (!r.ok && r.status !== 204) throw new Error('PUT ' + r.status);
      etag = r.headers.get('etag') ?? etag;
      status = 'ready';
      dirty = false;
      savedAt = Date.now();
    } catch (e) {
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  // Adaptive debounce window (M5 of the 2026-06-14 perf audit).
  // writeODT zips the entire ODF container — for multi-page documents
  // that's 50-200 ms of sync work on the main thread. Scale the
  // debounce by the current doc size so big docs don't pay the spike
  // between every keystroke pause. RTF stays at 600 ms because
  // writeRTF is a sync string build (no zip).
  function pickDebounce(): number {
    if (format() !== 'odt') return 600;
    const len = editorEl?.innerHTML.length ?? 0;
    if (len > 200_000) return 3000;
    if (len > 50_000) return 1500;
    return 600;
  }

  // Idle-scheduled save : requestIdleCallback waits until the browser
  // is actually idle, so the serialise + zip lands between frames
  // instead of stalling the next keystroke. Safari before 2025 lacks
  // the API ; fall back to a plain setTimeout(0) there.
  function scheduleSave() {
    type IdleWindow = Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout?: number },
      ) => number;
    };
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') {
      // 2 s timeout so a hot main thread can't starve the save forever.
      w.requestIdleCallback(() => { void save(); }, { timeout: 2000 });
    } else {
      setTimeout(() => { void save(); }, 0);
    }
  }

  function onInput() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(scheduleSave, pickDebounce());
  }

  // saveNow cancels the debounced auto-save + writes immediately.
  // Wired to the toolbar's 💾 button + Cmd+S handler so the user can
  // force an explicit checkpoint without waiting the debounce.
  async function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    await save();
  }

  // savedLabel : how long ago the last save landed, surfaced next
  // to the save icon. Updated by a 30 s tick so the user sees the
  // string drift without it churning every render. Only tick while
  // `savedAt` is set AND was within the last hour ; beyond that the
  // label degrades to "à HH:MM" which is static, so the interval is
  // pure overhead (L3 of the 2026-06-14 perf audit).
  let nowTick = $state(Date.now());
  $effect(() => {
    if (!savedAt) return;
    if (nowTick - savedAt > 3600_000) return;
    // Force one tick now so the relative label re-renders when this
    // effect kicks back in after `savedAt` flips from null.
    nowTick = Date.now();
    const id = setInterval(() => { nowTick = Date.now(); }, 30000);
    return () => clearInterval(id);
  });

  // T11 : page-layout toggle + paper size. Pages mode constrains
  // the editor to a fixed-width column styled like A4 / US Letter
  // with margins + box-shadow ; continuous mode is the original
  // edge-to-edge writing surface. Both persist in localStorage so
  // the user's preference survives a reload.
  const PAGE_MODE_KEY = 'weft-loom-page-mode';
  const PAPER_SIZE_KEY = 'weft-loom-paper-size';
  let pageMode = $state<'continuous' | 'pages'>(
    (typeof localStorage !== 'undefined' && (localStorage.getItem(PAGE_MODE_KEY) as 'continuous' | 'pages')) || 'continuous',
  );
  let paperSize = $state<'a4' | 'letter'>(
    (typeof localStorage !== 'undefined' && (localStorage.getItem(PAPER_SIZE_KEY) as 'a4' | 'letter')) || 'a4',
  );
  $effect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PAGE_MODE_KEY, pageMode);
      localStorage.setItem(PAPER_SIZE_KEY, paperSize);
    }
  });
  // Paper geometry in centimetres. The rulers tick every cm + the
  // page wrapper uses these for width/min-height. Margins are
  // editable in V0.2 ; V0.1 ships sane defaults (2.5 cm all around
  // matches the LibreOffice + Word default).
  const PAPER_DIMS: Record<'a4' | 'letter', { wCm: number; hCm: number }> = {
    a4:     { wCm: 21,    hCm: 29.7 },
    letter: { wCm: 21.59, hCm: 27.94 },
  };
  const MARGIN_CM = 2.5;
  const paperWidthCm  = $derived(PAPER_DIMS[paperSize].wCm);
  const paperHeightCm = $derived(PAPER_DIMS[paperSize].hCm);
  // Ruler tick labels every cm — 0, 1, 2, … wCm-1. The body area
  // starts at MARGIN_CM cm, ends at paperWidthCm - MARGIN_CM.
  const hTicks = $derived(Array.from({ length: Math.floor(paperWidthCm) + 1 }, (_, i) => i));
  const vTicks = $derived(Array.from({ length: Math.floor(paperHeightCm) + 1 }, (_, i) => i));

  // switchPageMode : a single contenteditable div lives outside the
  // pages-vs-continuous branches now, so toggling the layout no
  // longer unmounts/remounts the editor — selection + focus survive
  // the swap. We just flip the reactive state ; the wrapper CSS
  // does the rest.
  //
  // The header + footer bands ARE mounted only in Pages mode (so
  // their contenteditable doesn't shadow the body's
  // [contenteditable=true][role=textbox] selector). When we toggle
  // away from Pages, snapshot their live innerHTML into the
  // odtHeader / odtFooter state so the next remount picks the
  // user's edits up again ({@html sanitize(odtHeader)} re-renders
  // with the snapshotted markup).
  function switchPageMode(next: 'continuous' | 'pages') {
    if (pageMode === next) return;
    if (pageMode === 'pages') {
      if (headerEl) odtHeader = headerEl.innerHTML;
      if (footerEl) odtFooter = footerEl.innerHTML;
    }
    pageMode = next;
  }

  const savedLabel = $derived(() => {
    if (!savedAt) return '';
    const delta = Math.max(0, nowTick - savedAt);
    if (delta < 60_000) return 'il y a ' + Math.floor(delta / 1000) + 's';
    if (delta < 3600_000) return 'il y a ' + Math.floor(delta / 60_000) + ' min';
    const d = new Date(savedAt);
    return 'à ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

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

  // V0.13 : font family + size apply to the current selection. The
  // execCommands wrap the selection in a <font> tag — the writer
  // picks the face/size out of that AND the inline-style fallback.
  function setFontFamily(name: string) {
    if (!name) return;
    editorEl.focus();
    document.execCommand('fontName', false, name);
    onInput();
  }
  function setFontSize(pt: string) {
    if (!pt) return;
    editorEl.focus();
    // execCommand('fontSize') only accepts 1-7. We wrap in a span
    // with inline font-size so the writer's pt-aware path picks it
    // up cleanly.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      onInput();
      return;
    }
    const range = sel.getRangeAt(0);
    const span = document.createElement('span');
    span.style.fontSize = pt;
    try {
      range.surroundContents(span);
    } catch {
      // surroundContents throws when the range crosses element
      // boundaries ; fall back to extracting + re-wrapping.
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();
    onInput();
  }

  // T12 : insertTextFrame drops a draw:text-box-style box at the
  // caret. It's an editable <aside class="odt-textbox"> with a
  // visible border ; round-trips through writeODT as <draw:frame>
  // <draw:text-box> on save.
  function insertTextFrame() {
    editorEl.focus();
    const aside = document.createElement('aside');
    aside.className = 'odt-textbox';
    aside.contentEditable = 'true';
    aside.style.width = '12cm';
    aside.style.height = '4cm';
    const p = document.createElement('p');
    p.textContent = 'Text frame — replace this content.';
    aside.appendChild(p);
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
    range.insertNode(aside);
    range.setStartAfter(aside);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    onInput();
  }

  // T12 : insertMedia opens a file picker, loads the chosen media
  // as a data: URL, and drops an <audio>/<video> element at the
  // caret. The writer collects the bytes + repackages them under
  // Pictures/mediaN.<ext> in the ODF zip.
  function insertMedia() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,video/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        editorEl.focus();
        const isAudio = file.type.startsWith('audio/');
        const el = document.createElement(isAudio ? 'audio' : 'video');
        el.setAttribute('controls', '');
        el.setAttribute('src', String(reader.result));
        el.setAttribute('data-name', file.name);
        if (!isAudio) {
          el.style.maxWidth = '100%';
          el.style.display = 'block';
        }
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
        range.insertNode(el);
        range.setStartAfter(el);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
        onInput();
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  // T10 : insertField surfaces an ODT field at the caret. The
  // kind is picked from a small prompt() list ; user-field-get
  // also asks for the variable name. Round-trips as a
  // <text:page-number/> / <text:user-field-get …/> on save.
  function insertField() {
    const choice = prompt(
      'Insert field — pick one :\n'
      + ' p  = page number\n'
      + ' n  = page count\n'
      + ' d  = date\n'
      + ' t  = title\n'
      + ' a  = author\n'
      + ' f  = file name\n'
      + ' c  = chapter\n'
      + ' v  = user variable (will ask for name)\n',
      'p',
    );
    if (!choice) return;
    const map: Record<string, string> = {
      p: 'page-number', n: 'page-count', d: 'date',
      t: 'title', a: 'author-name', f: 'file-name', c: 'chapter',
    };
    let kind = map[choice.trim().toLowerCase()];
    let name = '';
    if (choice.trim().toLowerCase() === 'v') {
      kind = 'user-field-get';
      const askedName = prompt('Variable name :', 'ClientName');
      if (!askedName) return;
      name = askedName.trim();
    }
    if (!kind) return;
    editorEl.focus();
    const span = document.createElement('span');
    span.className = 'odt-field';
    span.setAttribute('data-kind', kind);
    if (name) span.setAttribute('data-name', name);
    // Same label-resolution helper used by parseODT so what the
    // user sees in the editor matches what the reader would show
    // for the same field.
    const label = ({
      'page-number': '[#]',
      'page-count': '[N]',
      'date': '[date]',
      'time': '[time]',
      'title': '[title]',
      'author-name': '[author]',
      'file-name': '[file]',
      'chapter': '[chapter]',
      'user-field-get': '[$' + (name || 'var') + ']',
    } as Record<string, string>)[kind] ?? ('[' + kind + ']');
    span.textContent = label;
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
    else if (e.key === 's') { e.preventDefault(); void saveNow(); }
  }

  // Reload when the active file changes (the parent wraps us in
  // `{#key currentFile}` so the component already remounts, but
  // an extra effect lets the same instance follow successive opens
  // if the wrapper changes its strategy later). Flush any pending
  // edits to the OLD file before switching so they don't get lost.
  $effect(() => {
    project; file;
    untrack(() => {
      if (!editorEl) return;
      void (async () => {
        if (dirty) await saveNow();
        await load();
      })();
    });
  });

  // beforeunload : two responsibilities.
  // 1. RTF : writeRTF is sync, so we serialise the buffer + ship via
  //    sendBeacon for a real best-effort write during unload.
  // 2. ODT : writeODT is async (jszip gzip). We CAN'T await here, and
  //    writing raw HTML to a .odt file on disk corrupts it irrecoverably
  //    (next parseODT fails). Instead we fall back to the browser's
  //    built-in unsaved-changes prompt by setting returnValue / calling
  //    preventDefault — that gives the user a chance to cancel the
  //    navigation and save normally.
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!dirty) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    try {
      const url = '/api/projects/' + encodeURIComponent(project) + '/files/' + encodeURIComponent(file);
      if (format() === 'rtf') {
        const body = writeRTF(editorEl?.innerHTML ?? '');
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([body], { type: 'application/rtf' }));
        } else {
          const headers: Record<string, string> = {};
          if (etag) headers['If-Match'] = etag;
          void fetch(url, { method: 'PUT', body, headers, keepalive: true });
        }
        return;
      }
      // ODT : surface the browser's built-in unsaved-changes prompt.
      e.preventDefault();
      e.returnValue = '';
    } catch (err) {
      logError('wysiwyg', 'beforeunload_flush', err);
    }
  }

  onMount(() => {
    load();
    window.addEventListener('beforeunload', onBeforeUnload);
  });
  onDestroy(() => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      if (dirty) void saveNow();
    }
  });
</script>

<div class="flex flex-col h-full bg-base-100">
  <!-- Toolbar : minimal Word-style cluster. Headings + B/I/U +
       lists. We deliberately skip font-family / size pickers ; the
       RTF writer fixes those at the document level (Helvetica 12pt).
       Add them when there's an explicit user ask. -->
  <div class="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200 text-sm">
    <label class="flex flex-col gap-0.5">
      <span class="text-[10px] uppercase opacity-50 leading-none">Style</span>
      <select
        class="select select-bordered select-xs"
        title="Block style"
        onchange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          if (v === 'p') exec('formatBlock', 'p');
          else if (v === 'h1' || v === 'h2' || v === 'h3') exec('formatBlock', v);
          (e.currentTarget as HTMLSelectElement).value = '';
        }}
      >
        <option value="" disabled selected>Style…</option>
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
    </label>
    <label class="flex flex-col gap-0.5">
      <span class="text-[10px] uppercase opacity-50 leading-none">Font</span>
      <select
        class="select select-bordered select-xs"
        title="Font family"
        onchange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          if (v) setFontFamily(v);
          (e.currentTarget as HTMLSelectElement).value = '';
        }}
      >
        <option value="" disabled selected>Font…</option>
        <option>Arial</option>
        <option>Helvetica</option>
        <option>Times New Roman</option>
        <option>Georgia</option>
        <option>Garamond</option>
        <option>Courier New</option>
        <option>Verdana</option>
        <option>Calibri</option>
      </select>
    </label>
    <label class="flex flex-col gap-0.5">
      <span class="text-[10px] uppercase opacity-50 leading-none">Size</span>
      <select
        class="select select-bordered select-xs"
        title="Font size"
        onchange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          if (v) setFontSize(v);
          (e.currentTarget as HTMLSelectElement).value = '';
        }}
      >
        <option value="" disabled selected>Size…</option>
        <option value="8pt">8</option>
        <option value="9pt">9</option>
        <option value="10pt">10</option>
        <option value="11pt">11</option>
        <option value="12pt">12</option>
        <option value="14pt">14</option>
        <option value="16pt">16</option>
        <option value="18pt">18</option>
        <option value="24pt">24</option>
        <option value="36pt">36</option>
      </select>
    </label>
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
    <button type="button" title="Insert field (page#, date, title, $var…)" class="btn btn-ghost btn-xs" onclick={() => insertField()}>{`{f}`}</button>
    <button type="button" title="Insert text frame" class="btn btn-ghost btn-xs" onclick={() => insertTextFrame()}>▭</button>
    <button type="button" title="Insert audio / video" class="btn btn-ghost btn-xs" onclick={() => insertMedia()}>🎬</button>
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
    <span class="divider divider-horizontal mx-0"></span>
    <!-- T11 : layout mode toggle ((Continu) vs (Pages)) + paper size
         dropdown. Pages mode renders the editor inside a fixed-width
         A4/US-Letter column with horizontal + vertical rulers above
         and to the left of the writing surface. -->
    <div class="join" title="Mode de présentation">
      <button
        type="button"
        class="join-item btn btn-xs"
        class:btn-active={pageMode === 'continuous'}
        onclick={() => switchPageMode('continuous')}
        data-testid="layout-continuous"
      >Continu</button>
      <button
        type="button"
        class="join-item btn btn-xs"
        class:btn-active={pageMode === 'pages'}
        onclick={() => switchPageMode('pages')}
        data-testid="layout-pages"
      >Pages</button>
    </div>
    {#if pageMode === 'pages'}
      <select
        class="select select-bordered select-xs"
        bind:value={paperSize}
        title="Format papier"
        data-testid="layout-paper"
      >
        <option value="a4">A4</option>
        <option value="letter">US Letter</option>
      </select>
    {/if}
    <span class="divider divider-horizontal mx-0"></span>
    <!-- Explicit save button : visible 💾 + status badge so the user
         never has to wonder whether their changes are on disk.
         Cmd+S also routes here through the keyboard handler. -->
    <button
      type="button"
      title={dirty ? 'Enregistrer (⌘S) — modifications non enregistrées' : 'Enregistrer maintenant (⌘S)'}
      class="btn btn-xs gap-1"
      class:btn-primary={dirty}
      class:btn-ghost={!dirty}
      onclick={() => { void saveNow(); }}
      disabled={status === 'saving' || !file}
      data-testid="wysiwyg-save"
    >
      <span class="text-base leading-none">💾</span>
      <span class="hidden sm:inline">{dirty ? 'Enregistrer' : 'Enregistré'}</span>
    </button>
    <div class="flex-1"></div>
    {#if status === 'saving'}
      <span class="text-xs flex items-center gap-1">
        <span class="loading loading-spinner loading-xs"></span>
        enregistrement…
      </span>
    {:else if status === 'error'}
      <span class="text-error text-xs" title={errorMessage}>⚠ erreur</span>
    {:else if status === 'ready' && dirty}
      <span class="text-warning text-xs" title="Modifications non enregistrées">● modifié</span>
    {:else if status === 'ready' && savedAt}
      <span class="opacity-50 text-xs">✓ {savedLabel()}</span>
    {:else if status === 'ready'}
      <span class="opacity-50 text-xs uppercase">{format()}</span>
    {/if}
  </div>

  <!-- Editing surface : one shared contenteditable lives at the
       same DOM position in both modes — toggling pageMode flips
       wrapper classes + visibility of the page chrome instead of
       unmounting the editor, so selection + focus survive the
       switch. Header + footer bands are only mounted in Pages mode
       (in Continuous mode they have no visual representation, and
       leaving them mounted would shadow the body's
       [contenteditable=true][role=textbox] selector — a11y tooling
       and tests would pick up the empty header first). The save
       path already falls back to the stashed odtHeader/odtFooter
       strings when their refs are undefined, so the round-trip
       is preserved across toggles. -->
  <div
    class="flex-1 overflow-auto bg-base-200"
    class:page-mode-wrap={pageMode === 'pages'}
    class:continuous-mode={pageMode === 'continuous'}
    data-testid={pageMode === 'pages' ? 'page-mode-wrap' : 'continuous-mode-wrap'}
  >
    {#if pageMode === 'pages'}
      <!-- Horizontal ruler : sticky to the top so it tracks the
           page as the user scrolls. cm ticks every 1 cm with a
           numeric label every other tick. -->
      <div class="ruler-h" style="width: {paperWidthCm}cm">
        {#each hTicks as cm (cm)}
          <div
            class="tick"
            class:tick-major={cm % 1 === 0}
            class:tick-margin={cm === MARGIN_CM || cm === paperWidthCm - MARGIN_CM}
            style="left: {cm}cm"
          ><span class="tick-label">{cm}</span></div>
        {/each}
        <!-- Body shading inside the margins -->
        <div class="ruler-body" style="left: {MARGIN_CM}cm; width: {paperWidthCm - 2 * MARGIN_CM}cm"></div>
      </div>
    {/if}
    <div
      class="page-row"
      class:page-row-pages={pageMode === 'pages'}
      class:page-row-continuous={pageMode === 'continuous'}
      style={pageMode === 'pages' ? `min-width: calc(${paperWidthCm}cm + 2.5rem)` : ''}
    >
      {#if pageMode === 'pages'}
        <!-- Vertical ruler : cm ticks down the left side of the page. -->
        <div class="ruler-v" style="height: {paperHeightCm}cm">
          {#each vTicks as cm (cm)}
            <div
              class="tick-v"
              class:tick-major={cm % 1 === 0}
              class:tick-margin={cm === MARGIN_CM || cm === paperHeightCm - MARGIN_CM}
              style="top: {cm}cm"
            ><span class="tick-label-v">{cm}</span></div>
          {/each}
          <div class="ruler-body-v" style="top: {MARGIN_CM}cm; height: {paperHeightCm - 2 * MARGIN_CM}cm"></div>
        </div>
      {/if}
      <div
        class="page-paper"
        class:page-paper-pages={pageMode === 'pages'}
        class:page-paper-continuous={pageMode === 'continuous'}
        style={pageMode === 'pages' ? `width: ${paperWidthCm}cm; min-height: ${paperHeightCm}cm` : ''}
      >
        <!-- T10 V0.2 : editable header band — only mounted in Pages
             mode. save() falls back to the stashed odtHeader string
             when headerEl is undefined so the round-trip is preserved
             across mode toggles. -->
        {#if pageMode === 'pages'}
        <div
          bind:this={headerEl}
          contenteditable="true"
          role="textbox"
          aria-label="Page header"
          spellcheck="true"
          oninput={onInput}
          class="page-band page-header wysiwyg-band prose prose-sm max-w-none"
          style={`margin: 0.5cm ${MARGIN_CM}cm 0 ${MARGIN_CM}cm; min-height: 1cm; padding-bottom: 0.3cm; line-height: 1.4; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;`}
          data-band="header"
          data-placeholder="en-tête (clic pour éditer)"
        >{@html sanitize(odtHeader)}</div>
        {/if}
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
          class="wysiwyg-surface prose prose-sm max-w-none"
          style={pageMode === 'pages'
            ? `padding: 0.3cm ${MARGIN_CM}cm 0.3cm ${MARGIN_CM}cm; line-height: 1.6; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; min-height: calc(${paperHeightCm}cm - ${2 * MARGIN_CM}cm - 3cm);`
            : `flex: 1 1 auto; overflow: auto; padding: 1.5rem 2rem; line-height: 1.6; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: var(--fallback-b1, oklch(var(--b1)/1));`}
        ></div>
        {#if pageMode === 'pages'}
        <div
          bind:this={footerEl}
          contenteditable="true"
          role="textbox"
          aria-label="Page footer"
          spellcheck="true"
          oninput={onInput}
          class="page-band page-footer wysiwyg-band prose prose-sm max-w-none"
          style={`margin: 0 ${MARGIN_CM}cm 0.5cm ${MARGIN_CM}cm; min-height: 1cm; padding-top: 0.3cm; line-height: 1.4; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;`}
          data-band="footer"
          data-placeholder="pied de page (clic pour éditer)"
        >{@html sanitize(odtFooter)}</div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  /* Keyboard-only focus indicator — replaces the outline removed
     for mouse users with a visible-but-tasteful 2 px ring when the
     user reaches the contenteditable via Tab. The bands
     (.wysiwyg-band, header/footer) share the same focus + placeholder
     styles but a distinct class so .wysiwyg-surface remains a body-
     only selector — A1 of the cross-feature interaction test relies
     on that to read the body's text content after a pageMode flip. */
  .wysiwyg-surface, .wysiwyg-band { outline: none; }
  .wysiwyg-surface:focus-visible, .wysiwyg-band:focus-visible {
    outline: 2px solid var(--color-primary, #2563eb);
    outline-offset: -2px;
  }
  /* CSS-driven placeholder for the header + footer bands. Lives
     entirely in the stylesheet so it never leaks into innerHTML
     (otherwise the placeholder string would serialise back into
     the saved ODT). The :empty matcher fires when the band has
     no children. */
  .wysiwyg-band[data-placeholder]:empty:not(:focus)::before {
    content: attr(data-placeholder);
    color: rgba(0, 0, 0, 0.4);
    font-style: italic;
    pointer-events: none;
  }
  .wysiwyg-surface :global(p) { margin: 0 0 0.6em; }
  /* Heading auto-numbering : the contenteditable defines three
     CSS counters (sec, ssec, sssec) reset by each ancestor level
     so H1 → "1.", H2 → "1.1", H3 → "1.1.1". The .no-num class
     turned on per-heading (data-odt-style="Quotation" or via the
     toolbar) opts a heading out — useful for an unnumbered
     "Abstract" or "References" heading. */
  .wysiwyg-surface { counter-reset: sec 0 ssec 0 sssec 0; }
  .wysiwyg-surface :global(h1) {
    font-size: 1.6em; font-weight: 700; margin: 0.4em 0;
    counter-increment: sec;
    counter-reset: ssec 0 sssec 0;
  }
  .wysiwyg-surface :global(h1):not(.no-num)::before {
    content: counter(sec) ". ";
    color: rgba(0, 100, 200, 0.7);
    margin-right: 0.2em;
  }
  .wysiwyg-surface :global(h2) {
    font-size: 1.35em; font-weight: 700; margin: 0.4em 0;
    counter-increment: ssec;
    counter-reset: sssec 0;
  }
  .wysiwyg-surface :global(h2):not(.no-num)::before {
    content: counter(sec) "." counter(ssec) " ";
    color: rgba(0, 100, 200, 0.7);
    margin-right: 0.2em;
  }
  .wysiwyg-surface :global(h3) {
    font-size: 1.15em; font-weight: 700; margin: 0.3em 0;
    counter-increment: sssec;
  }
  .wysiwyg-surface :global(h3):not(.no-num)::before {
    content: counter(sec) "." counter(ssec) "." counter(sssec) " ";
    color: rgba(0, 100, 200, 0.7);
    margin-right: 0.2em;
  }
  /* H1/H2/H3 inside annotation popovers + footnote bodies shouldn't
     pick up the document-wide counter — the WYSIWYG's <h?> children
     of <span.odt-annotation> get the same selectors otherwise. */
  .wysiwyg-surface :global(span.odt-annotation) :global(h1)::before,
  .wysiwyg-surface :global(span.odt-annotation) :global(h2)::before,
  .wysiwyg-surface :global(span.odt-annotation) :global(h3)::before { content: ''; }
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
  /* V0.12 : V0.10 markers need to be visible to the user even though
     they have no semantic text content. */
  .wysiwyg-surface :global(hr.page-break) {
    border: none;
    border-top: 2px dashed currentColor;
    margin: 1em 0;
    opacity: 0.5;
    position: relative;
  }
  .wysiwyg-surface :global(hr.page-break::after) {
    content: 'page break';
    position: absolute;
    top: -0.7em;
    left: 50%;
    transform: translateX(-50%);
    background: var(--fallback-b1, oklch(var(--b1)/1));
    padding: 0 0.5em;
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .wysiwyg-surface :global(a.odt-bookmark) {
    display: inline-block;
    width: 0.8em;
    height: 0.8em;
    background: rgba(255, 200, 0, 0.4);
    border: 1px solid rgba(180, 130, 0, 0.6);
    border-radius: 2px;
    margin: 0 1px;
    vertical-align: middle;
  }
  .wysiwyg-surface :global(a.odt-bookmark::before) {
    content: attr(data-name);
    position: absolute;
    background: rgba(255, 240, 200, 0.95);
    border: 1px solid rgba(180, 130, 0, 0.7);
    padding: 0 0.4em;
    border-radius: 2px;
    font-size: 0.7em;
    transform: translateY(-1.6em);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
    white-space: nowrap;
  }
  .wysiwyg-surface :global(a.odt-bookmark:hover::before) { opacity: 1; }
  .wysiwyg-surface :global(span.odt-annotation) {
    background: rgba(255, 230, 100, 0.3);
    border: 1px solid rgba(180, 140, 0, 0.5);
    border-radius: 3px;
    padding: 0 0.2em;
    cursor: help;
  }
  /* T12 : ODT text frame visualisation. Floating box with a
     visible border + light shadow so the user can see the frame
     is separate from the surrounding flow. Round-trips as
     <draw:frame><draw:text-box>. */
  .wysiwyg-surface :global(aside.odt-textbox) {
    display: block;
    margin: 0.6em auto;
    padding: 0.6em;
    border: 1px dashed rgba(0, 100, 200, 0.5);
    background: rgba(0, 130, 220, 0.04);
    border-radius: 4px;
    min-height: 2em;
    position: relative;
  }
  .wysiwyg-surface :global(aside.odt-textbox)::before {
    content: 'cadre';
    position: absolute;
    top: -0.7em;
    left: 0.6em;
    font-size: 0.65em;
    background: var(--fallback-b1, #fff);
    padding: 0 0.3em;
    color: rgba(0, 100, 200, 0.7);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .wysiwyg-surface :global(video),
  .wysiwyg-surface :global(audio) {
    margin: 0.6em 0;
  }

  /* T10 : visible badge for ODT fields. The user sees [date],
     [#], [$ClientName] etc. on a pale blue chip so they know
     they're editing a dynamic value, not literal text. */
  /* T11 Pages-mode layout. */
  .page-mode-wrap {
    padding: 1rem;
    background-image:
      linear-gradient(to right, rgba(0,0,0,0.04) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(0,0,0,0.04) 1px, transparent 1px);
    background-size: 1cm 1cm;
  }
  .ruler-h {
    position: sticky;
    top: 0;
    height: 1.4rem;
    margin-left: 2.5rem; /* matches the vertical ruler width below */
    background: white;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 2px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    position: relative;
    z-index: 2;
  }
  .ruler-h .tick {
    position: absolute;
    top: 0;
    width: 0;
    border-left: 1px solid rgba(0,0,0,0.4);
    height: 50%;
  }
  .ruler-h .tick.tick-major { height: 70%; border-left-color: rgba(0,0,0,0.6); }
  .ruler-h .tick.tick-margin { border-left-color: rgba(0,100,200,0.7); height: 100%; }
  .ruler-h .tick-label {
    position: absolute;
    top: 60%;
    left: 2px;
    font-size: 0.55rem;
    color: rgba(0,0,0,0.6);
    user-select: none;
  }
  .ruler-h .ruler-body {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(0, 130, 220, 0.06);
    border-left: 1px solid rgba(0, 100, 200, 0.4);
    border-right: 1px solid rgba(0, 100, 200, 0.4);
    z-index: -1;
  }
  .page-row {
    display: flex;
    align-items: flex-start;
    gap: 0;
    margin: 0.5rem 0 1rem;
  }
  .ruler-v {
    position: sticky;
    left: 0;
    width: 2.5rem;
    background: white;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 2px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    position: relative;
    z-index: 1;
  }
  .ruler-v .tick-v {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid rgba(0,0,0,0.4);
    height: 0;
  }
  .ruler-v .tick-v.tick-major { border-top-color: rgba(0,0,0,0.6); }
  .ruler-v .tick-v.tick-margin { border-top-color: rgba(0,100,200,0.7); }
  .ruler-v .tick-label-v {
    position: absolute;
    top: 1px;
    right: 2px;
    font-size: 0.55rem;
    color: rgba(0,0,0,0.6);
    user-select: none;
    writing-mode: horizontal-tb;
  }
  .ruler-v .ruler-body-v {
    position: absolute;
    left: 0;
    right: 0;
    background: rgba(0, 130, 220, 0.06);
    border-top: 1px solid rgba(0, 100, 200, 0.4);
    border-bottom: 1px solid rgba(0, 100, 200, 0.4);
    z-index: -1;
  }
  .page-paper {
    display: flex;
    flex-direction: column;
  }
  .page-paper-pages {
    background: white;
    color: #1a1a1a;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.06);
    margin-bottom: 1rem;
  }
  .page-paper-continuous {
    background: var(--fallback-b1, oklch(var(--b1)/1));
    flex: 1 1 auto;
    min-height: 100%;
  }
  /* Continuous mode : the editor fills the host pane edge-to-edge,
     no rulers, no page chrome — same UX the original {:else} branch
     produced before the {#if} was folded into a single tree. */
  .continuous-mode {
    background-image: none;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .page-row-continuous {
    margin: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
  }
  /* T10 V0.2 : header + footer editable bands. Subtle bottom-/top-
     border separates them visually from the body content. */
  .page-band {
    border-bottom: 1px dashed rgba(0, 100, 200, 0.2);
    font-size: 0.85em;
    color: rgba(0,0,0,0.65);
  }
  .page-footer {
    border-bottom: none;
    border-top: 1px dashed rgba(0, 100, 200, 0.2);
  }

  .wysiwyg-surface :global(span.odt-field) {
    background: rgba(0, 130, 220, 0.12);
    border: 1px solid rgba(0, 130, 220, 0.4);
    border-radius: 3px;
    padding: 0 0.25em;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.9em;
    color: #0466a3;
    cursor: default;
  }
</style>
