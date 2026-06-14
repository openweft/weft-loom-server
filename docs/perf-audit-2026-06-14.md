# Post-V0.8 perf re-audit — 2026-06-14

Audit dimension: **performance**. Re-run after V0.5/V0.6/V0.7/V0.8 history+comment work,
the lazy-bundle split (c6d82b4), and the audit-fix sweeps (4f2bed8 + c460db4).
HEAD: 6707ba9.

Each finding lists file:line, the cost shape, an adversarial check (re-read of the
source to confirm), a reproduction recipe, and a fix proposal. Findings are
"substantive" — measurable on a non-toy doc / keystroke loop. Stylistic nits
are out of scope.

---

## HIGH — confirmed regressions on hot paths

### H1. `console.log` in Yjs update hot path
- File: `web/src/lib/components/Editor.svelte:916-918`
- Shape: A `ydoc.on('update', …)` handler calls `console.log('[ydoc.update]', …)`
  on EVERY local keystroke and on every remote Yjs update.
- Adversarial check: Re-read confirms the handler is registered unconditionally
  in `onMount`, has no env gating, and no `if (DEBUG)` switch. The only nearby
  comment marks it as "DIAGNOSTIC" — diagnostic code that shipped.
- Repro: type into any file with DevTools open ; observe the console flooding +
  framerate dropping noticeably (~5-15 ms per keystroke spent in the dev-tools
  reflection bridge).
- Fix: gate behind `if (import.meta.env.DEV)` or a `localStorage.weftLoomVerbose`
  flag. The `__weftDebug.insert` console.log right below (line 930) is fine —
  it only fires when the debug API is invoked manually. The line-978
  `[flush-saves]` log only fires on Compile click — also fine.

### H2. `updateCursorStats` stringifies the entire document on every keystroke when no selection
- File: `web/src/lib/components/Editor.svelte:149-160` (and called from updateListener
  at line 716-728)
- Shape:
  ```ts
  const text = selLen > 0
    ? view.state.doc.sliceString(sel.from, sel.to)
    : view.state.doc.toString();          // ← O(N) string alloc per keystroke
  const words = text.split(/\s+/).filter(Boolean).length;  // ← O(N) regex split
  ```
  The "no selection" branch (cursor only) is the common case. On every
  `docChanged || selectionSet` we materialise the whole doc to a JS string +
  split it on whitespace.
- Adversarial check: re-read; the only branch that avoids `doc.toString()` is
  when there's an explicit non-empty selection. Caret moves with no selection
  still bench-mark the whole doc.
- Repro: open a 100 KB .tex / .md file ; hold an arrow key. Profile shows
  `String#split` and `Text#toString` dominating the keystroke budget.
- Fix: cache the word count off the y-text length + a debounced rescan,
  OR only recompute word count on a 250 ms debounce, OR derive from
  `view.state.doc.length` for character count and `view.state.doc.lines` for
  the line count without ever materialising a string. Surface "words: ~" if
  the doc is over a threshold.

### H3. `SpreadsheetEditor.recomputeDisplayCache` scans every cell of every sheet on every keystroke
- File: `web/src/lib/components/SpreadsheetEditor.svelte:642-657`, callers at
  629 (rebuildHF), 707 (setCell on formula entry), 730 (setCell on plain),
  and 320 (applyRemoteCell).
- Shape: Triple-nested loop `sheets.forEach → cells.forEach → row.forEach` over
  EVERY cell of EVERY sheet, calling `hf.getCellValue()` on each formula cell
  and rebuilding a fresh `Map`. Runs synchronously inside the keystroke loop
  every time a cell value changes (see `setCell` lines 731, 707) AND every time
  a remote update lands (line 320).
- Adversarial check: confirmed. There's no incremental-update path. HyperFormula
  exposes `setCellContents` which returns a list of changed addresses — that's
  the right hook for "rebuild only the dependents".
- Repro: load a .ods with a few hundred formulas across two sheets ; type into
  any cell. Keystroke latency grows linearly with `sum(rows * cols)` across
  workbook.
- Fix: take the `ExportedChange[]` `hf.setCellContents()` returns and update
  only the listed (sheet, row, col) entries in the existing Map. Drop the
  full-scan rebuild ; full scans only on initial load (`rebuildHF`).

### H4. Per-keystroke comment-anchor decode runs TWICE per Yjs tick
- Files:
  - `web/src/App.svelte:798-822` (editor-decoration rebuild)
  - `web/src/lib/components/CommentsPanel.svelte:81-99` (panel-list rebuild)
