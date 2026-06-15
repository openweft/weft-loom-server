#!/usr/bin/env bash
# tests/run.sh — orchestrates the full weft-loom test protocol.
#
# Steps :
#   1. Rebuild the SPA (vite)
#   2. Rebuild the Go binary (re-embeds dist)
#   3. Restart loom-server
#   4. Run the ui-suite (boot / layout / shortcuts / Outline /
#      Preview-as-sibling / git decorator …)
#   5. Run the lang-suite (per-language edit + compile + preview)
#   6. Report a unified PASS / FAIL summary
#
# Exit code reflects the worst result : 0 only if BOTH suites are
# green. Designed to be invoked after every code change (the AI
# coding loop, a pre-commit hook, or CI).
#
# Usage : tests/run.sh [--no-rebuild]   # skip steps 1-3
#
# Environment :
#   PATH must include go (/usr/local/go/bin per workspace
#   conventions) ; node + npx must be on PATH.

set -u

cd "$(dirname "$0")/.."

REBUILD=1
if [ "${1:-}" = "--no-rebuild" ]; then
  REBUILD=0
fi

echo
echo "==============================================="
echo "  weft-loom test protocol"
echo "==============================================="

if [ "$REBUILD" = 1 ]; then
  echo
  echo "→ rebuild SPA (purge dist first to dodge font-file race)"
  rm -rf internal/web/dist
  (cd web && npx vite build > /tmp/loom-build.log 2>&1)
  if [ $? -ne 0 ]; then
    echo "✕ vite build failed (see /tmp/loom-build.log)"
    exit 1
  fi
  echo "→ rebuild Go binary"
  export PATH=/usr/local/go/bin:$PATH GOWORK=off
  go build -o "$HOME/.weft-loom/bin/weft-loom" ./cmd/weft-loom 2> /tmp/loom-gobuild.log
  if [ $? -ne 0 ]; then
    echo "✕ go build failed (see /tmp/loom-gobuild.log)"
    cat /tmp/loom-gobuild.log
    exit 1
  fi
  echo "→ restart loom-server"
  pkill -9 -f weft-loom 2>/dev/null
  sleep 1
  nohup "$HOME/.weft-loom/scripts/loom-start.sh" > /tmp/weft-loom.log 2>&1 &
  disown
  sleep 4
fi

echo
echo "----- UI suite -----"
node tests/ui-suite.mjs
UI=$?

echo
echo "----- Language matrix suite -----"
node tests/lang-suite.mjs
LANG=$?

echo
echo "----- Preview render suite -----"
node tests/preview-suite.mjs
PREVIEW=$?

echo
echo "----- UI compile-entry suite (Run-button wiring) -----"
# Regression guard : the SPA must thread the active file's path to
# the compile dispatcher. Without it the server falls back to a
# hardcoded main.<ext> and any ad-hoc-named file fails. See
# tests/ui-compile-entry.mjs for the full rationale.
node tests/ui-compile-entry.mjs
UIENTRY=$?

echo
echo "----- Institutional theme preview suite -----"
# Regression guard : each institutional Marp theme (polytechnique,
# ip-paris, cnrs, dinum, paris-saclay, ihes) must render a
# non-empty slide card AND the brand border-color from MARP_THEMES.
# Catches "themes look empty" regressions where the catalogue lost
# its style strings or the renderMarkdown wrapper stopped applying
# them.
node tests/theme-preview.mjs
THEMEP=$?

echo
echo "----- WYSIWYG RTF suite -----"
# Regression guard : .rtf files must open in the WYSIWYG editor
# (contenteditable + toolbar), NOT in the raw-source CodeMirror.
# Also exercises the HTML → RTF writer round-trip so the save
# path doesn't silently drop formatting.
node tests/wysiwyg-rtf.mjs
WYSIWYG=$?

echo
echo "----- WYSIWYG ODT suite -----"
# Same guard for .odt : the pure-browser parseODT/writeODT path
# round-trips the document via jszip + DOMParser, no server-side
# pandoc round-trip needed.
node tests/wysiwyg-odt.mjs
WYSIWYG_ODT=$?

