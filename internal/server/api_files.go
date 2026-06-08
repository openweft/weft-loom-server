package server

import (
	"context"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// fileOut mirrors project.File for the OpenAPI schema.
type fileOut struct {
	Path string `json:"path" doc:"Path relative to the project root"`
	Size int64  `json:"size" doc:"Size in bytes"`
	Dir  bool   `json:"dir" doc:"True when the entry is a directory"`
}

type listFilesInput struct {
	Project string `path:"name" doc:"Project name"`
}

type listFilesOutput struct {
	Body struct {
		Items []fileOut `json:"items"`
	}
}

func mountFilesIndexAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "list-files",
		Method:      "GET",
		Path:        "/api/projects/{name}/files",
		Summary:     "List files in a project",
		Description: "Returns every file in the project as a flat list with relative paths. Directories appear with dir=true. Binary read/write of one file lands on /api/projects/{name}/files/{path...} (raw, outside the typed API).",
		Tags:        []string{"files"},
	}, func(ctx context.Context, in *listFilesInput) (*listFilesOutput, error) {
		out := &listFilesOutput{}
		if s == nil {
			return out, nil
		}
		ident, _ := auth.IdentityFrom(ctx)
		files, err := s.opts.Projects.ListFiles(ctx, ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("list files", err)
		}
		for _, f := range files {
			out.Body.Items = append(out.Body.Items, fileOut{
				Path: f.Path,
				Size: f.Size,
				Dir:  f.Dir,
			})
		}
		return out, nil
	})
}
