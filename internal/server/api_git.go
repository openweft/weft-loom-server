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
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	gitobject "github.com/go-git/go-git/v5/plumbing/object"
	gittransport "github.com/go-git/go-git/v5/plumbing/transport"
	gitclient "github.com/go-git/go-git/v5/plumbing/transport/client"
	gitauth "github.com/go-git/go-git/v5/plumbing/transport/http"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// init installs an SSRF-safe http.Client as go-git's default HTTP
// transport. The Dialer resolves the hostname once, checks each IP
// against checkRemoteIP, then dials the *resolved* address — closing
// the TOCTOU window between the request-time check and the actual
// connect. Without this, a DNS server controlled by the attacker can
// return a public IP to the validator and 127.0.0.1 to go-git.
func init() {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := (&net.Resolver{}).LookupIP(ctx, "ip", host)
			if err != nil {
				return nil, err
			}
			var firstErr error
			for _, ip := range ips {
				if err := checkRemoteIP(ip); err != nil {
					if firstErr == nil {
						firstErr = err
					}
					continue
				}
				d := &net.Dialer{Timeout: 30 * time.Second}
				conn, derr := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if derr == nil {
					return conn, nil
				}
				if firstErr == nil {
					firstErr = derr
				}
			}
			if firstErr == nil {
				firstErr = fmt.Errorf("git: no usable IP for %s", host)
			}
			return nil, firstErr
		},
		IdleConnTimeout:       60 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Minute}
	gitclient.InstallProtocol("https", gitauth.NewClient(client))
	gitclient.InstallProtocol("http", gitauth.NewClient(client))
}

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
//
// pushTimers carries one debounced auto-push timer per project ;
// every file write (handleWriteFile / handleDeleteFile) resets the
// timer to autoPushIdle seconds. When the timer fires the project is
// auto-committed + auto-pushed in a background goroutine so the
// user doesn't need to click anything between bursts of edits.
type gitState struct {
	mu         sync.Mutex
	last       map[string]gitStatus // (owner|project) → last sync status
	pushTimers map[string]*time.Timer
}

// autoPushIdle is how long the server waits after the last file
// write before kicking off an auto-commit + push. Pick big enough
// that a save → edit → save run doesn't fire two pushes in a
// second, small enough that a leaving user's last save makes it to
// the remote before their browser closes the WS.
const autoPushIdle = 5 * time.Second

func newGitState() *gitState {
	return &gitState{
		last:       map[string]gitStatus{},
		pushTimers: map[string]*time.Timer{},
	}
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

// validateRemoteURL guards the git clone/pull/push handlers against
// SSRF. The user controls cfg.RemoteURL ; without this check they
// could point the server at internal services (the AWS / Hetzner
// metadata endpoints, the embedded NATS broker, a co-tenant's
// loom-server on the same subnet, …).
//
// Rules :
//   - scheme must be one of ssh / git / https (or http when
//     AllowPlainHTTP is set, intended for forgejo-on-an-internal-CA
//     deployments)
//   - host must resolve to publicly-routable IPs only ; we reject
//     loopback, RFC1918, link-local, and the cloud metadata IP
//     (169.254.169.254)
//   - HostBlocklist (config) wins on top
func (s *Server) validateRemoteURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("git: remote URL required")
	}
	// scp-style "git@github.com:user/repo.git" → treat as ssh.
	if i := strings.Index(raw, "@"); i > 0 && !strings.Contains(raw[:i], "/") && !strings.Contains(raw, "://") {
		host := raw[i+1:]
		if c := strings.Index(host, ":"); c > 0 {
			host = host[:c]
		}
		return s.checkRemoteHost(host)
	}
	u, err := url.ParseRequestURI(raw)
	if err != nil {
		return fmt.Errorf("git: bad remote URL: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "https", "ssh", "git":
		// allowed
	case "http":
		if !s.opts.Config.Git.AllowPlainHTTP {
			return fmt.Errorf("git: scheme %q requires AllowPlainHTTP", u.Scheme)
		}
	default:
		return fmt.Errorf("git: unsupported scheme %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("git: remote URL missing host")
	}
	return s.checkRemoteHost(host)
}

// checkRemoteHost rejects hosts in the blocklist or whose resolved
// IPs fall into private / loopback / link-local / cloud-metadata
// ranges. DNS rebinding is partially mitigated by failing closed on
// any private IP in the response set (a single private answer is
// enough).
func (s *Server) checkRemoteHost(host string) error {
	host = strings.ToLower(host)
	for _, blocked := range s.opts.Config.Git.HostBlocklist {
		if strings.EqualFold(strings.TrimSpace(blocked), host) {
			return fmt.Errorf("git: host %q is blocked", host)
		}
	}
	// Literal IP : check directly. Hostname : resolve + check each.
	if ip := net.ParseIP(host); ip != nil {
		return checkRemoteIP(ip)
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("git: resolve %q: %w", host, err)
	}
	for _, ip := range ips {
		if err := checkRemoteIP(ip); err != nil {
			return err
		}
	}
	return nil
}

func checkRemoteIP(ip net.IP) error {
	// Normalise IPv4-mapped IPv6 ("::ffff:1.2.3.4") to its v4 form
	// before the equality / range checks ; ip.IsPrivate / IsLoopback
	// already DTRT for that input but the explicit 169.254.169.254
	// compare below uses net.IPv4 which is a 4-byte form.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	switch {
	case ip.IsLoopback():
		return fmt.Errorf("git: refusing loopback IP %s", ip)
	case ip.IsPrivate():
		return fmt.Errorf("git: refusing private IP %s", ip)
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		return fmt.Errorf("git: refusing link-local IP %s", ip)
	case ip.IsInterfaceLocalMulticast(), ip.IsMulticast():
		return fmt.Errorf("git: refusing multicast IP %s", ip)
	case ip.IsUnspecified():
		return fmt.Errorf("git: refusing unspecified IP %s", ip)
	case ip.Equal(net.IPv4(169, 254, 169, 254)):
		return fmt.Errorf("git: refusing cloud metadata IP %s", ip)
	case isIPv6ULA(ip):
		return fmt.Errorf("git: refusing IPv6 ULA %s", ip)
	}
	return nil
}