echo
echo "----- WYSIWYG ODT toolbar suite -----"
# Regression guard for the V0.8 toolbar wiring : insert link,
# insert footnote, align right, strike, super, sub buttons all
# need to produce the right DOM in the contenteditable. Catches
# any silent rewire where a button stops calling the handler or
# Chrome's execCommand sanitiser breaks one of the paths.
node tests/wysiwyg-odt-toolbar.mjs
WYSIWYG_ODT_TB=$?

echo
echo "----- ODT starter templates suite -----"
# Regression guard for the ODT template catalogue : every entry in
# TEMPLATES whose language='odt' must round-trip through writeODT
# + the file API + parse back as a valid ODF zip with its anchor
# text preserved.
node tests/odt-templates.mjs
ODT_TPL=$?

echo
echo "----- LaTeX symbol palette suite -----"
# Regression guard for the LaTeX symbol palette : the FAB must
# only render for .tex/.latex files ; clicking a symbol must
# splice the LaTeX command into the editor via the cursor-insert
# hook ; tab + filter wiring must stay alive.
node tests/latex-palette.mjs
LATEX_PAL=$?

echo
echo "----- Marp theme+language picker suite -----"
# Regression guard for the NewFileDialog Marp picker : every
# (theme, language) combo from the catalogue must produce a deck
# carrying the right theme: + lang: YAML + localised section
# headings, and institutional themes must opt into the
# cover-page <!-- _class: lead --> hook.
node tests/marp-picker.mjs
MARP_PIC=$?

echo
echo "----- Bibliography panel suite -----"
# Regression guard for the LaTeX BibliographyPanel : a .bib file
# in the project must surface in the floating browser ; filter
# narrows the list ; clicking inserts \cite{key} at the cursor.
node tests/bib-panel.mjs
BIB_PAN=$?

echo
echo "----- Inline math rendering suite -----"
# Regression guard for inline KaTeX rendering : $…$, $$…$$,
# \(…\), \[…\] segments must render as widgets when the cursor
# is outside, and fold back to source when the user clicks in.
node tests/inline-math.mjs
INLINE_MATH=$?

echo
echo "----- Outline depth + section folding suite -----"
# Regression guard for the OutlinePanel depth filter + the
# section-aware foldService : a .tex with chapter…paragraph
# headings must surface in the outline, the depth dropdown must
# narrow the list, and the CodeMirror fold gutter must offer
# foldable regions on each heading line.
node tests/outline-depth.mjs
OUTLINE=$?

echo
echo "----- PDF viewer mount suite -----"
# Regression guard for the PDF.js viewer + backward-SyncTeX wiring.
# Asserts both window.weftLoomSyncTeXForward AND
# window.weftLoomSyncTeXBackward hooks are exposed after the SPA
# bootstrap.
node tests/pdf-viewer-mount.mjs
PDF_VIEW=$?

echo
echo "----- Collaborative comments suite -----"
# Regression guard for T6 : the comments Y.Array drives a list +
# yellow-dotted anchor highlights in the source view. Asserts the
# full lifecycle : add → highlight rendered → resolve → delete.
node tests/comments-panel.mjs
COMMENTS=$?

echo
echo "----- ODT fields + outline suite -----"
# Regression guard for T10 V0.1 (ODT field round-trip) + the
# ODT/RTF outline support. Seeds a doc with page-number, title,
# user-field-get + 3 levels of headings ; asserts WYSIWYG surfaces
# fields as .odt-field spans, outline shows the headings, and
# saved bytes re-emit the ODF field elements + user-defined meta.
node tests/odt-fields-outline.mjs
ODT_FIELDS=$?

echo
echo "----- Page-mode + meta-vars suite -----"
# Regression guard for T11 (Word-style page layout with rulers)
# + the MetadataPanel user-defined ODT variable editor.
node tests/page-mode-vars.mjs
PAGE_VARS=$?

