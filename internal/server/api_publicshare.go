package server

// api_publicshare.go — owner-issued read-only public links.
//
// Owners create a random 32-char token (POST), revoke it (DELETE),
// or look it up (GET). Anyone with the URL `/public/<token>/...`
// reads the project's files without authenticating ; writes,
// comments, compiles, shells are NOT exposed on the public path.
//
// Storage : the sidecar `<project>/.weft-loom/public-share.json`
//
//	{ "token": "abc…", "created": "2026-06-14T10:00:00Z" }
//
// holds one token per project. Token→project lookup is an in-memory
// index built lazily on first use + kept in sync by POST / DELETE so
// every /public/ request stays O(1). On startup we'd scan all
// projects ; instead we scan on the first /public/ hit (or first
// admin call) which is amortised across the lifetime of the server.
//
// The /public/ handler synthesises a "public:<owner>" identity from
// the token→owner mapping so it can drive the existing
// project.Store.ReadFile/ListFiles without bypassing the store's
// owner check : it impersonates the owner just for reads.
//
// Wire shape :
//
//	POST   /api/projects/{name}/public-share        → { token, url }
//	DELETE /api/projects/{name}/public-share        → 204
//	GET    /api/projects/{name}/public-share        → { token, url, created } | 404
//	GET    /public/{token}/files                    → { items: [{path,size,dir}] }
//	GET    /public/{token}/files/{path...}          → octet-stream

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

// publicShareSidecar is the directory + filename under each project
// that holds the share record. Exposed as a var so a future revision
// can move it (or tests can swap it).
const (
	publicShareDir  = ".weft-loom"
	publicShareFile = "public-share.json"
)

// publicHidePrefixes lists path prefixes never served on the public
// /public/{token}/files endpoints, regardless of who shared the
// project. Stricter than exportSkip because anyone with the URL can
// browse — leaking .git/ would expose commit author emails + the
// full revision history, which a public share link is NOT meant to
// carry. Project owners who want history+code shipped together
// should use the authed `export.zip` endpoint instead.
var publicHidePrefixes = []string{
	publicShareDir + "/", // sidecars (including the token itself)
	publicShareDir,       // exact match on the dir
	".git/",              // entire git working tree
	".git",
}

// publicHidden reports whether path is excluded from public reads.
func publicHidden(path string) bool {
	for _, p := range publicHidePrefixes {
		if path == p || strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// publicShareRecord is the on-disk envelope.
type publicShareRecord struct {
	Token   string `json:"token"`
	Created string `json:"created"`
}

// publicShareIndex maps token → (owner subject, project name). Built
// lazily on the first lookup ; kept in sync as POST / DELETE land.
type publicShareIndex struct {
	mu     sync.RWMutex
	loaded bool
	byTok  map[string]publicShareTarget
}

type publicShareTarget struct {
	Owner   string // sanitised filesystem name = subdir under the store root
	Project string
}

// publicShareRegistry is the process-wide index, keyed by *Server so
// each Server instance gets its own state. Using a package-level
// map (guarded by a mutex) instead of a Server field lets us add
// this surface without modifying server.go — the constraint of the
// "NEW FILES ONLY" task scope.
var (
	publicShareRegistryMu sync.Mutex
	publicShareRegistry   = map[*Server]*publicShareIndex{}
)

// publicShares returns the lazily-initialised index, building it
// from disk on first call. The index is per-server so multiple
// servers sharing a single filesystem root would each rebuild on
// startup — fine for V0.1 (one loom-server per project root).
func (s *Server) publicShares() *publicShareIndex {
	publicShareRegistryMu.Lock()
	defer publicShareRegistryMu.Unlock()
	if idx, ok := publicShareRegistry[s]; ok {
		return idx
	}
	idx := &publicShareIndex{byTok: map[string]publicShareTarget{}}
	publicShareRegistry[s] = idx
	return idx
}

// ensureLoaded scans every <root>/<owner>/<project>/.weft-loom/public-share.json
// once + populates the index. No-op after the first call.
func (idx *publicShareIndex) ensureLoaded(root string) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	if idx.loaded {
		return
	}
	idx.loaded = true
	if root == "" {
		return
	}
	owners, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, o := range owners {
		if !o.IsDir() {
			continue
		}
		ownerDir := filepath.Join(root, o.Name())
		projects, err := os.ReadDir(ownerDir)
		if err != nil {
			continue
		}
		for _, p := range projects {
			if !p.IsDir() {
				continue
			}
			rec, ok := readPublicShare(filepath.Join(ownerDir, p.Name()))
			if !ok || rec.Token == "" {
				continue
			}
			idx.byTok[rec.Token] = publicShareTarget{Owner: o.Name(), Project: p.Name()}
		}
	}
}

// lookup returns the owner+project bound to a token. The boolean is
// false on unknown tokens.
func (idx *publicShareIndex) lookup(token string) (publicShareTarget, bool) {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	t, ok := idx.byTok[token]
	return t, ok
}

// set / clear keep the in-memory map in sync after POST / DELETE.
func (idx *publicShareIndex) set(token string, tgt publicShareTarget) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	idx.byTok[token] = tgt
}
func (idx *publicShareIndex) clear(token string) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	delete(idx.byTok, token)
}

