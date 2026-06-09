package server

// api_git.go : REST surface for per-project git sync. Real go-git
// wiring : every endpoint drives github.com/go-git/go-git/v5 against
// the project's working tree under <storageRoot>/<owner>/<project>.
//
// Config + token persist as a sidecar .git-config.json next to the
// project dir ; the token isn't echoed back to clients.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	gitobject "github.com/go-git/go-git/v5/plumbing/object"
	gittransport "github.com/go-git/go-git/v5/plumbing/transport"
	gitauth "github.com/go-git/go-git/v5/plumbing/transport/http"

	"github.com/openweft/weft-loom-server/internal/auth"
)

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

// gitState memoises the per-(owner, project) config + last sync time
// in-memory + reads/writes the sidecar .git-config.json so the data
// survives a process restart. The mutex serialises every config /
// sync mutation per project — go-git operations themselves aren't
// safe to call concurrently against the same working tree.
type gitState struct {
	mu   sync.Mutex
	last map[string]gitStatus // (owner|project) → last sync status
}

func newGitState() *gitState {
	return &gitState{last: map[string]gitStatus{}}
}

func gitKey(ident auth.Identity, project string) string {
	return ident.Subject + "\x00" + project
}

// projectWorkingDir is the absolute path on the host where the
// project's working tree lives. Mirrors LocalStore's layout :
// <root>/<owner>/<project>.
func (s *Server) projectWorkingDir(ident auth.Identity, project string) (string, error) {
	root := s.projectStorageRoot()
	if root == "" {
		return "", fmt.Errorf("git: project store root not exposed (S3-only backend?)")
	}
	return filepath.Join(root, sanitiseFor(ident.Subject), sanitiseFor(project)), nil
}

// readConfig reads the sidecar .git-config.json from a project dir.
// Returns (config, ok) ; ok=false on any error (missing file or bad
// JSON), without escalating to handler-level failure — the UI treats
// an unconfigured project as a connect-form prompt anyway.
func readConfig(dir string) (gitConfig, bool) {
	b, err := os.ReadFile(filepath.Join(dir, ".git-config.json"))
	if err != nil {
		return gitConfig{}, false
	}
	var c gitConfig
	if err := json.Unmarshal(b, &c); err != nil {
		return gitConfig{}, false
	}
	if c.Provider == "" {
		c.Provider = "generic"
	}
	if c.Branch == "" {
		c.Branch = "main"
	}
	return c, true
}

// authMethod : every provider we support (GitHub / GitLab / Forgejo
// / generic HTTPS) accepts PAT-style tokens via BasicAuth(user,
// token). The username can be anything but isn't allowed to be
// empty by some backends ; "git" is the conventional placeholder.
func authMethod(c gitConfig) gittransport.AuthMethod {
	if c.Token == "" {
		return nil
	}
	user := "git"
	if c.Provider == "gitlab" {
		// GitLab is picky about the username when using PAT — must
		// be "oauth2" for PATs created with api scope. "git" works
		// for deploy tokens.
		user = "oauth2"
	}
	return &gitauth.BasicAuth{Username: user, Password: c.Token}
}

// computeStatus reads the working tree + remote refs and reports
// ahead/behind + the list of changed files.
func computeStatus(repo *git.Repository, branch string) ([]gitChange, int, int, error) {
	wt, err := repo.Worktree()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("worktree: %w", err)
	}
	st, err := wt.Status()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("status: %w", err)
	}
	var changes []gitChange
	for p, fs := range st {
		s := classify(fs.Worktree, fs.Staging)
		changes = append(changes, gitChange{Path: p, Status: s})
	}

	ahead, behind := 0, 0
	if branch != "" {
		local, err := repo.Reference(plumbing.NewBranchReferenceName(branch), true)
		if err == nil {
			remote, err2 := repo.Reference(plumbing.NewRemoteReferenceName("origin", branch), true)
			if err2 == nil {
				ahead, behind = countAheadBehind(repo, local.Hash(), remote.Hash())
			}
		}
	}
	return changes, ahead, behind, nil
}

// classify maps go-git's two-char status to a single human-friendly
// label the UI badge can read.
func classify(work, stage git.StatusCode) string {
	switch {
	case work == git.Untracked:
		return "untracked"
	case work == git.Deleted, stage == git.Deleted:
		return "deleted"
	case work == git.Modified, stage == git.Modified:
		return "modified"
	case stage == git.Added, stage == git.Renamed, stage == git.Copied:
		return "staged"
	}
	return "modified"
}

