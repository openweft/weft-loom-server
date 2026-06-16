package server

// api_snippets.go — per-project user-defined snippets (Overleaf
// "Tags & Snippets" parity). Lets users save bits of text — boilerplate
// preambles, citation patterns, math macros — to a sidecar JSON that
// the SPA merges with the curated default set in web/src/lib/snippets.ts.
//
//   GET    /api/projects/{name}/snippets         → { "snippets": [...] }
//   POST   /api/projects/{name}/snippets         → upsert one (id optional, generated on insert)
//   DELETE /api/projects/{name}/snippets/{id}    → remove one ; 204
//
// Storage is a JSON sidecar at <project>/.weft-loom/snippets.json,
// driven via the existing Projects.ReadFile/WriteFile interface — same
// shape as api_sharing.go. The /files/ handlers reject the .weft-loom/
// prefix (see isInternalPath) so the only legitimate way in is through
// these handlers.
//
// Validation :
//   - label + body are required, non-empty after TrimSpace.
//   - id, if supplied, must match ^[a-zA-Z0-9_-]{1,64}$. Absent on POST
//     → server generates a 16-byte crypto/rand hex string.
//   - The sidecar is capped at 200 entries per project ; the 201st
//     POST returns 413. This guards the sidecar size (the /files/
//     pipe doesn't expose it but the snapshot reader does pull the
//     whole file).
//
// Authz : any authed caller with project access (i.e. can read the
// project's files) may also read + mutate the snippet list. Snippets
// are an editor convenience, not an ACL surface ; gating them behind
// the owner check the sharing API does would be friction for the
// common case where collaborators share macros. Matches Overleaf's
// behaviour : snippets are per-project, every collaborator can edit
// them.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"regexp"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

const (
	snippetsSidecarPath = ".weft-loom/snippets.json"
	snippetsMaxPerProj  = 200
	snippetsReadLimit   = 1 << 20 // 1 MiB cap on the sidecar (≈ 200 × 5 KiB)
)

// snippetIDRe validates user-supplied ids. URL-safe charset + length
// cap so the id can be substituted into the DELETE path without
// percent-encoding shenanigans, and the sidecar stays human-grep-able.
var snippetIDRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// userSnippet is one persisted entry. Keep it small + flat — the SPA
// merges this with the curated SNIPPETS[] table client-side.
type userSnippet struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Body   string `json:"body"`
	Hotkey string `json:"hotkey,omitempty"`
	Scope  string `json:"scope,omitempty"`
}

// snippetDoc is the on-disk shape. Same envelope style as
// sharing.json — a struct (not a bare slice) so we can grow it later
// without a wire break.
type snippetDoc struct {
	Snippets []userSnippet `json:"snippets"`
}

// readSnippets pulls the sidecar. Missing file = empty doc, not an
// error : projects with no user snippets are the common case.
func (s *Server) readSnippets(ctx context.Context, ident auth.Identity, project string) (snippetDoc, error) {
	rc, err := s.opts.Projects.ReadFile(ctx, ident, project, snippetsSidecarPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return snippetDoc{Snippets: []userSnippet{}}, nil
		}
		return snippetDoc{}, err
	}
	defer rc.Close()
	var doc snippetDoc
	body, err := io.ReadAll(io.LimitReader(rc, snippetsReadLimit))
	if err != nil {
		return snippetDoc{}, err
	}
	if len(body) == 0 {
		return snippetDoc{Snippets: []userSnippet{}}, nil
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return snippetDoc{}, err
	}
	if doc.Snippets == nil {
		doc.Snippets = []userSnippet{}
	}
	return doc, nil
}

// writeSnippets persists the sidecar back through the project store.
func (s *Server) writeSnippets(ctx context.Context, ident auth.Identity, project string, doc snippetDoc) error {
	if doc.Snippets == nil {
		doc.Snippets = []userSnippet{}
	}
	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return s.opts.Projects.WriteFile(ctx, ident, project, snippetsSidecarPath, strings.NewReader(string(body)))
}

