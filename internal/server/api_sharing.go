package server

// api_sharing.go — per-project ACL for collaborative LaTeX editing.
//
//   GET    /api/projects/{name}/sharing          → { "shares": [{user, role}, ...] }
//   POST   /api/projects/{name}/sharing          → upsert one share
//   DELETE /api/projects/{name}/sharing/{user}   → remove one share
//
// Storage is a JSON sidecar at <project>/.weft-loom/sharing.json,
// driven via the existing Projects.ReadFile/WriteFile interface so
// every backend (LocalStore today, PostgresStore tomorrow) gets the
// behaviour for free. Roles : "editor", "commenter", "viewer".
//
// Authz model (V0.1, deliberately lean) :
//   - Any authed caller can GET — collaborators need to see whom else
//     a project is shared with.
//   - Only the project OWNER can POST or DELETE. The owner is recorded
//     in <project>/.weft-loom/owner (one line, the dex Subject). When
//     the file is absent we fall through to a permissive default :
//     the FIRST authed caller becomes the owner (the file is written
//     on their first mutating call). This means a fresh project gets
//     its owner pinned on the first share invitation, which is the
//     natural flow today — projects are created by the user via the
//     SPA, then shared.
//
// Out of scope V0.1 : group ACLs, per-file ACLs, invitation tokens.
//
// Wire surface flows through huma so the OpenAPI spec + generated TS
// client stay in sync with the handlers. The helpers below take a
// context.Context instead of *http.Request so they're reusable across
// the typed API and any future raw callers.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

const (
	sharingSidecarPath = ".weft-loom/sharing.json"
	sharingOwnerPath   = ".weft-loom/owner"
)

// share is one ACL entry. Keep the JSON keys snake_case-free —
// existing sidecars (history, comments) stick to lowerCamel-ish on
// the wire, mirror that.
type share struct {
	User string `json:"user"`
	Role string `json:"role"`
}

// shareDoc is the on-disk shape. A struct (not a bare slice) so we
// can grow it later — e.g. add { "version": 1, "shares": [...] }
// without breaking the wire.
type shareDoc struct {
	Shares []share `json:"shares"`
}

// validRoles is the closed enum. Unknown roles get a 400.
var validRoles = map[string]bool{
	"editor":    true,
	"commenter": true,
	"viewer":    true,
}

// readSharing pulls the sidecar. Missing file = empty doc, not an
// error : a project with no invitations is the normal case.
func (s *Server) readSharing(ctx context.Context, ident auth.Identity, project string) (shareDoc, error) {
	rc, err := s.opts.Projects.ReadFile(ctx, ident, project, sharingSidecarPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return shareDoc{Shares: []share{}}, nil
		}
		return shareDoc{}, err
	}
	defer rc.Close()
	var doc shareDoc
	body, err := io.ReadAll(io.LimitReader(rc, 1<<20))
	if err != nil {
		return shareDoc{}, err
	}
	if len(body) == 0 {
		return shareDoc{Shares: []share{}}, nil
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return shareDoc{}, err
	}
	if doc.Shares == nil {
		doc.Shares = []share{}
	}
	return doc, nil
}

// writeSharing persists the sidecar back through the project store.
func (s *Server) writeSharing(ctx context.Context, ident auth.Identity, project string, doc shareDoc) error {
	if doc.Shares == nil {
		doc.Shares = []share{}
	}
	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return s.opts.Projects.WriteFile(ctx, ident, project, sharingSidecarPath, strings.NewReader(string(body)))
}

// ownerOf reads <project>/.weft-loom/owner. Returns "" + nil when
// the file is absent so callers can fall back to "first caller wins".
func (s *Server) ownerOf(ctx context.Context, ident auth.Identity, project string) (string, error) {
	rc, err := s.opts.Projects.ReadFile(ctx, ident, project, sharingOwnerPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	defer rc.Close()
	body, err := io.ReadAll(io.LimitReader(rc, 256))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}

// requireOwner enforces "only the owner may mutate". When no owner is
// recorded yet we pin the caller as owner — see the package comment.
// Returns a huma.StatusError on refusal so the typed API surface can
// translate it into the right HTTP code automatically.
func (s *Server) requireOwner(ctx context.Context, ident auth.Identity, project string) error {
	owner, err := s.ownerOf(ctx, ident, project)
	if err != nil {
		return huma.Error500InternalServerError("sharing: owner lookup", err)
	}
	if owner == "" {
		// First mutator wins : pin ident as the owner.
		if werr := s.opts.Projects.WriteFile(ctx, ident, project, sharingOwnerPath, strings.NewReader(ident.Subject+"\n")); werr != nil {
			return huma.Error500InternalServerError("sharing: pin owner", werr)
		}
		return nil
	}
	if owner != ident.Subject {
		return huma.Error403Forbidden("sharing: only the project owner may modify ACL")
	}
	return nil
}

// sharingShareOut is the wire shape for one ACL entry, with explicit
// doc strings so the generated client + interactive docs are
// self-explanatory.
type sharingShareOut struct {
	User string `json:"user" doc:"User subject (dex sub claim)"`
	Role string `json:"role" doc:"editor | commenter | viewer"`
}

type sharingListInput struct {
	Project string `path:"name" doc:"Project name"`
}

type sharingListOutput struct {
	Body struct {
		Shares []sharingShareOut `json:"shares"`
	}
}

type sharingUpsertInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    struct {
		User string `json:"user" doc:"User subject (dex sub claim) to invite or update"`
		Role string `json:"role" doc:"One of editor | commenter | viewer"`
	}
}