// countAheadBehind walks the commit graph from local + remote tips
// to compute the divergence. Best-effort : a missing or shallow
// history yields zeros without error so the UI doesn't surface a
// scary banner.
func countAheadBehind(repo *git.Repository, local, remote plumbing.Hash) (int, int) {
	if local == remote {
		return 0, 0
	}
	merge, err := mergeBase(repo, local, remote)
	if err != nil {
		return 0, 0
	}
	ahead, _ := countSince(repo, local, merge)
	behind, _ := countSince(repo, remote, merge)
	return ahead, behind
}

func mergeBase(repo *git.Repository, a, b plumbing.Hash) (plumbing.Hash, error) {
	ca, err := repo.CommitObject(a)
	if err != nil {
		return plumbing.ZeroHash, err
	}
	cb, err := repo.CommitObject(b)
	if err != nil {
		return plumbing.ZeroHash, err
	}
	bases, err := ca.MergeBase(cb)
	if err != nil || len(bases) == 0 {
		return plumbing.ZeroHash, fmt.Errorf("no merge base")
	}
	return bases[0].Hash, nil
}

func countSince(repo *git.Repository, head, base plumbing.Hash) (int, error) {
	iter, err := repo.Log(&git.LogOptions{From: head})
	if err != nil {
		return 0, err
	}
	defer iter.Close()
	count := 0
	err = iter.ForEach(func(c *gitobject.Commit) error {
		if c.Hash == base {
			return storerStop
		}
		count++
		return nil
	})
	if err != nil && !errors.Is(err, storerStop) {
		return count, err
	}
	return count, nil
}

var storerStop = errors.New("stop")

// ------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------