// newSnippetID generates a short random hex id. crypto/rand only —
// the id is the DELETE path component so collisions across users of
// the same project must be vanishingly rare. 16 bytes → 32 hex chars,
// matches the upper end of our ^[a-zA-Z0-9_-]{1,64}$ rule.
func newSnippetID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// --- huma types -------------------------------------------------------

type snippetOut struct {
	ID     string `json:"id"      doc:"Stable id ; URL-safe (^[a-zA-Z0-9_-]{1,64}$)"`
	Label  string `json:"label"   doc:"Short label shown in the picker (e.g. \"My preamble\")"`
	Body   string `json:"body"    doc:"Verbatim text inserted at the cursor"`
	Hotkey string `json:"hotkey,omitempty" doc:"Optional keyboard shortcut hint (display-only ; binding lives in the editor settings)"`
	Scope  string `json:"scope,omitempty"  doc:"Optional language slug (latex|markdown|…) ; empty = all languages"`
}

type snippetListInput struct {
	Project string `path:"name" doc:"Project name"`
}

type snippetListOutput struct {
	Body struct {
		Snippets []snippetOut `json:"snippets"`
	}
}

type snippetUpsertInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    struct {
		ID     string `json:"id,omitempty"     doc:"Optional id ; absent → server generates one. Matches ^[a-zA-Z0-9_-]{1,64}$."`
		Label  string `json:"label"            doc:"Short label (non-empty after trim)"`
		Body   string `json:"body"             doc:"Verbatim text to insert (non-empty after trim)"`
		Hotkey string `json:"hotkey,omitempty" doc:"Optional keyboard hint"`
		Scope  string `json:"scope,omitempty"  doc:"Optional language slug ; empty = all"`
	}
}

type snippetUpsertOutput struct {
	Body snippetOut
}

type snippetDeleteInput struct {
	Project string `path:"name" doc:"Project name"`
	ID      string `path:"id"   doc:"Snippet id to remove"`
}

// snippetDeleteOutput is the 204 No Content envelope ; matches the
// sharing-delete shape.
type snippetDeleteOutput struct {
	Status int
}

func snippetToOut(u userSnippet) snippetOut {
	return snippetOut{
		ID:     u.ID,
		Label:  u.Label,
		Body:   u.Body,
		Hotkey: u.Hotkey,
		Scope:  u.Scope,
	}
}

func snippetsToOut(doc snippetDoc) []snippetOut {
	out := make([]snippetOut, 0, len(doc.Snippets))
	for _, u := range doc.Snippets {
		out = append(out, snippetToOut(u))
	}
	return out
}

func mountSnippetsAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "list-snippets",
		Method:      "GET",
		Path:        "/api/projects/{name}/snippets",
		Summary:     "List user-defined snippets for a project",
		Description: "Returns the per-project snippets the user has saved. Merged client-side with the curated default set in snippets.ts.",
		Tags:        []string{"snippets"},
	}, func(ctx context.Context, in *snippetListInput) (*snippetListOutput, error) {
		out := &snippetListOutput{}
		if s == nil {
			out.Body.Snippets = []snippetOut{}
			return out, nil
		}
		ident, _ := auth.IdentityFrom(ctx)
		doc, err := s.readSnippets(ctx, ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("snippets: read", err)
		}
		out.Body.Snippets = snippetsToOut(doc)
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "upsert-snippet",
		Method:      "POST",
		Path:        "/api/projects/{name}/snippets",
		Summary:     "Create or update a user snippet",
		Description: "Idempotent upsert keyed by id. If the request body omits id the server generates a 32-char hex id and returns it in the response. The per-project cap is 200 snippets ; the 201st create returns 413.",
		Tags:        []string{"snippets"},
	}, func(ctx context.Context, in *snippetUpsertInput) (*snippetUpsertOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)

		label := strings.TrimSpace(in.Body.Label)
		body := in.Body.Body
		// Trim only for the emptiness check ; preserve the user's
		// indentation / trailing newline in the persisted body. Many
		// snippets (preambles, code blocks) rely on exact whitespace.
		if label == "" {
			return nil, huma.Error400BadRequest("snippets: label is required")
		}
		if strings.TrimSpace(body) == "" {
			return nil, huma.Error400BadRequest("snippets: body is required")
		}

		id := strings.TrimSpace(in.Body.ID)
		if id != "" && !snippetIDRe.MatchString(id) {
			return nil, huma.Error400BadRequest("snippets: id must match ^[a-zA-Z0-9_-]{1,64}$")
		}

		doc, err := s.readSnippets(ctx, ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("snippets: read", err)
		}

		// Generate an id if the client didn't supply one. Re-roll on
		// the (vanishingly rare) collision so callers always observe
		// a distinct id post-POST.
		if id == "" {
			for try := 0; try < 4; try++ {
				cand, gerr := newSnippetID()
				if gerr != nil {
					return nil, huma.Error500InternalServerError("snippets: id gen", gerr)
				}
				clash := false
				for _, ex := range doc.Snippets {
					if ex.ID == cand {
						clash = true
						break
					}
				}
				if !clash {
					id = cand
					break
				}
			}
			if id == "" {
				return nil, huma.Error500InternalServerError("snippets: could not allocate id")
			}
		}

		// Upsert : overwrite if id is already present, otherwise
		// append — subject to the 200-cap (which only blocks NEW
		// entries, never replacements).
		entry := userSnippet{
			ID:     id,
			Label:  label,
			Body:   body,
			Hotkey: strings.TrimSpace(in.Body.Hotkey),
			Scope:  strings.TrimSpace(in.Body.Scope),
		}
		found := false
		for i := range doc.Snippets {
			if doc.Snippets[i].ID == id {
				doc.Snippets[i] = entry
				found = true
				break
			}
		}
		if !found {
			if len(doc.Snippets) >= snippetsMaxPerProj {
				return nil, huma.Error413RequestEntityTooLarge(
					fmt.Sprintf("snippets: per-project cap reached (%d)", snippetsMaxPerProj))
			}
			doc.Snippets = append(doc.Snippets, entry)
		}
		if err := s.writeSnippets(ctx, ident, in.Project, doc); err != nil {
			return nil, huma.Error500InternalServerError("snippets: write", err)
		}
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "snippets", Verb: "upsert",
			Project: in.Project,
			Fields:  map[string]any{"id": id, "label": label, "bytes": len(body)},
		})
		return &snippetUpsertOutput{Body: snippetToOut(entry)}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "delete-snippet",
		Method:        "DELETE",
		Path:          "/api/projects/{name}/snippets/{id}",
		Summary:       "Remove a user snippet",
		Description:   "Idempotent : returns 204 whether or not the id existed.",
		Tags:          []string{"snippets"},
		DefaultStatus: 204,
	}, func(ctx context.Context, in *snippetDeleteInput) (*snippetDeleteOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		id := strings.TrimSpace(in.ID)
		if !snippetIDRe.MatchString(id) {
			return nil, huma.Error400BadRequest("snippets: id must match ^[a-zA-Z0-9_-]{1,64}$")
		}

		doc, err := s.readSnippets(ctx, ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("snippets: read", err)
		}
		out := doc.Snippets[:0]
		removed := false
		for _, u := range doc.Snippets {
			if u.ID == id {
				removed = true
				continue
			}
			out = append(out, u)
		}
		doc.Snippets = out
		if err := s.writeSnippets(ctx, ident, in.Project, doc); err != nil {
			return nil, huma.Error500InternalServerError("snippets: write", err)
		}
		if removed {
			s.events.Publish(eventbus.Event{
				Source: "server", Component: "snippets", Verb: "delete",
				Project: in.Project,
				Fields:  map[string]any{"id": id},
			})
		}
		return &snippetDeleteOutput{Status: 204}, nil
	})
}
