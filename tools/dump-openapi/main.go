// Command dump-openapi writes the live OpenAPI 3.1 spec to stdout.
// Consumed by `task gen-api` in the web/ Vite workspace to regenerate
// the TypeScript client via openapi-typescript + openapi-fetch.
//
// Mirrors the weft-webui pattern : same pipeline, same tooling, same
// "spec is the contract" discipline.
package main

import (
	"net/http"
	"os"

	"github.com/openweft/weft-loom-server/internal/server"
)

func main() {
	mux := http.NewServeMux()
	api := server.MountAPIForCodegen(mux)
	b, err := api.OpenAPI().YAML()
	if err != nil {
		_, _ = os.Stderr.WriteString("dump-openapi: " + err.Error() + "\n")
		os.Exit(1)
	}
	// huma's YAML() output is fine ; openapi-typescript reads YAML
	// equally well, but the rest of the openweft fleet prefers JSON
	// so we marshal to JSON via the YAML→JSON round-trip the Marshal
	// API does for us.
	j, err := api.OpenAPI().MarshalJSON()
	if err != nil {
		_, _ = os.Stderr.WriteString("dump-openapi: " + err.Error() + "\n")
		os.Exit(1)
	}
	_ = b
	_, _ = os.Stdout.Write(j)
	_, _ = os.Stdout.WriteString("\n")
}