func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	cfg, hasCfg := readConfig(dir)
	if !hasCfg {
		writeJSON(w, http.StatusOK, gitStatus{Configured: false, Provider: "github", Branch: "main", Changes: []gitChange{}})
		return
	}
	out := gitStatus{
		Configured: true,
		Provider:   cfg.Provider,
		RemoteURL:  cfg.RemoteURL,
		Branch:     cfg.Branch,
		Changes:    []gitChange{},
	}
	// last sync timestamp survives via the gitState memo, not the
	// sidecar (mtime would be fine but explicit field is clearer).
	s.git.mu.Lock()
	if last, ok := s.git.last[gitKey(ident, projectName(r))]; ok {
		out.LastSyncUnix = last.LastSyncUnix
		out.LastError = last.LastError
	}
	s.git.mu.Unlock()

	repo, err := git.PlainOpen(dir)
	if err != nil {
		// Configured but not yet cloned : surface that to the UI
		// as a soft warning instead of an error.
		out.LastError = "configured but no working tree yet — run clone"
		writeJSON(w, http.StatusOK, out)
		return
	}
	changes, ahead, behind, statErr := computeStatus(repo, cfg.Branch)
	if statErr != nil {
		out.LastError = statErr.Error()
	} else {
		out.Changes = changes
		out.Ahead = ahead
		out.Behind = behind
	}
	writeJSON(w, http.StatusOK, out)
}

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
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := writeConfigSidecar(dir, cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

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
	if cfg.Provider == "" {
		cfg.Provider = "generic"
	}
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	key := gitKey(ident, projectName(r))
	s.git.mu.Lock()
	defer s.git.mu.Unlock()

	// Wipe any existing working tree under this project name so a
	// fresh clone starts from a known-empty dir. The user already
	// knows that "Clone" replaces local state.
	if _, err := os.Stat(dir); err == nil {
		if err := os.RemoveAll(dir); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "wipe working tree: " + err.Error()})
			return
		}
	}
	if err := writeConfigSidecar(dir, cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	_, err = git.PlainCloneContext(r.Context(), dir, false, &git.CloneOptions{
		URL:           cfg.RemoteURL,
		ReferenceName: plumbing.NewBranchReferenceName(cfg.Branch),
		SingleBranch:  false,
		Auth:          authMethod(cfg),
	})
	out := gitStatus{
		Configured:   true,
		Provider:     cfg.Provider,
		RemoteURL:    cfg.RemoteURL,
		Branch:       cfg.Branch,
		Changes:      []gitChange{},
		LastSyncUnix: time.Now().Unix(),
	}
	if err != nil {
		out.LastError = err.Error()
	}
	s.git.last[key] = out
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGitPull(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	cfg, ok := readConfig(dir)
	if !ok {
		http.Error(w, "git not configured", http.StatusBadRequest)
		return
	}
	repo, err := git.PlainOpen(dir)
	if err != nil {
		http.Error(w, "no working tree (run clone first)", http.StatusBadRequest)
		return
	}
	wt, err := repo.Worktree()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	key := gitKey(ident, projectName(r))
	s.git.mu.Lock()
	defer s.git.mu.Unlock()

	pullErr := wt.PullContext(r.Context(), &git.PullOptions{
		RemoteName:    "origin",
		ReferenceName: plumbing.NewBranchReferenceName(cfg.Branch),
		Auth:          authMethod(cfg),
		Force:         false,
	})
	// "already up-to-date" isn't a failure for the user.
	if pullErr != nil && !errors.Is(pullErr, git.NoErrAlreadyUpToDate) {
		s.git.last[key] = gitStatus{
			Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
			Changes: []gitChange{}, LastSyncUnix: time.Now().Unix(),
			LastError: "pull: " + pullErr.Error(),
		}
		writeJSON(w, http.StatusOK, s.git.last[key])
		return
	}
	changes, ahead, behind, _ := computeStatus(repo, cfg.Branch)
	out := gitStatus{
		Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
		Changes: changes, Ahead: ahead, Behind: behind,
		LastSyncUnix: time.Now().Unix(),
	}
	s.git.last[key] = out
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	cfg, ok := readConfig(dir)
	if !ok {
		http.Error(w, "git not configured", http.StatusBadRequest)
		return
	}
	repo, err := git.PlainOpen(dir)
	if err != nil {
		http.Error(w, "no working tree (run clone first)", http.StatusBadRequest)
		return
	}
	key := gitKey(ident, projectName(r))
	s.git.mu.Lock()
	defer s.git.mu.Unlock()

	// Auto-commit any pending changes before push — the editor
	// writes files to disk via /files PUT but never invokes git.
	// The commit author + email pull from the dex identity ; dev
	// mode falls back to a synthetic loom-dev address.
	if err := autoCommit(repo, ident); err != nil {
		s.git.last[key] = gitStatus{
			Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
			Changes: []gitChange{}, LastSyncUnix: time.Now().Unix(),
			LastError: "commit: " + err.Error(),
		}
		writeJSON(w, http.StatusOK, s.git.last[key])
		return
	}
	pushErr := repo.PushContext(r.Context(), &git.PushOptions{
		RemoteName: "origin",
		RefSpecs:   []config.RefSpec{config.RefSpec(fmt.Sprintf("refs/heads/%s:refs/heads/%s", cfg.Branch, cfg.Branch))},
		Auth:       authMethod(cfg),
	})
	if pushErr != nil && !errors.Is(pushErr, git.NoErrAlreadyUpToDate) {
		s.git.last[key] = gitStatus{
			Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
			Changes: []gitChange{}, LastSyncUnix: time.Now().Unix(),
			LastError: "push: " + pushErr.Error(),
		}
		writeJSON(w, http.StatusOK, s.git.last[key])
		return
	}
	changes, ahead, behind, _ := computeStatus(repo, cfg.Branch)
	out := gitStatus{
		Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
		Changes: changes, Ahead: ahead, Behind: behind,
		LastSyncUnix: time.Now().Unix(),
	}
	s.git.last[key] = out
	writeJSON(w, http.StatusOK, out)
}

// autoCommit stages every tracked + untracked change and commits if
// the tree is dirty. No-op when the tree is clean. Used by the push
// handler so the user doesn't have to remember to commit before
// hitting the sync button.
func autoCommit(repo *git.Repository, ident auth.Identity) error {
	wt, err := repo.Worktree()
	if err != nil {
		return err
	}
	st, err := wt.Status()
	if err != nil {
		return err
	}
	if st.IsClean() {
		return nil
	}
	if err := wt.AddWithOptions(&git.AddOptions{All: true}); err != nil {
		return fmt.Errorf("git add: %w", err)
	}
	name, email := commitIdent(ident)
	_, err = wt.Commit("weft-loom: auto-commit", &git.CommitOptions{
		Author: &gitobject.Signature{Name: name, Email: email, When: time.Now()},
	})
	return err
}

// commitIdent turns a dex identity into a git commit identity.
// Dev mode synthesises "loom-dev" ; production will read claimed
// name + email once auth.Identity carries those fields (today the
// minimal Identity is just Subject + Groups).
func commitIdent(ident auth.Identity) (string, string) {
	name := strings.TrimSpace(ident.Subject)
	if name == "" {
		name = "loom-dev"
	}
	email := name + "@weft.local"
	return name, email
}

// Unused but kept so the compiler doesn't drop context imports if a
// future revision shifts a handler to ctx-aware path.
var _ = context.Background