- Shape: BOTH locations register `ytext.observe(rebuild)` AND
  `arr.observeDeep(rebuild)`. Each rebuild walks every comment in
  `commentsArray(ydoc, file)`, calls `commentFromMap` (a `toJSON()`), then
  `resolveAnchors(ydoc, ytext, c)` which decodes two RelativePositions per
  comment.
- Adversarial check: confirmed. CommentsPanel comment line 92-97 even calls
  out the duplication ("observeDeep so nested Y.Map mutations bubble"), but it's
  observing the same data as App.svelte from a parallel path. With 50 comments
  open, every keystroke triggers 2 × 50 = 100 anchor decodes.
- Repro: open a file with 50+ comments ; type a character. Profile shows
  `Y.decodeRelativePosition` + `Y.createAbsolutePositionFromRelativePosition`
  back-to-back.
- Fix: consolidate. Make App.svelte own the resolved-ranges store ; expose
  via a Svelte store or window hook the CommentsPanel reads from. Same rebuild
  function feeds both consumers from a single ytext.observe debounced over a
  ~50 ms window.

### H5. `OutlinePanel` and `MetadataPanel` poll every 1.5 s even when collapsed/hidden
- Files:
  - `web/src/lib/components/OutlinePanel.svelte:284-290`
  - `web/src/lib/components/MetadataPanel.svelte:132-136`
- Shape: `setInterval(refresh, 1500)` set unconditionally in `onMount`. Each
  refresh does a `fetch(...)` with ETag (304 short-circuit OK on the network
  but the JS fetch+await+parse path still runs). When the file is `.odt`,
  `parseODT` (JSZip+DOMParser) runs FULLY because the function early-returns on
  304 but only AFTER the fetch ; subsequent ODT decoding only triggers when
  the etag differs.

  However when the panel is `collapsed`, the user can't see anything ; the
  refresh is pure overhead. Same when the parent's accordion has the panel
  un-mounted-but-not-visible (Svelte keeps it alive).
- Adversarial check: re-read. The collapsed branch in the template renders
  nothing (lines 338-341 / 210-213), but the script's `setInterval` keeps
  firing. There's no `if (!collapsed) refresh()` gate inside the poll.
- Repro: open the app, collapse Outline + Metadata. Network tab shows
  GET /api/projects/<p>/files/<f> every 1.5 s indefinitely.
- Fix: gate the polling on `!collapsed && visible`. Use a `$effect` that
  starts/stops the interval based on the collapsed prop. Bonus: poll only
  when the doc has a viable `langForFile` — empty `entries` does the same.

### H6. `bibStore` re-fetches and re-parses ALL .bib files every 5 s, no ETag
- File: `web/src/lib/bibStore.svelte.ts:30, 38-65`
- Shape: `setInterval(() => this.refresh(), 5000)` triggered once Editor mounts.
  `refresh()` calls `listFiles` then for EACH .bib file, fetches the body
  (no `If-None-Match`), `parseBib`s it, and rebuilds the `byKey` Map. Even when
  nothing changed.
- Adversarial check: confirmed. No etag tracking. The store is started from
  every Editor mount (`bib.start()` at line 888 of Editor.svelte). Multiple
  editors mount → still one store (singleton), but a project with N .bib files
  pays N HTTP requests + N parse calls every 5 s.
- Repro: open a project with 5+ large .bib files. Network tab shows the same
  files being re-downloaded every 5 s.
- Fix: store etag per .bib path ; pass `If-None-Match` ; skip parse on 304.
  Better still: switch to the file-mtime endpoint or NATS subject so the store
  only refreshes on actual change events. For dev parity, keep poll as
  fallback at 30 s.

### H7. NotebookEditor renders all markdown cells on every keystroke in any cell
- File: `web/src/lib/components/NotebookEditor.svelte:133-135, 317`
- Shape: `renderMarkdown(cell.source)` is called inline in `{@html …}` for
  every markdown cell. The function chains `marked.parse(...)` + `DOMPurify.sanitize(...)`.
  When the user types in cell K, `scheduleSave()` calls `dirty = true` but the
  reactivity also fires for `nb.cells` (Svelte sees a state read in the template
  via `nb.cells`) — and crucially because the array reassignment via
  `nb.cells = [...]` (lines 184, 195, 209, 215, 226) replaces the cells array
  reference, every {@each} item is re-evaluated.

  Each markdown cell pays the marked+DOMPurify cost on every notebook mutation,
  even unrelated ones.
