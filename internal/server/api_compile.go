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
		})
		if err != nil {
			return nil, huma.Error400BadRequest("compile start", err)
		}
		out.Body.ID = id
		return out, nil
	})
}