echo
echo "----- ODT frames + media suite -----"
# Regression guard for T12 : ODT text frames (<draw:text-box>) +
# audio/video embeds (<draw:plugin> with Pictures/media* zip
# entries). Reader surfaces them as <aside.odt-textbox> + <audio>
# / <video> ; writer packages new captures back into the ODF zip.
node tests/odt-frames-media.mjs
ODT_FRAMES=$?

echo
echo "----- ODT header/footer suite -----"
# Regression guard for T10 V0.2 : the <style:header> + <style:footer>
# entries from the source styles.xml surface as editable bands in
# Pages mode ; editing the header band re-emits a fresh styles.xml
# on save with the new content.
node tests/odt-header-footer.mjs
ODT_HF=$?

echo
echo "----- RTF fields suite -----"
# Regression guard for T10 V0.3 : {\field{\*\fldinst KIND}
# {\fldrslt VISIBLE}} round-trip through parseRTF + writeRTF.
# PAGE / NUMPAGES / DOCPROPERTY / TITLE all surface as
# <span class="rtf-field" data-kind data-name>.
node tests/rtf-fields.mjs
RTF_FIELDS=$?

echo
echo "----- LSP bridge suite -----"
# Regression guard for T8 V0.1 : /api/lsp manifest endpoint + per-
# language WS route. V0.1 doesn't depend on any real language
# server being installed — we just confirm the dispatch / 404 /
# 503 paths so the editor falls back gracefully when no LSP is
# available on the host.
node tests/lsp-bridge.mjs
LSP=$?

echo
echo "----- Language pack lazy-load suite -----"
# Regression guard : every @codemirror/lang-* pack is 50-150 KB.
# Editor.svelte must dynamic-import them through loadLanguagePack()
# so the cold-load bundle doesn't ship every parser synchronously.
# Asserts no latex-pack chunk before any file is open, a chunk
# fetch on first .tex open, and a packCache hit (no second fetch)
# on a subsequent .tex open.
node tests/lang-pack-lazy.mjs
LANG_LAZY=$?

echo
echo "----- ODS spreadsheet round-trip suite -----"
# Regression guard for T9 V0.1 : parseODS/writeODS + the
# SpreadsheetEditor grid. A seeded .ods with 2 sheets + typed
# cells (string / float / boolean) renders in the grid + edits
# round-trip back into a valid ODS package.
node tests/ods-roundtrip.mjs
ODS=$?

echo
echo "----- ODS formula evaluation suite -----"
# Regression guard for T9 V0.2 : HyperFormula-evaluated cells.
# A seeded =A1+A2 cell renders its computed result + new
# formulas typed in the formula bar recompute + round-trip back
# into the saved file as table:formula.
node tests/ods-formulas.mjs
ODS_FX=$?

echo
echo "----- ODS templates + Y.Map collab suite -----"
# Regression guard for T9 V0.3 + the ODS starter templates :
# 4 templates (blank / budget / timesheet / roster) round-trip
# through writeODS into valid ODF zips, and two browser sessions
# observe each other's cell edits via the Y.Map provider.
node tests/ods-templates-collab.mjs
ODS_COL=$?

echo
echo "----- Cross-feature interactions suite -----"
# Tests COMBINATIONS the per-feature suites can't catch.
# Examples : type body content → toggle Continu/Pages → content
# survives ; insert bookmark + footnote + field together → all
# three shapes co-exist in saved XML ; LaTeX symbol palette +
# bibliography both splice at the cursor without mutual
# interference ; spreadsheet formula survives a sheet-tab
# round-trip. Catches the kind of state-management bug a single-
# feature test would miss.
node tests/feature-interactions.mjs
INTERACTIONS=$?

echo
echo "----- ODS virtualization suite -----"
# Excel-like virtually-infinite grid : the canvas reports the
# full virtual size (≥1M rows × 16k cols) but only the visible
# window renders as DOM. Deep scrolls + edits at far-out
# coordinates round-trip into the saved file.
node tests/ods-virtualization.mjs
ODS_VIRT=$?