// readPublicShare reads the sidecar file. Returns (rec, true) when
// the file exists + parses ; (zero, false) on any error.
func readPublicShare(projectDir string) (publicShareRecord, bool) {
	b, err := os.ReadFile(filepath.Join(projectDir, publicShareDir, publicShareFile))
	if err != nil {
		return publicShareRecord{}, false
	}
	var rec publicShareRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return publicShareRecord{}, false
	}
	return rec, true
}

// writePublicShare creates the sidecar dir + writes the record.
func writePublicShare(projectDir string, rec publicShareRecord) error {
	dir := filepath.Join(projectDir, publicShareDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, publicShareFile), b, 0o644)
}

// removePublicShare deletes the sidecar. Idempotent on missing files.
func removePublicShare(projectDir string) error {
	path := filepath.Join(projectDir, publicShareDir, publicShareFile)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// randomToken returns 32 hex characters (16 bytes of entropy). Plenty
// of brute-force resistance ; short enough to fit in a sharable URL.
func randomToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// publicShareInput identifies the target project via the {name} path
// segment. Shared across the 3 admin huma operations.
type publicShareInput struct {
	Project string `path:"name" doc:"Project name (filesystem-safe identifier)"`
}

// publicShareOut is the JSON envelope returned by POST + GET.
type publicShareOut struct {
	Body struct {
		Token   string `json:"token" doc:"32-character hex share token"`
		URL     string `json:"url" doc:"Shareable URL path (/public/<token>)"`
		Created string `json:"created" doc:"RFC3339 timestamp the token was issued"`
	}
}

// publicShareDeleteOut models a 204 No Content response.
type publicShareDeleteOut struct {
	Status int
}

// mountPublicShareAdminAPI wires the 3 owner-authenticated public-share
// admin endpoints onto huma. The 2 public /public/{token}/... routes
// stay on raw mux (binary streaming + no-auth — they don't fit huma's
// typed model). The 3 admin ops :
//
//	POST   /api/projects/{name}/public-share  → { token, url, created }
//	GET    /api/projects/{name}/public-share  → { token, url, created } | 404
//	DELETE /api/projects/{name}/public-share  → 204
//
// All reuse the existing helpers (publicShareSidecar, ensureLoaded,
// resolvePublic) — only the I/O envelope changes.
func mountPublicShareAdminAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "create-public-share",
		Method:      "POST",
		Path:        "/api/projects/{name}/public-share",
		Summary:     "Issue (or rotate) a public-share token for the project",
		Description: "Generates a fresh 32-hex-char token + persists the sidecar. If a token already existed for this project it is replaced (the prior URL stops working). Returns the new token, its shareable URL, and the RFC3339 issue time.",
		Tags:        []string{"public-share"},
	}, func(ctx context.Context, in *publicShareInput) (*publicShareOut, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		dir, err := s.projectWorkingDir(ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("resolve project dir", err)
		}
		if _, statErr := os.Stat(dir); errors.Is(statErr, os.ErrNotExist) {
			return nil, huma.Error404NotFound("project not found")
		}
		// Make sure the index is hot so a rotation correctly evicts the
		// prior token from the lookup map.
		s.publicShares().ensureLoaded(s.projectStorageRoot())
		if prev, ok := readPublicShare(dir); ok && prev.Token != "" {
			s.publicShares().clear(prev.Token)
		}
		tok, err := randomToken()
		if err != nil {
			return nil, huma.Error500InternalServerError("randomToken", err)
		}
		rec := publicShareRecord{Token: tok, Created: time.Now().UTC().Format(time.RFC3339)}
		if err := writePublicShare(dir, rec); err != nil {
			return nil, huma.Error500InternalServerError("writePublicShare", err)
		}
		s.publicShares().set(tok, publicShareTarget{Owner: sanitiseFor(ident.Subject), Project: sanitiseFor(in.Project)})
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "publicshare", Verb: "create",
			Project: in.Project, Fields: map[string]any{"subject": ident.Subject},
		})
		out := &publicShareOut{}
		out.Body.Token = tok
		out.Body.URL = "/public/" + tok
		out.Body.Created = rec.Created
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-public-share",
		Method:      "GET",
		Path:        "/api/projects/{name}/public-share",
		Summary:     "Read the current public-share token for the project",
		Description: "Returns the token + shareable URL when one exists ; 404 when the project has no active share.",
		Tags:        []string{"public-share"},
	}, func(ctx context.Context, in *publicShareInput) (*publicShareOut, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		dir, err := s.projectWorkingDir(ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("resolve project dir", err)
		}
		rec, ok := readPublicShare(dir)
		if !ok || rec.Token == "" {
			return nil, huma.Error404NotFound("no public share")
		}
		out := &publicShareOut{}
		out.Body.Token = rec.Token
		out.Body.URL = "/public/" + rec.Token
		out.Body.Created = rec.Created
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "delete-public-share",
		Method:        "DELETE",
		Path:          "/api/projects/{name}/public-share",
		Summary:       "Revoke the public-share token for the project",
		Description:   "Removes the sidecar + drops the token from the in-memory index. Idempotent — returns 204 even when no share existed.",
		Tags:          []string{"public-share"},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *publicShareInput) (*publicShareDeleteOut, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		dir, err := s.projectWorkingDir(ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("resolve project dir", err)
		}
		if prev, ok := readPublicShare(dir); ok && prev.Token != "" {
			s.publicShares().clear(prev.Token)
		}
		if err := removePublicShare(dir); err != nil {
			return nil, huma.Error500InternalServerError("removePublicShare", err)
		}
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "publicshare", Verb: "revoke",
			Project: in.Project, Fields: map[string]any{"subject": ident.Subject},
		})
		return &publicShareDeleteOut{Status: http.StatusNoContent}, nil
	})
}

