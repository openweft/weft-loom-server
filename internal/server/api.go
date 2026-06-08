// api.go — central huma setup. The metadata endpoints (project list,
// file index, compile job start) flow through huma so we get typed
// OpenAPI generation + automatic validation + 422 responses. Routes
// that don't fit huma cleanly stay on stdlib :
//
//   - GET /api/projects/{name}/files/{path...}  binary stream
//   - PUT /api/projects/{name}/files/{path...}  binary upload
//   - GET /api/projects/{name}/compile/{id}     SSE stream
//   - WS  /api/projects/{name}/sync             y-websocket bridge
//
// huma adds a few KB to the binary but eliminates the
// map[string]any envelope class — same trade weft-webui made.

package server

import (
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
)

// MountAPIForCodegen is the exported entry the openapi dump tool uses
// to introspect the spec without instantiating Deps + auth. Mirrors
// weft-webui's pattern.
func MountAPIForCodegen(mux *http.ServeMux) huma.API {
	return mountAPI(mux, nil)
}

func mountAPI(mux *http.ServeMux, s *Server) huma.API {
	cfg := huma.DefaultConfig("weft-loom-server API", "v1")
	cfg.OpenAPIPath = "/api/openapi"
	cfg.DocsPath = "/api/docs"
	api := humago.New(mux, cfg)

	mountProjectsAPI(api, s)
	mountFilesIndexAPI(api, s)
	mountCompileAPI(api, s)

	return api
}
