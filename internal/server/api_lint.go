package server

// api_lint.go — huma mount for the strict LaTeX linter (`chktex`).
//
//   POST /api/projects/{name}/lint/chktex  { content } → { diagnostics }
//
// The endpoint exists for the editor's debounced "as-you-type"
// strict-lint pass. texlab already streams LSP-level diagnostics over
// the WS bridge ; chktex catches the second tier of style issues
// (sentence-end spacing, missing braces around super/sub-scripts,
// inter-sentence space patterns, etc.) — the same warnings Overleaf
// surfaces inline. Keeping it on a plain JSON POST instead of folding
// it into the LSP stream avoids a custom `workspace/executeCommand`
// dance + lets us debounce client-side without the LSP didChange/
// publishDiagnostics race.
//
// Wire contract :
//
//   request  : { "content": "<.tex source>" }
//   response : { "diagnostics": [ { line, col, code, message, severity }, … ] }
//
// Authz : same shape as snippets / sharing — any authed caller with
// project access. The `Project` path param is required by the URL
// schema but is *not* used to read files — the SPA always sends the
// in-editor buffer (the user's unsaved edits). Logging the project
// name keeps the audit trail tidy.
//
// Graceful degradation : if `chktex` isn't on $PATH on this host,
// the endpoint still answers 200 with an empty diagnostics array.
// The SPA treats that as "strict linting unavailable, fall back to
// LSP-only diagnostics" without surfacing a warning to the user.

import (
	"context"
	"errors"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/lintchktex"
)

// chktexInput : `Project` is path-bound + the body carries the raw
// editor buffer. We cap nothing here ; huma's default body-size
// guard (server-wide) already covers oversized uploads.
type chktexInput struct {
	Project string `path:"name" doc:"Project name (audit-only — content is taken from the body)"`
	Body    struct {
		Content string `json:"content" doc:"Raw .tex source to lint. Typically the user's current editor buffer."`
	}
}

// chktexDiagOut mirrors lintchktex.Diagnostic but exists as a server-
// local type so huma can attach json/doc tags + so the OpenAPI spec
// doesn't reference an internal package. The two are kept field-for-
// field aligned ; converting is a flat copy.
type chktexDiagOut struct {
	Line     int    `json:"line"     doc:"1-based line number"`
	Col      int    `json:"col"      doc:"1-based column"`
	Code     int    `json:"code"     doc:"chktex warning code (numeric, see chktex docs)"`
	Message  string `json:"message"  doc:"Human-readable description"`
	Severity string `json:"severity" doc:"LSP severity bucket : error | warning | info"`
}

type chktexOutput struct {
	Body struct {
		Diagnostics []chktexDiagOut `json:"diagnostics"`
		// Available is true when the chktex binary is resolvable on
		// the host ; lets the SPA distinguish "no warnings found"
		// from "linter not installed" without an extra discovery
		// round-trip.
		Available bool `json:"available" doc:"True when the chktex binary is installed on the host"`
	}
}

func mountLintAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "lint-chktex",
		Method:      "POST",
		Path:        "/api/projects/{name}/lint/chktex",
		Summary:     "Run strict LaTeX linter (chktex) over the supplied content",
		Description: "Pipes the request body into the chktex binary on the host and returns the parsed diagnostics. The endpoint sits beside the LSP bridge — texlab covers semantic / parser-level issues, chktex layers stylistic checks (sentence-end spacing, missing braces around super/sub-scripts, etc.) on top. Returns an empty `diagnostics` array with `available: false` when the binary isn't installed.",
		Tags:        []string{"lint"},
	}, func(ctx context.Context, in *chktexInput) (*chktexOutput, error) {
		out := &chktexOutput{}
		out.Body.Diagnostics = []chktexDiagOut{}
		out.Body.Available = lintchktex.Available()

		if !out.Body.Available {
			// Binary missing — return empty diagnostics rather than 503.
			// The SPA treats `available: false` as "fall back to LSP-only".
			return out, nil
		}

		diags, err := lintchktex.RunChktex(ctx, []byte(in.Body.Content))
		if err != nil {
			// Don't 500 — log via the event bus + return what we have.
			// chktex spawn failures shouldn't break the editor's typing
			// experience. We do propagate context cancellation though.
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil, huma.Error408RequestTimeout("chktex: " + err.Error())
			}
			return nil, huma.Error500InternalServerError("chktex: " + err.Error())
		}
		for _, d := range diags {
			out.Body.Diagnostics = append(out.Body.Diagnostics, chktexDiagOut{
				Line:     d.Line,
				Col:      d.Col,
				Code:     d.Code,
				Message:  d.Message,
				Severity: d.Severity,
			})
		}

		// Audit trail : low-cardinality fields only. The buffer is
		// untrusted user content, so we log size + diag count + the
		// caller — never the content itself.
		if s != nil {
			ident, _ := auth.IdentityFrom(ctx)
			s.events.Publish(eventbus.Event{
				Source: "server", Component: "lint", Verb: "chktex",
				Project: in.Project,
				Fields: map[string]any{
					"bytes":      len(in.Body.Content),
					"diagnostics": len(out.Body.Diagnostics),
					"subject":    ident.Subject,
				},
			})
		}
		return out, nil
	})
}