// publicToken pulls the {token} URL segment.
func publicToken(r *http.Request) string { return r.PathValue("token") }

// resolvePublic walks the token → (owner subject, project) mapping,
// reloads the index on a miss in case POST/DELETE landed on a peer
// server that shares the same filesystem root. Returns a synthesised
// auth.Identity representing the OWNER so the store's owner check
// passes — the public surface is intentionally a read-as-owner
// shim, NOT a bypass of authorization.
func (s *Server) resolvePublic(token string) (auth.Identity, string, bool) {
	idx := s.publicShares()
	idx.ensureLoaded(s.projectStorageRoot())
	tgt, ok := idx.lookup(token)
	if !ok {
		// One reload attempt in case a fresh share landed via another
		// admin path (or, in tests, a sidecar was written directly).
		idx.mu.Lock()
		idx.loaded = false
		idx.byTok = map[string]publicShareTarget{}
		idx.mu.Unlock()
		idx.ensureLoaded(s.projectStorageRoot())
		tgt, ok = idx.lookup(token)
		if !ok {
			return auth.Identity{}, "", false
		}
	}
	// The owner directory name IS the sanitised subject. We can't
	// recover the original subject string, but the store keys by
	// the sanitised form so re-passing it as Subject hits the same
	// path. (LocalStore.sanitise is idempotent on already-sanitised
	// input.)
	return auth.Identity{Subject: tgt.Owner}, tgt.Project, true
}

// handlePublicListFiles returns the file tree for a public-shared
// project. No bearer required ; the token IS the credential.
func (s *Server) handlePublicListFiles(w http.ResponseWriter, r *http.Request) {
	ident, proj, ok := s.resolvePublic(publicToken(r))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown share token"})
		return
	}
	files, err := s.opts.Projects.ListFiles(r.Context(), ident, proj)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]map[string]any, 0, len(files))
	for _, f := range files {
		if publicHidden(f.Path) {
			continue
		}
		out = append(out, map[string]any{
			"path": f.Path,
			"size": f.Size,
			"dir":  f.Dir,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// handlePublicReadFile streams one file. Same sidecar hide as the
// listing.
func (s *Server) handlePublicReadFile(w http.ResponseWriter, r *http.Request) {
	ident, proj, ok := s.resolvePublic(publicToken(r))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown share token"})
		return
	}
	path := r.PathValue("path")
	if publicHidden(path) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	rc, err := s.opts.Projects.ReadFile(r.Context(), ident, proj, path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	if _, err := io.Copy(w, rc); err != nil {
		// Client disconnected mid-stream ; log + swallow.
		if s.opts.Logger != nil {
			s.opts.Logger.Debug("publicshare: stream interrupted", "err", err.Error())
		}
	}
}

// fmtErr keeps fmt in the import set when the file shrinks.
var _ = fmt.Sprintf