- Adversarial check: re-read. `renderMarkdown` is not memoised. The template
  uses `{@html renderMarkdown(cell.source)}` directly. With a 30-cell notebook
  containing 20 markdown cells, typing in cell 5 still re-renders all 20.
- Repro: open a notebook with 20+ markdown cells, type in any code cell.
  Profile shows `marked.parse` dominating.
- Fix: precompute `renderedMarkdown` as a `$derived` map keyed by cell.source ;
  Svelte reactivity will only recompute entries whose source actually changed.
  Or wrap into a memoised function: `const renderCache = new Map<string,string>()`
  with LRU eviction.

### H8. `sectionFolding.foldFor` rescans the entire document on every fold-gutter query
- File: `web/src/lib/sectionFolding.ts:57-83` (and `scanHeadings` 31-55)
- Shape: CodeMirror calls `foldService.of(...)` once per line that might be
  foldable. Inside, `foldFor` calls `scanHeadings(state, isLatex)` which walks
  the FULL document from line 1 to `doc.lines`. So on a 5000-line LaTeX doc
  with 80 headings, every gutter render does ~80 × full-document scans.
- Adversarial check: re-read. `scanHeadings` has no memoisation. The whole-
  document scan happens on every individual fold query. The comment in the
  file's header brags about Overleaf parity but doesn't mention this.
- Repro: scroll a 5000-line .tex file with 80 \section commands ; observe
  the gutter render is the bottleneck on every scroll.
- Fix: cache `scanHeadings` keyed by `state.doc` (Yjs Y.Text's identity will
  do — a WeakMap<Tree | Doc, Heading[]>). Invalidate on docChanged via a
  small ViewPlugin holding the cached list ; expose to foldService through
  a StateField.

### H9. `authorshipExtension` walks the full Y.Text item chain on every keystroke + does a no-op view.dispatch
- File: `web/src/lib/authorship.ts:74-145`
- Shape: When revisionMode is on, `ytext.observe(refresh)` AND
  `update.docChanged` both fire `this.build(view)` on every keystroke.
  `build` walks `(ytext as any)._start` linked list end-to-end, building a
  fresh `RangeSetBuilder`. Then `refresh` issues `view.dispatch({})` — a
  no-op transaction that ANOTHER full re-render cycle inside CodeMirror.
- Adversarial check: confirmed. Lines 83-86 + 130-139. The double-trigger
  (observe + docChanged) is the comment that says "doc changed for some
  reason that bypassed yjs ; refresh defensively" — but local CM edits go
  through ytext.observe via ybinding, so the second path almost always
  fires for the same change.
- Repro: enable Revision Mode in a long .tex with many authored ranges ;
  type. Two builds per keystroke.