type sharingDeleteInput struct {
	Project string `path:"name" doc:"Project name"`
	User    string `path:"user" doc:"User subject to remove from the ACL"`
}

// sharingDeleteOutput carries the 204 No Content status. No Body
// field — huma renders an empty response.
type sharingDeleteOutput struct {
	Status int
}

// shareDocToOut maps the on-disk doc into the typed wire output. The
// JSON shape is byte-identical to the legacy raw handler (a sharing
// object with a `shares` array of {user, role}).
func shareDocToOut(doc shareDoc) []sharingShareOut {
	out := make([]sharingShareOut, 0, len(doc.Shares))
	for _, sh := range doc.Shares {
		out = append(out, sharingShareOut{User: sh.User, Role: sh.Role})
	}
	return out
}

func mountSharingAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "list-sharing",
		Method:      "GET",
		Path:        "/api/projects/{name}/sharing",
		Summary:     "List the ACL entries for a project",
		Description: "Returns the per-project share list. Any authed caller can GET — collaborators need to see whom else a project is shared with.",
		Tags:        []string{"sharing"},
	}, func(ctx context.Context, in *sharingListInput) (*sharingListOutput, error) {
		out := &sharingListOutput{}
		if s == nil {
			out.Body.Shares = []sharingShareOut{}
			return out, nil
		}
		ident, _ := auth.IdentityFrom(ctx)
		doc, err := s.readSharing(ctx, ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("sharing: read", err)
		}
		out.Body.Shares = shareDocToOut(doc)
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "upsert-sharing",
		Method:      "POST",
		Path:        "/api/projects/{name}/sharing",
		Summary:     "Invite or update a share entry",
		Description: "Adds a new ACL entry or replaces the role of an existing one. Only the project owner may mutate the ACL ; the first caller of a mutating endpoint becomes the owner.",
		Tags:        []string{"sharing"},
	}, func(ctx context.Context, in *sharingUpsertInput) (*sharingListOutput, error) {
		out := &sharingListOutput{}
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)

		user := strings.TrimSpace(in.Body.User)
		role := strings.TrimSpace(in.Body.Role)
		if user == "" {
			return nil, huma.Error400BadRequest("sharing: missing user")
		}
		if !validRoles[role] {
			return nil, huma.Error400BadRequest(fmt.Sprintf("sharing: unknown role %q (want editor|commenter|viewer)", role))
		}

		if err := s.requireOwner(ctx, ident, in.Project); err != nil {
			return nil, err
		}

		doc, err := s.readSharing(ctx, ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("sharing: read", err)
		}
		// Idempotent upsert : overwrite role if user already listed,
		// otherwise append.
		found := false
		for i := range doc.Shares {
			if strings.EqualFold(doc.Shares[i].User, user) {
				doc.Shares[i].Role = role
				found = true
				break
			}
		}
		if !found {
			doc.Shares = append(doc.Shares, share{User: user, Role: role})
		}
		if err := s.writeSharing(ctx, ident, in.Project, doc); err != nil {
			return nil, huma.Error500InternalServerError("sharing: write", err)
		}
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "sharing", Verb: "upsert",
			Project: in.Project,
			Fields:  map[string]any{"user": user, "role": role},
		})
		out.Body.Shares = shareDocToOut(doc)
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "delete-sharing",
		Method:        "DELETE",
		Path:          "/api/projects/{name}/sharing/{user}",
		Summary:       "Remove a share entry",
		Description:   "Idempotent : returns 204 whether or not the user was on the ACL. Only the project owner may mutate.",
		Tags:          []string{"sharing"},
		DefaultStatus: 204,
	}, func(ctx context.Context, in *sharingDeleteInput) (*sharingDeleteOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		user := strings.TrimSpace(in.User)
		if user == "" {
			return nil, huma.Error400BadRequest("sharing: missing user in path")
		}

		if err := s.requireOwner(ctx, ident, in.Project); err != nil {
			return nil, err
		}

		doc, err := s.readSharing(ctx, ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("sharing: read", err)
		}
		out := doc.Shares[:0]
		removed := false
		for _, sh := range doc.Shares {
			if strings.EqualFold(sh.User, user) {
				removed = true
				continue
			}
			out = append(out, sh)
		}
		doc.Shares = out
		if err := s.writeSharing(ctx, ident, in.Project, doc); err != nil {
			return nil, huma.Error500InternalServerError("sharing: write", err)
		}
		if removed {
			s.events.Publish(eventbus.Event{
				Source: "server", Component: "sharing", Verb: "delete",
				Project: in.Project,
				Fields:  map[string]any{"user": user},
			})
		}
		return &sharingDeleteOutput{Status: 204}, nil
	})
}
