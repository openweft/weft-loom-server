package server

import (
	"context"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/compile"
)

// startCompileBody is the wire shape POSTed to start a compile.
// Mirror of compile.JobSpec with explicit doc strings so the
// generated client + interactive docs are self-explanatory.
type startCompileBody struct {
	Language  string   `json:"language" doc:"Sandbox image picker (latex / go / cpp / python / rust / javascript). Required."`
	Entry     string   `json:"entry,omitempty" doc:"Main source file (e.g. main.tex, main.go). Per-language default applies when empty."`
	ExtraArgs []string `json:"extra_args,omitempty" doc:"Appended to the language's default build command."`
	// Command : when non-empty, REPLACES the language's default
	// command. Useful for users with project-specific build scripts
	// (`make build && ./out`, `pkgx +deno deno task build`, etc.).
	// Threaded into JobSpec.CommandOverride ; the dispatcher then
	// runs `sh -c "<command>"` inside the workspace μVM. Single
	// string, NOT a list, so the user types the same shell command
	// they'd paste in a terminal.
	Command string `json:"command,omitempty" doc:"Optional verbatim shell command — overrides the language's default when set. Inside the workspace μVM, the dispatcher runs sh -c <command>."`
	// Engine : LaTeX engine binary the dispatcher invokes for the
	// `latex` language. One of `pdflatex` / `lualatex` / `xelatex` /
	// `gotex` (the pure-Go, WASM-capable engine). Defaults to pdflatex
	// when empty. Ignored for non-LaTeX languages.
	Engine string `json:"engine,omitempty" doc:"LaTeX engine to invoke for the latex language : pdflatex | lualatex | xelatex | gotex. Defaults to pdflatex."`
	// Bib : bibliography processor invoked between the two LaTeX
	// passes when the project carries a bibliography database.
	// One of `bibtex` / `biber`. Defaults to bibtex. Ignored when
	// no bibliography is referenced.
	Bib string `json:"bib,omitempty" doc:"Bibliography processor : bibtex | biber. Defaults to bibtex."`
}

type startCompileInput struct {
	Project string           `path:"name" doc:"Project name"`
	Body    startCompileBody `json:"body"`
}

type startCompileOutput struct {
	Status int
	Body   struct {
		ID string `json:"id" doc:"Job identifier ; tail logs via GET /api/projects/{name}/compile/{id} (SSE)."`
	}
}

// cancelCompileInput carries the (project, jobID) tuple. Both come
// from path segments so the wire stays GET-friendly.
type cancelCompileInput struct {
	Project string `path:"name" doc:"Project name"`
	ID      string `path:"id" doc:"Job identifier returned by start-compile"`
}

// cancelCompileOutput renders 204 No Content on success — no body.
type cancelCompileOutput struct {
	Status int
}

func mountCompileAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID:   "start-compile",
		Method:        "POST",
		Path:          "/api/projects/{name}/compile",
		Summary:       "Start a compile job",
		Description:   "Schedules an ephemeral compile in the language's sandbox image. Returns the job ID immediately ; logs + result stream over Server-Sent Events at /api/projects/{name}/compile/{id} (raw, outside the typed API).",
		Tags:          []string{"compile"},
		DefaultStatus: 202,
	}, func(ctx context.Context, in *startCompileInput) (*startCompileOutput, error) {
		out := &startCompileOutput{Status: 202}
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		id, err := s.opts.Compiler.Start(ctx, ident, compile.JobSpec{
			Project:         in.Project,
			Language:        in.Body.Language,
			Entry:           in.Body.Entry,
			ExtraArgs:       in.Body.ExtraArgs,
			CommandOverride: in.Body.Command,
			Engine:          in.Body.Engine,
			BibEngine:       in.Body.Bib,
		})
		if err != nil {
			return nil, huma.Error400BadRequest("compile start", err)
		}
		out.Body.ID = id
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "cancel-compile",
		Method:        "POST",
		Path:          "/api/projects/{name}/compile/{id}/cancel",
		Summary:       "Cancel an in-flight compile",
		Description:   "Kills the in-flight job — the run goroutine sees ctx.Done() (host subprocess path) / the NATS exec `x` byte (workspace dispatch path), bails, and the SSE stream emits a \"compile cancelled by user\" log line followed by a result(success=false) event. Returns 204 on success ; 404 when the jobID is unknown or the job already terminated.",
		Tags:          []string{"compile"},
		DefaultStatus: 204,
	}, func(ctx context.Context, in *cancelCompileInput) (*cancelCompileOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		if !s.opts.Compiler.Cancel(in.ID) {
			return nil, huma.Error404NotFound("job not found or already finished")
		}
		return &cancelCompileOutput{Status: 204}, nil
	})
}