- Fix: drop the `update.docChanged` branch (ytext.observe already covers all
  ytext mutations including local ones via ybinding). Remove the
  `view.dispatch({})` no-op — `ViewPlugin.fromClass` already re-renders when
  decorations is reassigned (it's the `provide` contract).

---

## MEDIUM — measurable on common workflows

### M1. `inlineMathRender` re-rasterises every visible KaTeX widget on every keystroke
- File: `web/src/lib/inlineMathRender.ts:87-127`
- Shape: `update()` calls `buildDecorations(u.view)` on `docChanged ||
  selectionSet || viewportChanged`. Each call constructs fresh `MathWidget`
  instances and re-runs `katex.renderToString` per widget on `toDOM`.
  `WidgetType.eq` IS implemented and CodeMirror dedups via it — but
  `selectionSet`-triggered rebuilds still allocate new Widgets and the
  ranges through `RangeSetBuilder` even when nothing about the math segments
  changed.
- Adversarial check: re-read. Only `selectionSet` triggers per arrow-key tap.
  When the cursor is well outside any math segment, the resulting decoration
  set is identical to the previous — but the rebuild still walks
  `view.visibleRanges` + runs the math regex.
- Repro: open a LaTeX file with many `$…$` segments ; hold an arrow key
  walking through pure prose. Profiling shows `scanMath` + RangeSetBuilder
  churn per arrow-press.
- Fix: short-circuit when `selectionSet` is the only change AND the previous
  selection's `cursorInside` set hasn't changed (the only state caret movement
  affects). Cache `scanMath` results per (viewport_from, viewport_to,
  doc_version).

### M2. PreviewPane re-renders KaTeX/marked for every text change in source
- File: `web/src/lib/components/PreviewPane.svelte:263-275`
- Shape: 100 ms debounce ; on each fire, `render(src)` runs the full
  marked+KaTeX+highlight.js+DOMPurify pipeline against the whole document
  text. No incremental support.
- Adversarial check: confirmed. The debounce keeps it at 10 Hz. With a 200 KB
  markdown file containing many code fences, each tick can take 200-500 ms,
  causing the user to feel lag while typing — the spinner overlay (lines
  416-432) is the visible symptom.
- Repro: open a long markdown file with many fenced blocks ; type ; preview
  flicker + spinner overlay every ~100 ms.
- Fix: lift the debounce to 250-400 ms; chunk markdown rendering using
  `requestIdleCallback` per slide / section; or memoise the marked output
  per stable hash of the source.

### M3. SpreadsheetEditor seed phase opens N nested Yjs transactions
- File: `web/src/lib/components/SpreadsheetEditor.svelte:476-484, 268-280`
- Shape: During `pushShape() / seed`, the code calls
  `sheets.forEach (sh, si) => sh.cells.forEach (row, r) => row.forEach (cell, c) => pushCellToYMap(si, r, c)`.
  `pushCellToYMap` opens its OWN `ydoc.transact(() => …, 'ods-cell')` per cell.
  With 100x100 = 10,000 cells, that's 10,000 nested transactions. Although the
  outer `ydoc.transact(..., 'ods-seed')` wraps them, nested transacts still
  pay per-call overhead and emit per-tx update messages on the wire.
- Adversarial check: confirmed. The outer `ydoc.transact(..., 'ods-seed')` does
  group them, but each `pushCellToYMap` re-enters `ydoc.transact` with origin
  `'ods-cell'`. The observer in cellsMap.observe (line 491) checks for both
  origins to skip — so semantics are OK — but the throughput is wasted.
- Repro: open a freshly-loaded .ods with 5000+ non-empty cells ; first seed
  takes seconds because of per-cell transact overhead.
- Fix: inline the `cellsMap!.set(...)` calls directly inside the outer
  `ydoc.transact(..., 'ods-seed')` block — no inner transacts. Same for
  `applyRemoteCell` batching during initial sync replay (line 450-451 + 469).

### M4. NotebookPreview polls every 1.5 s regardless of whether the preview pane is visible
- File: `web/src/lib/components/NotebookPreview.svelte:63-66`
- Shape: Identical pattern to OutlinePanel : `setInterval(load, 1500)` started
  in `onMount`, no visibility / mount-state gate. Even when the user closes
  the PreviewPane (`onClose`), if NotebookPreview was rendered for an
  .ipynb, the poll continues until the component unmounts (PreviewPane
  destroys its child only when the {#if} flips, which depends on the parent).
- Adversarial check: re-read PreviewPane.svelte — line 301 `{#if isNotebook
  && project && file}` does unmount NotebookPreview when `isNotebook`
  flips false. But within a notebook session, the poll runs even if the user
  is editing the NotebookEditor on the LEFT half (server is its own source
  of truth via the file API, so this double-fetch is wasted).
- Repro: edit cells in NotebookEditor with PreviewPane open ; NotebookPreview
  re-fetches the file every 1.5 s in parallel.
- Fix: leverage the NotebookEditor's own state instead. Either share via
  a Svelte store, or `weft-loom-notebook-changed` window event NotebookEditor
  dispatches on every save, with NotebookPreview re-rendering only on that
  signal. Drop the timer altogether.

### M5. `WysiwygEditor` ODT save serialises the entire document via JSZip on every 600 ms debounce
- File: `web/src/lib/components/WysiwygEditor.svelte:138-192, 197`
- Shape: `onInput` resets a 600 ms timer ; on fire, `save()` calls
  `await writeODT(editorEl.innerHTML, ...)` which zips the entire document
  back into the ODF container. For a multi-page document this is expensive
  (~50-200 ms) and runs on the main thread, eating into the next keystroke
  budget.
- Adversarial check: confirmed. writeODT is async because of JSZip's
  `generateAsync` but the body work (XML build) is sync. No structural
  diff — every save rebuilds the full content.xml, manifest.xml, styles.xml.
- Repro: open a 20-page .odt ; type continuously. After 600 ms idle the
  save spikes the main thread.
- Fix: move ODT serialisation to a Worker. The file already wires a
  module-style entry — split the writeODT into a worker. As a minimum,
  bump the debounce to 1.5-2 s when the doc is over a size threshold so
  the user doesn't pay the spike between every keystroke pause.

### M6. `GitSidebar.refresh()` runs every 15 s with no ETag on git/status
- File: `web/src/lib/components/GitSidebar.svelte:73-91`
  (plus `FileExplorer.svelte:46-69` for the parallel poll)
- Shape: Two independent 15 s pollers BOTH hit `/api/projects/<p>/git/status`.
  No ETag, no conditional request, no de-dup between the two pollers.
  FileExplorer reads the same data for its file-status badges ; GitSidebar
  reads it for the ahead/behind / changes list.
- Adversarial check: confirmed by grep across components. Same endpoint,
  different setIntervals.
- Repro: any project that has git enabled ; network tab shows two GETs to
  /git/status every 15 s.
- Fix: consolidate behind a single shared `gitStatusStore.svelte.ts` (mirror
  of bibStore). Both consumers subscribe ; one poller fans out.

---

## LOW — micro-optimisations / latent issues

### L1. `compileDiagnostics.items.length` effect rebuilds the lint extension on every diagnostic mutation
- File: `web/src/lib/components/Editor.svelte:238-244`
- Shape: `void compileDiagnostics.items.length` reads the reactive length ;
  every diagnostic push (a typical compile produces 30-50 items) triggers
  the effect, which dispatches a `lintCompartment.reconfigure(...)` —
  forcing CodeMirror to re-run the linter pipeline. Compiles batch
  diagnostics but a streaming pipeline could push them one at a time.
- Repro: trigger a noisy LaTeX compile ; the lint compartment reconfigures
  per diagnostic.
- Fix: subscribe to `compileDiagnostics.lastBatch` or version number that
  bumps once per compile, not once per item.

### L2. `latexRichText.buildDecorations` rebuilds on every `selectionSet` even when caret-overlap classification doesn't change
- File: `web/src/lib/latexRichText.ts:649-668`
- Shape: Active only when revisionMode-style richTextEnabled toggle is on
  (default off). Still: pure caret movement (arrow keys) outside any
  command range causes a full visible-range rebuild because the plugin
  blindly rebuilds on `u.selectionSet`.
- Fix: track the last selection ; bail if the new selection's "inside any
  rich-text range" predicate evaluates the same as before.

### L3. `WysiwygEditor` and `SpreadsheetEditor` setInterval(30s) for `nowTick` keep ticking even when the doc is clean
- File: `web/src/lib/components/WysiwygEditor.svelte:213, SpreadsheetEditor.svelte:966`
- Shape: `nowTick = Date.now()` interval used purely to refresh "il y a Ns"
  label. Runs unconditionally for the lifetime of the component.
- Fix: only tick while `savedAt` is set AND was within the last hour. Stop
  the interval beyond that — the relative time becomes "à HH:MM" which is
  static.

### L4. ResizeObserver in SpreadsheetEditor reconnects on every $effect re-run
- File: `web/src/lib/components/SpreadsheetEditor.svelte:207-218`
- Shape: The `$effect` reads `scrollEl` and unconditionally
  `resizeObs?.disconnect()` + creates a fresh `new ResizeObserver(...)` each
  invocation. On hot-reload-style remounts this leaks observer instances.
  Less severe than it looks because the cleanup function disconnects, but
  the re-creation per effect run is wasteful when the only dep is `scrollEl`
  identity.
- Fix: guard with `if (resizeObs)` once `scrollEl` is stable. Or memoise
  by `scrollEl` reference.

---

## Summary

- **9 HIGH** confirmed perf hotspots — all touchable on a typical loom session
  (typing in an editor, opening a notebook, editing a spreadsheet, working
  with comments).
- **6 MEDIUM** with measurable cost on representative workloads.
- **4 LOW** micro-optimisations.

The V0.5-V0.8 history+comment feature work introduced **H4** (duplicate
comment-anchor decoders). The earlier audit-fix sweeps closed the leaky-listener
class but left the "always rebuild" hot paths in place. The lazy-bundle split
(c6d82b4) addressed code-load latency but not steady-state typing cost.

Recommended priority order for V0.9 perf sprint:
1. H1 (one-line gate ; trivial)
2. H4 (dedup the comment-anchor observer wiring)
3. H3 (incremental display cache via HyperFormula's changes array)
4. H2 (drop the full-doc word count from the keystroke loop)
5. H5 + M4 (gate polls on visibility)
6. H6 (etag + share gitStatusStore)
7. H7 (memoise markdown rendering per cell)
8. H8 (cache scanHeadings)
9. H9 (drop the duplicate trigger in authorshipExtension)