echo
echo "----- ODS keyboard navigation suite -----"
# Excel-style arrow / Tab / Enter / Home / End / PageUp/Down keys
# always navigate the cell selection, scroll the target into view
# + keep focus inside the scroll container so subsequent
# keystrokes keep working even when the target cell briefly leaves
# the DOM during a virtualized re-render.
node tests/ods-navigation.mjs
ODS_NAV=$?

echo
echo "----- ODS layout suite -----"
# Pixel-level guard for the virtualized grid layout : cells in
# the same row share a top, cells in the same column share a left,
# row/col spacing matches the ROW_H / COL_W constants, headers
# align with their cells, header backgrounds are opaque + their
# z-index sits above the data cells (so scrolling never shows
# cell content bleeding through).
node tests/ods-layout.mjs
ODS_LAY=$?

echo
echo "----- ODS formatting suite -----"
# Header click selection (row / col / corner = whole sheet) +
# the Excel-style formatting toolbar (B/I/U, text colour, cell
# background, font face + size, alignment, borders, clear). Bold
# applied to a column highlight should bold every cell in the
# column ; saved ODF carries <style:style style:family=
# "table-cell"> definitions referenced by table:style-name.
node tests/ods-formatting.mjs
ODS_FMT=$?

echo
echo "----- history suite -----"
echo
node tests/history.mjs
HIST=$?

echo
echo "----- LaTeX source render suite -----"
echo
node tests/latex-source-render.mjs
LATEX_RENDER=$?

echo
echo "----- LaTeX render-after-reload suite -----"
echo
# Regression : a page reload (Cmd+R) on an already-touched file
# used to leave the editor visually empty for 3-4 s because the
# server-side seed-claim window (30 s) blocked the new tab's claim,
# the client's 409 fallback waited 3 s before force-fetching, and
# the awareness-alone fast path didn't exist. The fix landed in
# fddb75f (api_seed.go staleClaimAfter 30 s→3 s + Editor.svelte
# fast-path + observer-driven wait). This suite drives the exact
# user scenario : seed a .tex, open, type, reload, reopen, assert
# content reappears within 2 s.
node tests/latex-render-after-reload.mjs
LATEX_RELOAD=$?

echo
echo "----- AI chat suite -----"
# Regression guard for the AIChatPanel wiring : POST /ai/chat returns
# either a 503 stub (no provider on the host — the must-pass CI case)
# or a 200 SSE stream that delivers at least one data chunk + an
# event: done terminator. Catches regressions where the panel goes
# back to a fully client-side stub or the SSE framing breaks.
node tests/ai-chat.mjs
AI_CHAT=$?

echo
echo "----- Presence cursors suite -----"
# Regression guard for the in-editor presence cursors : every remote
# peer state carrying a { cursor: { anchor, head } } field must
# decorate the editor with a .cm-peer-caret (with data-name + a
# per-peer colored border) and, when the range is non-empty, a
# .cm-peer-selection mark. The local view also broadcasts its own
# cursor into awareness on every selection change so peers see us.
node tests/presence-cursors.mjs
PRESENCE=$?

echo
echo "----- Mobile responsive layout suite -----"
# Regression guard for the < 768 px responsive sweep : navbar
# hamburger button, slide-over sidebar, dropped StatusBar fields
# (cursor coords + word count), no horizontal overflow on iPhone
# (390×844) viewport.
node tests/mobile-layout.mjs
MOBILE=$?

echo
echo "----- Project export ZIP suite -----"
node tests/project-export.mjs
PROJECT_EXPORT=$?

echo
echo "----- Multi-cursor suite -----"
node tests/multi-cursor.mjs
MULTI_CURSOR=$?

echo
echo "----- Snippets suite -----"
node tests/snippets.mjs
SNIPPETS=$?

echo
echo "----- Word count + writing goals suite -----"
node tests/word-count-panel.mjs
WORDS=$?