// isIPv6ULA matches the fc00::/7 unique-local range. ip.IsPrivate
// covers it on Go 1.21+ but we keep the explicit check for clarity +
// older toolchains.
func isIPv6ULA(ip net.IP) bool {
	v6 := ip.To16()
	if v6 == nil || ip.To4() != nil {
		return false
	}
	return v6[0]&0xfe == 0xfc
}

// ------------------------------------------------------------------
// huma typed surface
//
// The six endpoints below flow through huma so the OpenAPI spec + the
// generated TS client cover them. Helpers (gitStatusFor, gitConfigFor,
// …) carry the actual go-git wiring and return (gitStatus, error) ;
// the huma operations are thin adapters that pull the identity from
// ctx, call the helper, and translate failures into huma.StatusError.
// ------------------------------------------------------------------

type gitStatusOutput struct {
	Body gitStatus
}

type gitProjectInput struct {
	Project string `path:"name" doc:"Project name"`
}

type gitConfigInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    gitConfig
}

type gitLogInput struct {
	Project string `path:"name" doc:"Project name"`
	Limit   int    `query:"limit" doc:"Maximum number of commits to return (1..1000)"`
}

type gitLogOutput struct {
	Body gitLogResponse
}

// gitStatusFor computes the status payload for (ident, project) ; used
// by both the GET /git/status op and the post-mutation responses on
// pull / push.
func (s *Server) gitStatusFor(ident auth.Identity, project string) (gitStatus, error) {
	dir, err := s.projectWorkingDir(ident, project)
	if err != nil {
		return gitStatus{}, err
	}
	cfg, hasCfg := readConfig(dir)
	if !hasCfg {
		return gitStatus{Configured: false, Provider: "github", Branch: "main", Changes: []gitChange{}}, nil
	}
	out := gitStatus{
		Configured: true,
		Provider:   cfg.Provider,
		RemoteURL:  cfg.RemoteURL,
		Branch:     cfg.Branch,
		Changes:    []gitChange{},
	}
	s.git.mu.Lock()
	if last, ok := s.git.last[gitKey(ident, project)]; ok {
		out.LastSyncUnix = last.LastSyncUnix
		out.LastError = last.LastError
	}
	s.git.mu.Unlock()

	repo, err := git.PlainOpen(dir)
	if err != nil {
		out.LastError = "configured but no working tree yet — run clone"
		return out, nil
	}
	changes, ahead, behind, statErr := computeStatus(repo, cfg.Branch)
	if statErr != nil {
		out.LastError = statErr.Error()
		return out, nil
	}
	if changes == nil {
		changes = []gitChange{}
	}
	out.Changes = changes
	out.Ahead = ahead
	out.Behind = behind
	return out, nil
}

