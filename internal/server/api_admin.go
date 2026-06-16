package server

// api_admin.go — huma registration for the small admin / meta GET
// surface and the project scaffold POST. Each operation reuses logic
// that lives next to its existing helpers (api_admin_oci.go,
// api_settings_email.go, api_project_templates.go) — this file owns
// the wire layer only.
//
// Routes :
//
//	GET  /api/healthz                      → { status: "ok" }
//	GET  /api/admin/email/config           → { configured, from }
//	GET  /api/admin/oci-images             → { images: [...] }
//	GET  /api/project-templates            → { items:  [...] }
//	POST /api/projects/{name}/scaffold     → { written, entry } | 409 + clashes
//
// Auth shape : healthz stays open (liveness probe). The three admin
// reads + scaffold check auth.IdentityFrom(ctx) and 401 when no
// identity was injected by ServeHTTP — preserving the wire behaviour
// of the requireAuth wrapper they replaced.

import (
	"context"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

// healthzOutput is the liveness response. Body shape stays
// {"status":"ok"} so existing probes don't have to change.
type healthzOutput struct {
	Body struct {
		Status string `json:"status" doc:"Always \"ok\" — liveness probe"`
	}
}

func mountAdminAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "healthz",
		Method:      "GET",
		Path:        "/api/healthz",
		Summary:     "Liveness probe",
		Description: "Returns { status: \"ok\" } once the server is accepting requests. Unauthenticated — the operator's probe + the SPA both rely on this.",
		Tags:        []string{"meta"},
	}, func(_ context.Context, _ *struct{}) (*healthzOutput, error) {
		out := &healthzOutput{}
		out.Body.Status = "ok"
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-email-config",
		Method:      "GET",
		Path:        "/api/admin/email/config",
		Summary:     "Read the SMTP sender summary",
		Description: "Returns whether SMTP is configured at the process level (host env var present) and the From address operators advertise to end users. Credentials are deliberately never returned.",
		Tags:        []string{"admin"},
	}, func(ctx context.Context, _ *struct{}) (*emailConfigOutput, error) {
		if _, ok := auth.IdentityFrom(ctx); !ok {
			return nil, huma.Error401Unauthorized("unauthorized")
		}
		return &emailConfigOutput{Body: readEmailConfig()}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "admin-oci-images",
		Method:      "GET",
		Path:        "/api/admin/oci-images",
		Summary:     "Probe the compile dispatcher's OCI images",
		Description: "Returns one entry per language with its resolved image ref, the manifest probe status (ok | missing | unauthorized | unreachable) and the last-checked unix timestamp. Cached for 5 minutes ; pass ?force=1 to bypass the cache.",
		Tags:        []string{"admin"},
	}, func(ctx context.Context, in *ociImagesInput) (*ociImagesOutput, error) {
		if _, ok := auth.IdentityFrom(ctx); !ok {
			return nil, huma.Error401Unauthorized("unauthorized")
		}
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		out := &ociImagesOutput{}
		out.Body.Images = s.ociProber.snapshot(ctx, in.Force)
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "list-project-templates",
		Method:      "GET",
		Path:        "/api/project-templates",
		Summary:     "List the multi-file project scaffolds",
		Description: "Returns the curated catalogue of project templates surfaced in the SPA's \"New project from template\" picker. Each entry lists the files it would write + a size hint so the dialog can preview \"5 files, 6.2 KB\".",
		Tags:        []string{"meta"},
	}, func(ctx context.Context, _ *struct{}) (*projectTemplatesListOutput, error) {
		if _, ok := auth.IdentityFrom(ctx); !ok {
			return nil, huma.Error401Unauthorized("unauthorized")
		}
		out := &projectTemplatesListOutput{}
		out.Body.Items = projectTemplates
		return out, nil
	})
}

