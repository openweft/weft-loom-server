package server

// api_lsp.go — huma mount for the LSP discovery endpoint.
//
//   GET /api/lsp → { available: ["latex", "go", …] }
//
// The WS upgrade path (GET /api/lsp/{lang}) stays raw — huma can't
// model a WebSocket handler. See handleLSP in handlers.go.

import (
	"context"

	"github.com/danielgtaylor/huma/v2"

	loomlsp "github.com/openweft/weft-loom-server/internal/lsp"
)

type lspListOutput struct {
	Body struct {
		Available []string `json:"available" doc:"Languages with a resolvable LSP server on this host"`
	}
}

func mountLSPAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "list-lsp-languages",
		Method:      "GET",
		Path:        "/api/lsp",
		Summary:     "List languages with an available LSP server",
		Description: "Returns the set of language identifiers the SPA can use to open a WebSocket against /api/lsp/{lang}. Progressive enhancement gate.",
		Tags:        []string{"lsp"},
	}, func(_ context.Context, _ *struct{}) (*lspListOutput, error) {
		_ = s // reserved for future per-user filtering
		out := &lspListOutput{}
		out.Body.Available = loomlsp.AvailableLanguages()
		return out, nil
	})
}
