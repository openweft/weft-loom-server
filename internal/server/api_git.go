package server

// api_git.go : REST surface for per-project git sync. V0.3 ships
// STUB handlers that read + write a JSON config blob next to the
// project's working tree but don't yet drive go-git. The UI is
// fully testable against this surface ; the real clone / pull /
// push wiring (github.com/go-git/go-git/v5) lands in V0.3.x.
//
// The shape mirrors lib/git.ts on the client side so the typed
// helpers stay in lock-step.

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// gitConfig carries the remote + credentials for a project. The
// token field is write-only — handleGitStatus zeros it before
// returning the struct to the browser.
type gitConfig struct {
	Provider  string `json:"provider"`
	RemoteURL string `json:"remote_url"`
	Branch    string `json:"branch"`
	Token     string `json:"token,omitempty"`
}

type gitChange struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type gitStatus struct {
	Configured   bool        `json:"configured"`
	Provider     string      `json:"provider"`
	RemoteURL    string      `json:"remote_url"`
	Branch       string      `json:"branch"`
	Ahead        int         `json:"ahead"`
	Behind       int         `json:"behind"`
	Changes      []gitChange `json:"changes"`
	LastSyncUnix int64       `json:"last_sync_unix,omitempty"`
	LastError    string      `json:"last_error,omitempty"`
}

// gitState is the in-memory persistence shim for V0.3. A real impl
// would write through the project store ; we use a sync.Map keyed
// on (owner, project) so two tabs see the same config in-process
// without persisting yet. Config + last sync state survive process
// restart by being written to <storageRoot>/<owner>/<project>/.git-config.json
// on save.
type gitState struct {
	mu   sync.Mutex
	cfg  map[string]gitConfig
	last map[string]gitStatus
}

func newGitState() *gitState {
	return &gitState{
		cfg:  map[string]gitConfig{},
		last: map[string]gitStatus{},
	}
}

func gitKey(ident auth.Identity, project string) string {
	return ident.Subject + "\x00" + project
}

// handleGitStatus returns the current status. When the project is
// not yet configured, returns { configured: false } so the UI shows
// the connect form instead of the sync controls.
func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	key := gitKey(ident, projectName(r))

	s.git.mu.Lock()
	cfg, hasCfg := s.git.cfg[key]
	last, hasLast := s.git.last[key]
	s.git.mu.Unlock()

	if !hasCfg {
		writeJSON(w, http.StatusOK, gitStatus{Configured: false, Provider: "github", Branch: "main", Changes: []gitChange{}})
		return
	}
	if hasLast {
		last.Configured = true
		last.Provider = cfg.Provider
		last.RemoteURL = cfg.RemoteURL
		last.Branch = cfg.Branch
		writeJSON(w, http.StatusOK, last)
		return
	}
	writeJSON(w, http.StatusOK, gitStatus{
		Configured: true,
		Provider:   cfg.Provider,
		RemoteURL:  cfg.RemoteURL,
		Branch:     cfg.Branch,
		Changes:    []gitChange{},
	})
}

// handleGitConfig stores the remote URL + branch + token for the
// project. The token is opaque to V0.3 ; future real-git wiring will
// hand it to go-git's BasicAuth.
func (s *Server) handleGitConfig(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	defer r.Body.Close()
	var cfg gitConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if cfg.RemoteURL == "" {
		http.Error(w, "remote_url is required", http.StatusBadRequest)
		return
	}
	if cfg.Branch == "" {
		cfg.Branch = "main"
	}
	if cfg.Provider == "" {
		cfg.Provider = "generic"
	}
	key := gitKey(ident, projectName(r))
	s.git.mu.Lock()
	s.git.cfg[key] = cfg
	s.git.mu.Unlock()

	// Persist a sidecar config file under the project root so a
	// process restart picks the config up again. Token is included
	// — production should encrypt this at rest, V0.3 leaves it
	// plaintext + relies on filesystem permissions.
	if root := s.projectStorageRoot(); root != "" {
		dir := filepath.Join(root, sanitiseFor(ident.Subject), sanitiseFor(projectName(r)))
		_ = writeConfigSidecar(dir, cfg)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleGitClone : V0.3 stub. Records the config and returns a
// "freshly cloned" status. Real impl will (1) wipe the working tree,
// (2) go-git Clone with BasicAuth, (3) re-list files for the UI.
func (s *Server) handleGitClone(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	defer r.Body.Close()
	var cfg gitConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if cfg.Branch == "" {
		cfg.Branch = "main"
	}
	key := gitKey(ident, projectName(r))

	s.git.mu.Lock()
	s.git.cfg[key] = cfg
	st := gitStatus{
		Configured:   true,
		Provider:     cfg.Provider,
		RemoteURL:    cfg.RemoteURL,
		Branch:       cfg.Branch,
		Ahead:        0,
		Behind:       0,
		Changes:      []gitChange{},
		LastSyncUnix: time.Now().Unix(),
		LastError:    "V0.3 stub : go-git wiring not yet implemented — config saved, no actual clone happened",
	}
	s.git.last[key] = st
	s.git.mu.Unlock()
	writeJSON(w, http.StatusOK, st)
}

// handleGitPull : V0.3 stub. Returns a "successful pull" status.
// Real impl will go-git Fetch + Merge fast-forward + re-list files.
func (s *Server) handleGitPull(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	key := gitKey(ident, projectName(r))
	s.git.mu.Lock()
	cfg, ok := s.git.cfg[key]
	if !ok {
		s.git.mu.Unlock()
		http.Error(w, "git not configured", http.StatusBadRequest)
		return
	}
	st := gitStatus{
		Configured:   true,
		Provider:     cfg.Provider,
		RemoteURL:    cfg.RemoteURL,
		Branch:       cfg.Branch,
		Changes:      []gitChange{},
		LastSyncUnix: time.Now().Unix(),
		LastError:    "V0.3 stub : pull is a no-op until go-git wires up",
	}
	s.git.last[key] = st
	s.git.mu.Unlock()
	writeJSON(w, http.StatusOK, st)
}

// handleGitPush : V0.3 stub. Returns a "successful push" status.
func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	key := gitKey(ident, projectName(r))
	s.git.mu.Lock()
	cfg, ok := s.git.cfg[key]
	if !ok {
		s.git.mu.Unlock()
		http.Error(w, "git not configured", http.StatusBadRequest)
		return
	}
	st := gitStatus{
		Configured:   true,
		Provider:     cfg.Provider,
		RemoteURL:    cfg.RemoteURL,
		Branch:       cfg.Branch,
		Changes:      []gitChange{},
		LastSyncUnix: time.Now().Unix(),
		LastError:    "V0.3 stub : push is a no-op until go-git wires up",
	}
	s.git.last[key] = st
	s.git.mu.Unlock()
	writeJSON(w, http.StatusOK, st)
}
