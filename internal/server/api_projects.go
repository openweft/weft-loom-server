package server

import (
	"context"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// projectOut mirrors project.Project with explicit JSON tags so the
// OpenAPI schema is what the TS client sees.
type projectOut struct {
	Name      string    `json:"name" doc:"Project name (filesystem-safe identifier)"`
	Language  string    `json:"language,omitempty" doc:"Detected language hint (latex / go / cpp / python / rust / javascript / markdown)"`
	CreatedAt time.Time `json:"created_at" doc:"Last modification time of the project directory"`
}

type listProjectsOutput struct {
	Body struct {
		Items []projectOut `json:"items"`
	}
}

func mountProjectsAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "list-projects",
		Method:      "GET",
		Path:        "/api/projects",
		Summary:     "List the caller's projects",
		Tags:        []string{"projects"},
	}, func(ctx context.Context, _ *struct{}) (*listProjectsOutput, error) {
		out := &listProjectsOutput{}
		if s == nil {
			return out, nil
		}
		ident, _ := auth.IdentityFrom(ctx)
		projects, err := s.opts.Projects.List(ctx, ident)
		if err != nil {
			return nil, huma.Error500InternalServerError("list projects", err)
		}
		for _, p := range projects {
			out.Body.Items = append(out.Body.Items, projectOut{
				Name:      p.Name,
				Language:  p.Language,
				CreatedAt: p.CreatedAt,
			})
		}
		return out, nil
	})
}
