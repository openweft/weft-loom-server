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

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"

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
func (s *Server) readSharing(r *http.Request, ident auth.Identity, project string) (shareDoc, error) {
	rc, err := s.opts.Projects.ReadFile(r.Context(), ident, project, sharingSidecarPath)
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
func (s *Server) writeSharing(r *http.Request, ident auth.Identity, project string, doc shareDoc) error {
	if doc.Shares == nil {
		doc.Shares = []share{}
	}
	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return s.opts.Projects.WriteFile(r.Context(), ident, project, sharingSidecarPath, strings.NewReader(string(body)))
}

// ownerOf reads <project>/.weft-loom/owner. Returns "" + nil when
// the file is absent so callers can fall back to "first caller wins".
func (s *Server) ownerOf(r *http.Request, ident auth.Identity, project string) (string, error) {
	rc, err := s.opts.Projects.ReadFile(r.Context(), ident, project, sharingOwnerPath)
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
// Returns false + having written an error response when the check
// fails ; true means the caller is OK to proceed.
func (s *Server) requireOwner(w http.ResponseWriter, r *http.Request, ident auth.Identity, project string) bool {
	owner, err := s.ownerOf(r, ident, project)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return false
	}
	if owner == "" {
		// First mutator wins : pin ident as the owner.
		if werr := s.opts.Projects.WriteFile(r.Context(), ident, project, sharingOwnerPath, strings.NewReader(ident.Subject+"\n")); werr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": werr.Error()})
			return false
		}
		return true
	}
	if owner != ident.Subject {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "sharing: only the project owner may modify ACL"})
		return false
	}
	return true
}

func (s *Server) handleSharingList(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	proj := projectName(r)
	doc, err := s.readSharing(r, ident, proj)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) handleSharingUpsert(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	proj := projectName(r)

	var in share
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	in.User = strings.TrimSpace(in.User)
	in.Role = strings.TrimSpace(in.Role)
	if in.User == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sharing: missing user"})
		return
	}
	if !validRoles[in.Role] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("sharing: unknown role %q (want editor|commenter|viewer)", in.Role)})
		return
	}

	if !s.requireOwner(w, r, ident, proj) {
		return
	}

	doc, err := s.readSharing(r, ident, proj)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Idempotent upsert : overwrite role if user already listed,
	// otherwise append.
	found := false
	for i := range doc.Shares {
		if strings.EqualFold(doc.Shares[i].User, in.User) {
			doc.Shares[i].Role = in.Role
			found = true
			break
		}
	}
	if !found {
		doc.Shares = append(doc.Shares, in)
	}
	if err := s.writeSharing(r, ident, proj, doc); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "sharing", Verb: "upsert",
		Project: proj,
		Fields:  map[string]any{"user": in.User, "role": in.Role},
	})
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) handleSharingDelete(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	proj := projectName(r)
	user := strings.TrimSpace(r.PathValue("user"))
	if user == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sharing: missing user in path"})
		return
	}

	if !s.requireOwner(w, r, ident, proj) {
		return
	}

	doc, err := s.readSharing(r, ident, proj)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
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
	if err := s.writeSharing(r, ident, proj, doc); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if removed {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "sharing", Verb: "delete",
			Project: proj,
			Fields:  map[string]any{"user": user},
		})
	}
	w.WriteHeader(http.StatusNoContent)
}
