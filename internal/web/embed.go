// Package web embeds the built SPA bundle under dist/. The Svelte
// build emits its output here ; the Go binary picks it up at compile
// time via //go:embed so the deployment artifact is a single binary
// with no sibling static files to ship.
//
// During V0.1 dist/ holds only a placeholder index.html ; V0.2 wires
// `task gen-web` to populate it with the real Svelte+CodeMirror+Yjs
// bundle.
package web

import (
	"embed"
	"io/fs"
)

//go:embed dist
var distFS embed.FS

// DistFS returns the dist/ subtree rooted at "/" so the HTTP file
// server can serve index.html as the root URL.
func DistFS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}