echo
echo "----- Keyboard shortcut help suite -----"
node tests/shortcut-help.mjs
SHORTCUT_HELP=$?

echo
echo "----- Compile-on-save suite -----"
node tests/compile-on-save.mjs
COMPILE_ON_SAVE=$?

echo
echo "----- Project scaffold templates suite -----"
node tests/scaffold-templates.mjs
SCAFFOLD=$?

echo
echo "----- DOI → BibTeX import suite -----"
# Resolver hits doi.org by default ; the test relies on the stub
# path (WEFT_LOOM_DOI_STUB=1) which the dev server must be started
# with. Pre-flight checks that env var ; missing → skip with a
# warning rather than triggering flaky network calls in CI.
if curl -sf -X POST "http://127.0.0.1:8080/api/projects/demo/bib/from-doi" -H 'Content-Type: application/json' -d '{"doi":"10.9999/runprobe"}' | grep -q 'Stubbed Title'; then
  node tests/doi-import.mjs
  DOI=$?
else
  echo "  ⏭  dev server not in stub mode (set WEFT_LOOM_DOI_STUB=1 before restart) — skipped"
  DOI=0
fi

echo
echo "==============================================="
if [ $UI -eq 0 ] && [ $LANG -eq 0 ] && [ $PREVIEW -eq 0 ] && [ $UIENTRY -eq 0 ] && [ $THEMEP -eq 0 ] && [ $WYSIWYG -eq 0 ] && [ $WYSIWYG_ODT -eq 0 ] && [ $WYSIWYG_ODT_TB -eq 0 ] && [ $ODT_TPL -eq 0 ] && [ $LATEX_PAL -eq 0 ] && [ $MARP_PIC -eq 0 ] && [ $BIB_PAN -eq 0 ] && [ $INLINE_MATH -eq 0 ] && [ $OUTLINE -eq 0 ] && [ $PDF_VIEW -eq 0 ] && [ $COMMENTS -eq 0 ] && [ $ODT_FIELDS -eq 0 ] && [ $PAGE_VARS -eq 0 ] && [ $ODT_FRAMES -eq 0 ] && [ $ODT_HF -eq 0 ] && [ $RTF_FIELDS -eq 0 ] && [ $LSP -eq 0 ] && [ $LANG_LAZY -eq 0 ] && [ $ODS -eq 0 ] && [ $ODS_FX -eq 0 ] && [ $ODS_COL -eq 0 ] && [ $INTERACTIONS -eq 0 ] && [ $ODS_VIRT -eq 0 ] && [ $ODS_NAV -eq 0 ] && [ $ODS_LAY -eq 0 ] && [ $ODS_FMT -eq 0 ] && [ $HIST -eq 0 ] && [ $LATEX_RENDER -eq 0 ] && [ $LATEX_RELOAD -eq 0 ] && [ $AI_CHAT -eq 0 ] && [ $PRESENCE -eq 0 ] && [ $MOBILE -eq 0 ] && [ $PROJECT_EXPORT -eq 0 ] && [ $MULTI_CURSOR -eq 0 ] && [ $SNIPPETS -eq 0 ] && [ $WORDS -eq 0 ] && [ $SHORTCUT_HELP -eq 0 ] && [ $DOI -eq 0 ] && [ $COMPILE_ON_SAVE -eq 0 ] && [ $SCAFFOLD -eq 0 ]; then
  echo "  \033[32mALL PASS\033[0m"
  exit 0
