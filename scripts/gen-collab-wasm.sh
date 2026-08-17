#!/bin/sh
# Build the collaborative editing client into web/public, and put its type
# declarations where the SPA can see them.
#
# The editor is TypeScript and cannot call Go, so the client is compiled to
# WebAssembly and reached through globalThis.collab. It goes in public/ for the
# same reason the icons do: vite copies that into the bundle the Go binary
# embeds, so `go build` stays the single source of truth for what is deployed.
#
# Neither the binary nor the declarations are checked in — a copy checked in is
# a copy that silently stops matching the module it came from. That is the right
# call and it has a consequence: every lane that builds or type-checks the web
# has to run this first. Two did not, and it cost twice —
#
#   - CI's svelte-check could not resolve './collab.d' and reported forty
#     cascading "implicitly has an 'any' type" errors from one missing file.
#   - the release lane would have shipped an SPA with no collab.wasm beside it:
#     an editor that loads, and never collaborates.
#
# So this exists as one script rather than as three commands repeated in a
# Taskfile and two workflows, because the third copy is where they drift.
set -eu

cd "$(dirname "$0")/.."

# A stray go.work in a parent directory pulls in sibling modules and breaks the
# js/wasm build. CI has none; a development machine can.
export GOWORK=off

GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/public/collab.wasm github.com/go-crdt/collab/wasm

# wasm_exec.js comes from the toolchain rather than the repository, because a
# copy checked in is a copy that silently stops matching the compiler.
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" web/public/wasm_exec.js

# The declarations come from the same module as the binary, so they cannot
# describe a version that is not the one running. The module cache is read-only,
# so the copy is too until told otherwise — and a second run would fail on its
# own output.
cp "$(go list -m -f '{{.Dir}}' github.com/go-crdt/collab)/wasm/collab.d.ts" web/src/lib/collab.d.ts
chmod u+w web/src/lib/collab.d.ts