// gitConfigSet validates + persists the sidecar. Returns the resulting
// gitStatus so the typed op can hand it back to the caller without a
// follow-up read.
func (s *Server) gitConfigSet(ident auth.Identity, project string, cfg gitConfig) (gitStatus, error) {
	if cfg.RemoteURL == "" {
		return gitStatus{}, huma.Error400BadRequest("remote_url is required")
	}
	if err := s.validateRemoteURL(cfg.RemoteURL); err != nil {
		return gitStatus{}, huma.Error400BadRequest(err.Error())
	}
	if cfg.Branch == "" {
		cfg.Branch = "main"
	}
	if cfg.Provider == "" {
		cfg.Provider = "generic"
	}
	dir, err := s.projectWorkingDir(ident, project)
	if err != nil {
		return gitStatus{}, huma.Error500InternalServerError("git: project dir", err)
	}
	if err := writeConfigSidecar(dir, cfg); err != nil {
		return gitStatus{}, huma.Error500InternalServerError("git: write config", err)
	}
	return s.gitStatusFor(ident, project)
}

// gitClone wipes + clones a fresh working tree from cfg.RemoteURL.
// Mirrors the legacy handler : returns a gitStatus carrying LastError
// on clone failure rather than a 500, so the UI can render the error
// inline.
func (s *Server) gitClone(ctx context.Context, ident auth.Identity, project string, cfg gitConfig) (gitStatus, error) {
	if err := s.validateRemoteURL(cfg.RemoteURL); err != nil {
		return gitStatus{}, huma.Error400BadRequest(err.Error())
	}
	if cfg.Branch == "" {
		cfg.Branch = "main"
	}
	if cfg.Provider == "" {
		cfg.Provider = "generic"
	}
	dir, err := s.projectWorkingDir(ident, project)
	if err != nil {
		return gitStatus{}, huma.Error500InternalServerError("git: project dir", err)
	}
	key := gitKey(ident, project)
	s.git.mu.Lock()
	defer s.git.mu.Unlock()

	if _, err := os.Stat(dir); err == nil {
		if err := os.RemoveAll(dir); err != nil {
			return gitStatus{}, huma.Error500InternalServerError("wipe working tree: " + err.Error())
		}
	}
	if err := writeConfigSidecar(dir, cfg); err != nil {
		return gitStatus{}, huma.Error500InternalServerError("git: write config", err)
	}
	_, cloneErr := git.PlainCloneContext(ctx, dir, false, &git.CloneOptions{
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
	if cloneErr != nil {
		out.LastError = cloneErr.Error()
	}
	s.git.last[key] = out
	return out, nil
}

// gitPull fetches + fast-forwards the configured branch. Same
// failure-encoding contract as gitClone : transient git errors land in
// LastError, not as HTTP errors.
func (s *Server) gitPull(ctx context.Context, ident auth.Identity, project string) (gitStatus, error) {
	dir, err := s.projectWorkingDir(ident, project)
	if err != nil {
		return gitStatus{}, huma.Error500InternalServerError("git: project dir", err)
	}
	cfg, ok := readConfig(dir)
	if !ok {
		return gitStatus{}, huma.Error400BadRequest("git not configured")
	}
	if err := s.validateRemoteURL(cfg.RemoteURL); err != nil {
		return gitStatus{}, huma.Error400BadRequest(err.Error())
	}
	repo, err := git.PlainOpen(dir)
	if err != nil {
		return gitStatus{}, huma.Error400BadRequest("no working tree (run clone first)")
	}
	wt, err := repo.Worktree()
	if err != nil {
		return gitStatus{}, huma.Error500InternalServerError("worktree", err)
	}
	key := gitKey(ident, project)
	s.git.mu.Lock()
	defer s.git.mu.Unlock()

	pullErr := wt.PullContext(ctx, &git.PullOptions{
		RemoteName:    "origin",
		ReferenceName: plumbing.NewBranchReferenceName(cfg.Branch),
		Auth:          authMethod(cfg),
		Force:         false,
	})
	if pullErr != nil && !errors.Is(pullErr, git.NoErrAlreadyUpToDate) {
		s.git.last[key] = gitStatus{
			Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
			Changes: []gitChange{}, LastSyncUnix: time.Now().Unix(),
			LastError: "pull: " + pullErr.Error(),
		}
		return s.git.last[key], nil
	}
	changes, ahead, behind, _ := computeStatus(repo, cfg.Branch)
	out := gitStatus{
		Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
		Changes: changes, Ahead: ahead, Behind: behind,
		LastSyncUnix: time.Now().Unix(),
	}
	s.git.last[key] = out
	return out, nil
}

// gitPush auto-commits dirty changes + pushes the configured branch.
// Same failure-encoding contract as gitClone / gitPull.
func (s *Server) gitPush(ctx context.Context, ident auth.Identity, project string) (gitStatus, error) {
	dir, err := s.projectWorkingDir(ident, project)
	if err != nil {
		return gitStatus{}, huma.Error500InternalServerError("git: project dir", err)
	}
	cfg, ok := readConfig(dir)
	if !ok {
		return gitStatus{}, huma.Error400BadRequest("git not configured")
	}
	if err := s.validateRemoteURL(cfg.RemoteURL); err != nil {
		return gitStatus{}, huma.Error400BadRequest(err.Error())
	}
	repo, err := git.PlainOpen(dir)
	if err != nil {
		return gitStatus{}, huma.Error400BadRequest("no working tree (run clone first)")
	}
	key := gitKey(ident, project)
	s.git.mu.Lock()
	defer s.git.mu.Unlock()

	if err := autoCommit(repo, ident); err != nil {
		s.git.last[key] = gitStatus{
			Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
			Changes: []gitChange{}, LastSyncUnix: time.Now().Unix(),
			LastError: "commit: " + err.Error(),
		}
		return s.git.last[key], nil
	}
	pushErr := repo.PushContext(ctx, &git.PushOptions{
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
		return s.git.last[key], nil
	}
	changes, ahead, behind, _ := computeStatus(repo, cfg.Branch)
	out := gitStatus{
		Configured: true, Provider: cfg.Provider, RemoteURL: cfg.RemoteURL, Branch: cfg.Branch,
		Changes: changes, Ahead: ahead, Behind: behind,
		LastSyncUnix: time.Now().Unix(),
	}
	s.git.last[key] = out
	return out, nil
}

// mountGitAPI registers the six huma operations backing the per-project
// git surface. Helpers carry the real wiring ; these adapters pull
// auth.Identity from ctx and translate helper returns into huma
// responses.
func mountGitAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "git-status",
		Method:      "GET",
		Path:        "/api/projects/{name}/git/status",
		Summary:     "Project git sync status",
		Description: "Returns the configured remote/branch, the dirty-file list, and the last sync timestamp.",
		Tags:        []string{"git"},
	}, func(ctx context.Context, in *gitProjectInput) (*gitStatusOutput, error) {
		if s == nil {
			return &gitStatusOutput{Body: gitStatus{Configured: false, Provider: "github", Branch: "main", Changes: []gitChange{}}}, nil
		}
		ident, _ := auth.IdentityFrom(ctx)
		st, err := s.gitStatusFor(ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("git: status", err)
		}
		return &gitStatusOutput{Body: st}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "git-config",
		Method:      "POST",
		Path:        "/api/projects/{name}/git/config",
		Summary:     "Configure the project's git remote",
		Description: "Persists remote URL, branch, provider, and (optional) PAT to the project sidecar. Returns the resulting status.",
		Tags:        []string{"git"},
	}, func(ctx context.Context, in *gitConfigInput) (*gitStatusOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		st, err := s.gitConfigSet(ident, in.Project, in.Body)
		if err != nil {
			return nil, err
		}
		return &gitStatusOutput{Body: st}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "git-clone",
		Method:      "POST",
		Path:        "/api/projects/{name}/git/clone",
		Summary:     "Clone the configured remote into the project working tree",
		Description: "Wipes any existing working tree and re-clones from the remote at the requested branch. Transient git errors land in the status body rather than as HTTP errors.",
		Tags:        []string{"git"},
	}, func(ctx context.Context, in *gitConfigInput) (*gitStatusOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		st, err := s.gitClone(ctx, ident, in.Project, in.Body)
		if err != nil {
			return nil, err
		}
		return &gitStatusOutput{Body: st}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "git-pull",
		Method:      "POST",
		Path:        "/api/projects/{name}/git/pull",
		Summary:     "Pull the configured branch",
		Description: "Fast-forwards the working tree against origin. Transient errors land in the status body.",
		Tags:        []string{"git"},
	}, func(ctx context.Context, in *gitProjectInput) (*gitStatusOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		st, err := s.gitPull(ctx, ident, in.Project)
		if err != nil {
			return nil, err
		}
		return &gitStatusOutput{Body: st}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "git-push",
		Method:      "POST",
		Path:        "/api/projects/{name}/git/push",
		Summary:     "Auto-commit and push the configured branch",
		Description: "Stages every dirty + untracked file, commits with the caller's identity, then pushes to origin. Transient errors land in the status body.",
		Tags:        []string{"git"},
	}, func(ctx context.Context, in *gitProjectInput) (*gitStatusOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		st, err := s.gitPush(ctx, ident, in.Project)
		if err != nil {
			return nil, err
		}
		return &gitStatusOutput{Body: st}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "git-log",
		Method:      "GET",
		Path:        "/api/projects/{name}/git/log",
		Summary:     "Commit graph (HEAD-first)",
		Description: "Flat commit list with parent SHAs so the SPA can paint the lane graph client-side. Capped at limit (default 200, max 1000).",
		Tags:        []string{"git"},
	}, func(ctx context.Context, in *gitLogInput) (*gitLogOutput, error) {
		if s == nil {
			return &gitLogOutput{Body: gitLogResponse{Entries: []gitLogEntry{}}}, nil
		}
		ident, _ := auth.IdentityFrom(ctx)
		resp, err := s.gitLogFor(ident, in.Project, in.Limit)
		if err != nil {
			return nil, err
		}
		return &gitLogOutput{Body: resp}, nil
	})
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

// schedulePush is the debounced auto-push hook. Every file write
// (handleWriteFile / handleDeleteFile) calls this with the
// (identity, project) pair ; we reset a per-project timer that fires
// autoPushIdle seconds after the last call and runs autoCommit +
// push in a background goroutine. Errors land in
// last[key].LastError so the UI surfaces them on the next status
// refresh — they don't blow up the foreground write.
//
// No-op when the project isn't git-configured ; the write succeeds
// as a pure local-disk operation.
func (s *Server) schedulePush(ident auth.Identity, project string) {
	key := gitKey(ident, project)
	dir, err := s.projectWorkingDir(ident, project)
	if err != nil {
		return
	}
	cfg, ok := readConfig(dir)
	if !ok {
		return // unconfigured project — local-only file edits
	}

	s.git.mu.Lock()
	if t, ok := s.git.pushTimers[key]; ok {
		t.Stop()
	}
	s.git.pushTimers[key] = time.AfterFunc(autoPushIdle, func() {
		s.runAutoPush(ident, project, cfg)
	})
	s.git.mu.Unlock()
}

// runAutoPush is what the debounce timer fires : autoCommit + push
// against the cached config snapshot. Holds the gitState mutex for
// the full duration so a concurrent foreground push doesn't race
// the working tree.
func (s *Server) runAutoPush(ident auth.Identity, project string, cfg gitConfig) {
	key := gitKey(ident, project)
	dir, err := s.projectWorkingDir(ident, project)
	if err != nil {
		return
	}
	repo, err := git.PlainOpen(dir)
	if err != nil {
		return
	}
	s.git.mu.Lock()
	defer s.git.mu.Unlock()
	delete(s.git.pushTimers, key) // we're firing — drop the entry

	if err := autoCommit(repo, ident); err != nil {
		s.recordAutoErr(key, cfg, "auto-commit: "+err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := repo.PushContext(ctx, &git.PushOptions{
		RemoteName: "origin",
		RefSpecs:   []config.RefSpec{config.RefSpec(fmt.Sprintf("refs/heads/%s:refs/heads/%s", cfg.Branch, cfg.Branch))},
		Auth:       authMethod(cfg),
	}); err != nil && !errors.Is(err, git.NoErrAlreadyUpToDate) {
		s.recordAutoErr(key, cfg, "auto-push: "+err.Error())
		return
	}
	// On success record the timestamp ; the next status refresh
	// shows it as "last sync : N seconds ago".
	st := s.git.last[key]
	st.Configured = true
	st.Provider = cfg.Provider
	st.RemoteURL = cfg.RemoteURL
	st.Branch = cfg.Branch
	st.LastSyncUnix = time.Now().Unix()
	st.LastError = ""
	s.git.last[key] = st
}

// recordAutoErr stores the error on the last-status memo so the UI
// surfaces it on next /git/status. Caller holds git.mu.
func (s *Server) recordAutoErr(key string, cfg gitConfig, msg string) {
	st := s.git.last[key]
	st.Configured = true
	st.Provider = cfg.Provider
	st.RemoteURL = cfg.RemoteURL
	st.Branch = cfg.Branch
	st.LastError = msg
	s.git.last[key] = st
}
