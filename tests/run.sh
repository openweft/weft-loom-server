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
echo "==============================================="
if [ $UI -eq 0 ] && [ $LANG -eq 0 ] && [ $PREVIEW -eq 0 ] && [ $UIENTRY -eq 0 ] && [ $THEMEP -eq 0 ] && [ $WYSIWYG -eq 0 ] && [ $WYSIWYG_ODT -eq 0 ] && [ $WYSIWYG_ODT_TB -eq 0 ]; then
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
echo "==============================================="
exit 1