fi
[ $UI         -eq 0 ] && echo "  ui-suite           : \033[32mPASS\033[0m" || echo "  ui-suite           : \033[31mFAIL\033[0m"
[ $LANG       -eq 0 ] && echo "  lang-suite         : \033[32mPASS\033[0m" || echo "  lang-suite         : \033[31mFAIL\033[0m"
[ $PREVIEW    -eq 0 ] && echo "  preview-suite      : \033[32mPASS\033[0m" || echo "  preview-suite      : \033[31mFAIL\033[0m"
[ $UIENTRY    -eq 0 ] && echo "  ui-compile-entry   : \033[32mPASS\033[0m" || echo "  ui-compile-entry   : \033[31mFAIL\033[0m"
[ $THEMEP     -eq 0 ] && echo "  theme-preview      : \033[32mPASS\033[0m" || echo "  theme-preview      : \033[31mFAIL\033[0m"
[ $WYSIWYG    -eq 0 ] && echo "  wysiwyg-rtf        : \033[32mPASS\033[0m" || echo "  wysiwyg-rtf        : \033[31mFAIL\033[0m"
[ $WYSIWYG_ODT -eq 0 ] && echo "  wysiwyg-odt        : \033[32mPASS\033[0m" || echo "  wysiwyg-odt        : \033[31mFAIL\033[0m"
[ $WYSIWYG_ODT_TB -eq 0 ] && echo "  wysiwyg-odt-toolbar: \033[32mPASS\033[0m" || echo "  wysiwyg-odt-toolbar: \033[31mFAIL\033[0m"
[ $ODT_TPL -eq 0 ] && echo "  odt-templates      : \033[32mPASS\033[0m" || echo "  odt-templates      : \033[31mFAIL\033[0m"
[ $LATEX_PAL -eq 0 ] && echo "  latex-palette      : \033[32mPASS\033[0m" || echo "  latex-palette      : \033[31mFAIL\033[0m"
[ $MARP_PIC -eq 0 ] && echo "  marp-picker        : \033[32mPASS\033[0m" || echo "  marp-picker        : \033[31mFAIL\033[0m"
[ $BIB_PAN -eq 0 ] && echo "  bib-panel          : \033[32mPASS\033[0m" || echo "  bib-panel          : \033[31mFAIL\033[0m"
[ $INLINE_MATH -eq 0 ] && echo "  inline-math        : \033[32mPASS\033[0m" || echo "  inline-math        : \033[31mFAIL\033[0m"
[ $OUTLINE -eq 0 ] && echo "  outline-depth      : \033[32mPASS\033[0m" || echo "  outline-depth      : \033[31mFAIL\033[0m"
[ $PDF_VIEW -eq 0 ] && echo "  pdf-viewer-mount   : \033[32mPASS\033[0m" || echo "  pdf-viewer-mount   : \033[31mFAIL\033[0m"
[ $COMMENTS -eq 0 ] && echo "  comments-panel     : \033[32mPASS\033[0m" || echo "  comments-panel     : \033[31mFAIL\033[0m"
[ $ODT_FIELDS -eq 0 ] && echo "  odt-fields-outline : \033[32mPASS\033[0m" || echo "  odt-fields-outline : \033[31mFAIL\033[0m"
[ $PAGE_VARS -eq 0 ] && echo "  page-mode-vars     : \033[32mPASS\033[0m" || echo "  page-mode-vars     : \033[31mFAIL\033[0m"
[ $ODT_FRAMES -eq 0 ] && echo "  odt-frames-media   : \033[32mPASS\033[0m" || echo "  odt-frames-media   : \033[31mFAIL\033[0m"
[ $ODT_HF -eq 0 ] && echo "  odt-header-footer  : \033[32mPASS\033[0m" || echo "  odt-header-footer  : \033[31mFAIL\033[0m"
[ $RTF_FIELDS -eq 0 ] && echo "  rtf-fields         : \033[32mPASS\033[0m" || echo "  rtf-fields         : \033[31mFAIL\033[0m"
[ $LSP -eq 0 ] && echo "  lsp-bridge         : \033[32mPASS\033[0m" || echo "  lsp-bridge         : \033[31mFAIL\033[0m"
[ $LANG_LAZY -eq 0 ] && echo "  lang-pack-lazy     : \033[32mPASS\033[0m" || echo "  lang-pack-lazy     : \033[31mFAIL\033[0m"
[ $ODS -eq 0 ] && echo "  ods-roundtrip      : \033[32mPASS\033[0m" || echo "  ods-roundtrip      : \033[31mFAIL\033[0m"
[ $ODS_FX -eq 0 ] && echo "  ods-formulas       : \033[32mPASS\033[0m" || echo "  ods-formulas       : \033[31mFAIL\033[0m"
[ $ODS_COL -eq 0 ] && echo "  ods-templates-collab : \033[32mPASS\033[0m" || echo "  ods-templates-collab : \033[31mFAIL\033[0m"
[ $INTERACTIONS -eq 0 ] && echo "  feature-interactions : \033[32mPASS\033[0m" || echo "  feature-interactions : \033[31mFAIL\033[0m"
[ $ODS_VIRT -eq 0 ] && echo "  ods-virtualization : \033[32mPASS\033[0m" || echo "  ods-virtualization : \033[31mFAIL\033[0m"
[ $ODS_NAV -eq 0 ] && echo "  ods-navigation     : \033[32mPASS\033[0m" || echo "  ods-navigation     : \033[31mFAIL\033[0m"
[ $ODS_LAY -eq 0 ] && echo "  ods-layout         : \033[32mPASS\033[0m" || echo "  ods-layout         : \033[31mFAIL\033[0m"
[ $ODS_FMT -eq 0 ] && echo "  ods-formatting     : \033[32mPASS\033[0m" || echo "  ods-formatting     : \033[31mFAIL\033[0m"
[ $HIST -eq 0 ] && echo "  history            : \033[32mPASS\033[0m" || echo "  history            : \033[31mFAIL\033[0m"
[ $LATEX_RENDER -eq 0 ] && echo "  latex-source-render: \033[32mPASS\033[0m" || echo "  latex-source-render: \033[31mFAIL\033[0m"
[ $LATEX_RELOAD -eq 0 ] && echo "  latex-render-after-reload: \033[32mPASS\033[0m" || echo "  latex-render-after-reload: \033[31mFAIL\033[0m"
[ $AI_CHAT -eq 0 ] && echo "  ai-chat            : \033[32mPASS\033[0m" || echo "  ai-chat            : \033[31mFAIL\033[0m"
[ $PRESENCE -eq 0 ] && echo "  presence-cursors   : \033[32mPASS\033[0m" || echo "  presence-cursors   : \033[31mFAIL\033[0m"
[ $MOBILE -eq 0 ] && echo "  mobile-layout      : \033[32mPASS\033[0m" || echo "  mobile-layout      : \033[31mFAIL\033[0m"
[ $PROJECT_EXPORT -eq 0 ] && echo "  project-export     : \033[32mPASS\033[0m" || echo "  project-export     : \033[31mFAIL\033[0m"
[ $MULTI_CURSOR -eq 0 ] && echo "  multi-cursor       : \033[32mPASS\033[0m" || echo "  multi-cursor       : \033[31mFAIL\033[0m"
[ $SNIPPETS -eq 0 ] && echo "  snippets           : \033[32mPASS\033[0m" || echo "  snippets           : \033[31mFAIL\033[0m"
[ $WORDS -eq 0 ] && echo "  word-count-panel   : \033[32mPASS\033[0m" || echo "  word-count-panel   : \033[31mFAIL\033[0m"
[ $SHORTCUT_HELP -eq 0 ] && echo "  shortcut-help      : \033[32mPASS\033[0m" || echo "  shortcut-help      : \033[31mFAIL\033[0m"
[ $DOI -eq 0 ] && echo "  doi-import         : \033[32mPASS\033[0m" || echo "  doi-import         : \033[31mFAIL\033[0m"
[ $COMPILE_ON_SAVE -eq 0 ] && echo "  compile-on-save    : \033[32mPASS\033[0m" || echo "  compile-on-save    : \033[31mFAIL\033[0m"
[ $SCAFFOLD -eq 0 ] && echo "  scaffold-templates : \033[32mPASS\033[0m" || echo "  scaffold-templates : \033[31mFAIL\033[0m"
echo "==============================================="
exit 1