// mountScaffoldAPI registers POST /api/projects/{name}/scaffold. Kept
// separate from mountAdminAPI because the scaffold mutates project
// state ; reading it next to the admin GETs would conflate verbs.
func mountScaffoldAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "apply-project-template",
		Method:      "POST",
		Path:        "/api/projects/{name}/scaffold",
		Summary:     "Seed a project from a multi-file template",
		Description: "Writes every file listed in the catalogue entry under the target project. By default the request 409s if any target path already exists in the project ; pass force=true to overwrite. The response carries the list of written files + an entry-point suggestion (main.tex / slides.md / README.md, in that priority).",
		Tags:        []string{"projects"},
	}, func(ctx context.Context, in *scaffoldInput) (*scaffoldOutput, error) {
		if _, ok := auth.IdentityFrom(ctx); !ok {
			return nil, huma.Error401Unauthorized("unauthorized")
		}
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		proj := in.Project

		var tmpl *projectTemplate
		for i := range projectTemplates {
			if projectTemplates[i].ID == in.Body.TemplateID {
				tmpl = &projectTemplates[i]
				break
			}
		}
		if tmpl == nil {
			// Legacy envelope : { "error": "unknown template_id : ..." }
			// — keep it byte-identical so the SPA's error path doesn't
			// need a branch on shape.
			out := &scaffoldOutput{Status: 404}
			out.Body.Error = "unknown template_id : " + in.Body.TemplateID
			return out, nil
		}

		// Conflict pre-flight : refuse if ANY target path already
		// exists in the project unless force=true. Saves the user from
		// silently clobbering hand-written content. We return a 409
		// with the legacy {error, clashes} envelope (NOT huma's
		// structured ErrorModel) — the SPA + scaffold-templates.mjs
		// integration test both read d.clashes on the response.
		if !in.Body.Force {
			files, err := s.opts.Projects.ListFiles(ctx, ident, proj)
			if err == nil {
				existing := map[string]struct{}{}
				for _, f := range files {
					existing[f.Path] = struct{}{}
				}
				var clashes []string
				for _, f := range tmpl.Files {
					if _, ok := existing[f.Path]; ok {
						clashes = append(clashes, f.Path)
					}
				}
				if len(clashes) > 0 {
					out := &scaffoldOutput{Status: 409}
					out.Body.Error = "target paths exist (pass force=true to overwrite)"
					out.Body.Clashes = clashes
					return out, nil
				}
			}
		}

		written := make([]string, 0, len(tmpl.Files))
		for _, f := range tmpl.Files {
			// .gitkeep files create the directory without an actual
			// keep-content artefact — most stores honour zero-byte
			// writes so the directory becomes browsable.
			body := strings.NewReader(f.Content)
			if werr := s.opts.Projects.WriteFile(ctx, ident, proj, f.Path, body); werr != nil {
				// Match the legacy {error, written} envelope on
				// partial-write failure so the SPA can show which
				// files made it.
				out := &scaffoldOutput{Status: 500}
				out.Body.Error = "write " + f.Path + " : " + werr.Error()
				out.Body.Written = written
				return out, nil
			}
			written = append(written, f.Path)
		}

		s.events.Publish(eventbus.Event{
			Source: "server", Component: "scaffold", Verb: "applied",
			Project: proj,
			Fields:  map[string]any{"template": tmpl.ID, "files": len(written)},
		})

		// Open the entry-point file in the response so the SPA can
		// auto-focus it after scaffolding. main.tex / slides.md /
		// README.md in that priority order.
		var entry string
		priority := []string{"main.tex", "slides.md", "README.md"}
		for _, p := range priority {
			for _, f := range tmpl.Files {
				if f.Path == p {
					entry = p
					break
				}
			}
			if entry != "" {
				break
			}
		}
		if entry == "" && len(written) > 0 {
			entry = written[0]
		}

		out := &scaffoldOutput{Status: 200}
		out.Body.Written = written
		out.Body.Entry = entry
		return out, nil
	})
}
