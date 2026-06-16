package server

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/project"
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

	huma.Register(api, huma.Operation{
		OperationID: "rename-project",
		Method:      "POST",
		Path:        "/api/projects/{name}/rename",
		Summary:     "Rename a project",
		Description: "Renames the project directory under the caller's storage root. Sidecars under .weft-loom/ (sharing.json, owner) travel with the directory ; git remotes stay attached because git is content-addressed. Refuses if the destination name is already taken (409) or invalid (400).",
		Tags:        []string{"projects"},
	}, func(ctx context.Context, in *renameProjectInput) (*renameProjectOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		newName := in.Body.NewName
		if err := s.opts.Projects.Rename(ctx, ident, in.Project, newName); err != nil {
			switch {
			case errors.Is(err, project.ErrInvalidName):
				return nil, huma.Error400BadRequest("invalid project name")
			case errors.Is(err, project.ErrProjectExists):
				return nil, huma.Error409Conflict("destination project already exists")
			case errors.Is(err, project.ErrAccessDenied):
				return nil, huma.Error403Forbidden("access denied")
			case errors.Is(err, project.ErrNotFound):
				return nil, huma.Error404NotFound("project not found")
			default:
				return nil, huma.Error500InternalServerError("rename project", err)
			}
		}
		// Best-effort post-rename projectOut. We avoid re-listing the
		// whole store (an extra readdir per rename, plus the
		// ordering churn) and instead build the projectOut from the
		// destination directory's modtime + a fresh language probe.
		// Falls back to Now() if the directory probe fails — the
		// rename itself succeeded, so the response staying empty
		// would be more surprising than a slightly fuzzy CreatedAt.
		out := &renameProjectOutput{}
		out.Body.Name = newName
		out.Body.CreatedAt = time.Now()
		// LocalStore exposes a Root() so we can stat the destination
		// directly without a Store-interface round-trip ; the
		// PostgresStore variant exposes the same method.
		type rooted interface{ Root() string }
		if r, ok := s.opts.Projects.(rooted); ok {
			dir := filepath.Join(r.Root(), sanitiseSubject(ident.Subject), newName)
			if info, err := os.Stat(dir); err == nil {
				out.Body.CreatedAt = info.ModTime()
				out.Body.Language = detectProjectLanguage(dir)
			}
		}
		return out, nil
	})
}

// renameProjectInput is the path + body envelope for POST
// /api/projects/{name}/rename. Body validation lives in the project
// store ; the huma-level validator only enforces non-empty.
type renameProjectInput struct {
	Project string `path:"name" doc:"Current project name"`
	Body    struct {
		NewName string `json:"newName" minLength:"1" maxLength:"128" doc:"Desired new project name (filesystem-safe identifier)"`
	}
}

type renameProjectOutput struct {
	Body projectOut
}

// sanitiseSubject mirrors project.sanitise on the auth subject so the
// per-user directory path matches what the store would compute. Kept
// private to this file ; the rename op only needs it to project a
// post-rename modtime without a full list round-trip.
func sanitiseSubject(subj string) string {
	out := make([]rune, 0, len(subj))
	for _, r := range subj {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-' || r == '_':
			out = append(out, r)
		}
	}
	return string(out)
}

// detectProjectLanguage mirrors project.detectLanguage : cheap
// filesystem probe for the language hint, used by the rename op so
// the response carries the same projectOut shape List would.
func detectProjectLanguage(dir string) string {
	for _, m := range []struct {
		file, lang string
	}{
		{"main.tex", "latex"},
		{"go.mod", "go"},
		{"package.json", "javascript"},
		{"Cargo.toml", "rust"},
		{"CMakeLists.txt", "cpp"},
		{"requirements.txt", "python"},
		{"pyproject.toml", "python"},
		{"README.md", "markdown"},
	} {
		if _, err := os.Stat(filepath.Join(dir, m.file)); err == nil {
			return m.lang
		}
	}
	return ""
}
