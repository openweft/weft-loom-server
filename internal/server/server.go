// Package server wires the HTTP surface : the SPA static handler,
// the WebSocket endpoint that drives y-websocket sync, the compile
// API, and the auth middleware.
//
// Routes :
//
//	GET  /                       SPA (CodeMirror + Yjs)
//	GET  /assets/*               SPA bundle
//	GET  /api/healthz            liveness
//	GET  /api/projects           list visible projects
//	GET  /api/projects/{name}/files  list files
//	GET  /api/projects/{name}/files/{path}  read file
//	PUT  /api/projects/{name}/files/{path}  write file (only for non-CRDT files like build output)
//	POST /api/projects/{name}/compile       start a compile job
//	GET  /api/projects/{name}/compile/{id}  stream stdout/stderr + artifacts
//	WS   /api/projects/{name}/sync          y-websocket bridge
//
// Auth : every /api/* (except healthz) requires a valid OIDC bearer
// from dex ; the middleware extracts the subject + groups and
// passes them downstream via ctx.

package server

import (
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/nats-io/nats.go"
	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/natsbroker"
	"github.com/openweft/weft-loom-server/internal/project"
	"github.com/openweft/weft-loom-server/internal/shares"
	"github.com/openweft/weft-loom-server/internal/toolshare"
	"github.com/openweft/weft-loom-server/internal/workspace"
	"github.com/openweft/weft-loom-server/internal/ywebsocket"
)

// Options bundles everything the server needs to boot.
type Options struct {
	// Logger is the slog logger. Required.
	Logger *slog.Logger
	// Static is the SPA bundle FS (typically the embedded dist/).
	Static fs.FS
	// Projects backs project file IO.
	Projects project.Store
	// Compiler orchestrates microVM compile jobs.
	Compiler *compile.Service
	// Auth validates OIDC bearers. nil = dev mode (auth disabled,
	// every request gets a synthetic identity).
	Auth auth.Verifier
}

// Server is the HTTP handler tree, built once at startup.
type Server struct {
	opts       Options
	hub        *ywebsocket.Hub
	mux        *http.ServeMux
	git        *gitState
	seedClaims *seedClaimRegistry
	ociProber  *ociProber
	events     *eventbus.Hub
	workspaces *workspace.Registry
	natsBroker *natsbroker.Embedded
	warmups    *warmupState
	toolshare  *toolshare.Manager
	shares     *shares.Publisher
}

// New wires the routes ; returns an http.Handler ready to mount on
// a net/http listener.
func New(opts Options) (*Server, error) {
	if opts.Logger == nil {
		return nil, fmt.Errorf("server: Logger required")
	}
	if opts.Projects == nil {
		return nil, fmt.Errorf("server: Projects required")
	}
	if opts.Compiler == nil {
		return nil, fmt.Errorf("server: Compiler required")
	}
	s := &Server{
		opts:       opts,
		hub:        ywebsocket.NewHub(),
		mux:        http.NewServeMux(),
		git:        newGitState(),
		seedClaims: newSeedClaimRegistry(),
		ociProber:  newOCIProber(),
		events:     eventbus.New(),
		warmups:    newWarmupState(),
		toolshare:  toolshareFromEnv(),
	}
	// Workspace provisioner : QEMU backend when the operator picks
	// it explicitly (production), in-process devagent otherwise
	// (dev mode). The QEMU backend needs an external NATS broker
	// reachable from inside the guest ; auto-starts the embedded
	// broker only for the devagent path so we don't conflict with
	// the operator's cluster broker.
	if workspace.QEMUBackendSelected() {
		// Auto-start the embedded broker too when WEFT_NATS_URL is
		// unset : the QEMU guest reaches the host via SLIRP's
		// 10.0.2.2 → 127.0.0.1, so the embedded broker on
		// 127.0.0.1:4222 IS reachable from inside the VM.
		qemuProv := workspace.NewQEMUFromEnv(opts.Logger)
		if qemuProv.NATSURL == "" && !workspace.EmbeddedNATSDisabled() {
			broker, brokerErr := natsbroker.Start(natsbroker.Options{})
			if brokerErr != nil {
				opts.Logger.Warn("embedded nats: start failed", "err", brokerErr)
			} else {
				opts.Logger.Info("embedded nats: started (for QEMU guest)", "url", broker.URL)
				// loom-server → 127.0.0.1:4222 (broker.URL).
				// guest agent → 10.0.2.2:4222 (SLIRP gateway →
				// host loopback). Distinct strings for the same
				// physical broker on this host.
				qemuProv.NATSURL = broker.URL
				qemuProv.GuestNATSURL = "nats://10.0.2.2:4222"
				s.natsBroker = broker
				// Share publisher : dials the same broker, emits
				// pod.ShareMount on weft.mounts.<vmID> for each VM
				// boot. Dev uses backend=virtio9p (observability only),
				// prod uses backend=cubefs (agent's mounts.Subscriber
				// calls cfs-client).
				if nc, ncErr := nats.Connect(broker.URL); ncErr == nil {
					s.shares = shares.New(nc)
				} else {
					opts.Logger.Warn("share publisher: nats.Connect failed", "err", ncErr)
				}
			}
		}
		s.workspaces = workspace.NewRegistry(qemuProv)
		opts.Compiler.Workspaces = &compileWorkspaceAdapter{reg: s.workspaces}
		s.routes()
		// Pre-spawn workspace VMs for known identities so the first
		// SPA shell click lands on an already-booted VM. In dev that's
		// the synthetic "dev-user" identity ; in prod the operator
		// sets WEFT_LOOM_PRESPAWN_SUBJECTS=alice,bob,... and we kick
		// off boots in parallel at server start.
		go s.prespawnWorkspaces()
		go s.ensureTools()
		return s, nil
	}
	prov := workspace.NewLocalFromEnv()
	if prov.NATSURL == "" && !workspace.EmbeddedNATSDisabled() {
		broker, brokerErr := natsbroker.Start(natsbroker.Options{})
		if brokerErr != nil {
			opts.Logger.Warn("embedded nats: start failed — workspace VM disabled", "err", brokerErr)
		} else {
			opts.Logger.Info("embedded nats: started", "url", broker.URL)
			prov.SetNATSURL(broker.URL)
			s.natsBroker = broker
			// When the broker is local + embedded, spin up the
			// in-process devagent so the shell relay round-trip
			// actually lands on a working pty — same wire as a
			// real workspace VM but without QEMU.
			prov.DevAgent = &devAgentBridge{logger: opts.Logger}
		}
	}
	s.workspaces = workspace.NewRegistry(prov)
	// Compile dispatch picks the workspace path when the resolver
	// returns a NATS-backed VM ; falls through to legacy backends
	// (microvm CLI / host subprocess) otherwise.
	opts.Compiler.Workspaces = &compileWorkspaceAdapter{reg: s.workspaces}
	s.routes()
	return s, nil
}

// ServeHTTP implements http.Handler. Delegates to the inner mux ;
// the auth middleware lives inside the route registrations so we
// can keep healthz unauthenticated.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Inject identity into ctx for every request. healthz / SPA static
	// don't read it ; everything else (huma operations + raw handlers)
	// pulls it via auth.IdentityFrom. Unauthenticated requests still
	// reach the mux ; the handlers that need an identity check via the
	// IdentityFrom ok-flag.
	if s.opts.Logger != nil {
		s.opts.Logger.Info("http", "method", r.Method, "path", r.URL.Path, "ua", r.Header.Get("User-Agent"))
	}
	ident, ok := s.identify(r)
	if ok {
		r = r.WithContext(auth.WithIdentity(r.Context(), ident))
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	// Public.
	s.mux.HandleFunc("GET /api/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// Typed API surface (list-projects, list-files, start-compile)
	// flows through huma, which registers operations on s.mux and
	// publishes the spec at /api/openapi + interactive docs at
	// /api/docs.
	mountAPI(s.mux, s)

	// Routes that don't fit huma cleanly stay raw :
	//   - binary file IO (read/write through io.Reader)
	//   - SSE compile log stream
	//   - WebSocket sync bridge
	// Auth is checked inside via auth.IdentityFrom — ServeHTTP
	// already injected the identity into ctx by the time we get here.
	s.mux.HandleFunc("GET /api/admin/oci-images", s.requireAuth(s.handleAdminOCIImages))
	s.mux.HandleFunc("GET /api/projects/{name}/files/{path...}", s.requireAuth(s.handleReadFile))
	s.mux.HandleFunc("PUT /api/projects/{name}/files/{path...}", s.requireAuth(s.handleWriteFile))
	s.mux.HandleFunc("DELETE /api/projects/{name}/files/{path...}", s.requireAuth(s.handleDeleteFile))
	// V0.3 git surface — UI-complete with stub backends ; go-git
	// wiring is the next milestone. See internal/server/api_git.go
	// for the contract the client lib/git.ts mirrors.
	s.mux.HandleFunc("GET /api/projects/{name}/git/status", s.requireAuth(s.handleGitStatus))
	s.mux.HandleFunc("POST /api/projects/{name}/git/config", s.requireAuth(s.handleGitConfig))
	s.mux.HandleFunc("POST /api/projects/{name}/git/clone", s.requireAuth(s.handleGitClone))
	s.mux.HandleFunc("POST /api/projects/{name}/git/pull", s.requireAuth(s.handleGitPull))
	s.mux.HandleFunc("POST /api/projects/{name}/git/push", s.requireAuth(s.handleGitPush))
	s.mux.HandleFunc("GET /api/projects/{name}/git/log", s.requireAuth(s.handleGitLog))
	// V0.3 LLM chat surface — stub responses for now ; full wiring
	// to Ollama / Anthropic / OpenAI lands when the backend config
	// surface is in place.
	s.mux.HandleFunc("POST /api/projects/{name}/chat", s.requireAuth(s.handleChat))
	// V0.3 web shell surface — spawns a pty (bash/sh) at the project
	// working tree and pipes it over a binary WS frame stream. The
	// xterm.js SPA panel is the terminal UI.
	s.mux.HandleFunc("GET /api/projects/{name}/shell", s.handleShell)
	// V0.3 seed-claim election : POST returns 200 if you're the
	// elected seeder for this file (do the disk read + Y.Text insert),
	// 409 if someone else already holds the claim — wait for the
	// y-websocket sync to deliver the seed instead. Replaces the
	// client-side lowest-clientID heuristic which raced when two
	// browsers connected within ~50 ms of each other.
	// {path...} wildcard must terminate the pattern (net/http ServeMux
	// constraint), so the verb segment ("seed-claim") comes BEFORE
	// the path wildcard. The handler reads the path via r.PathValue.
	s.mux.HandleFunc("POST /api/projects/{name}/seed-claim/{path...}", s.requireAuth(s.handleSeedClaim))
	// loom-doctor observability surface — SSE stream + client event
	// fan-in. The DoctorPanel in the SPA mounts the SSE here and the
	// SPA's logbus client posts to /api/events/client.
	s.mux.HandleFunc("GET /api/events", s.requireAuth(s.handleEventsStream))
	s.mux.HandleFunc("POST /api/events/client", s.requireAuth(s.handleClientEvent))
	// Workspace VM bootstrap : the in-guest init fetches this tar
	// at boot to populate /workspace with the user's project files.
	// Unauthenticated by design — the vmid is the auth (only the
	// VM bound to that id can hit it over loopback SLIRP). V0.6
	// swap to a NATS-side signature when crossing networks.
	s.mux.HandleFunc("GET /api/internal/workspace-tar/{vmid}", s.handleWorkspaceTar)
	s.mux.HandleFunc("GET /api/projects/{name}/compile/{id}", s.requireAuth(s.handleCompileStream))
	s.mux.HandleFunc("GET /api/projects/{name}/compile/{id}/artifact", s.requireAuth(s.handleCompileArtifact))
	s.mux.HandleFunc("GET /api/projects/{name}/compile/{id}/synctex", s.requireAuth(s.handleSyncTeX))
	s.mux.HandleFunc("POST /api/projects/{name}/notebook/exec", s.requireAuth(s.handleNotebookExec))
	s.mux.HandleFunc("GET /api/projects/{name}/sync", s.handleSync)
	// y-websocket appends "/{roomName}" to the configured WS URL, even
	// when the room name is empty — so the actual URL hitting us is
	// /api/projects/{name}/sync/ (trailing slash) or /sync/{room}.
	// Registering this catch-all keeps both shapes working ; the room
	// segment is informational today (we already partition by ytext key
	// inside the shared per-project Yjs doc) but a future
	// per-room handler would read it via r.PathValue("room").
	s.mux.HandleFunc("GET /api/projects/{name}/sync/{room...}", s.handleSync)

	// SPA — fall-through on every other GET. The static FS is rooted
	// at the dist/ directory the build emits.
	if s.opts.Static != nil {
		s.mux.Handle("GET /", http.FileServer(http.FS(s.opts.Static)))
	}
}

// requireAuth refuses the request when no identity was injected by
// ServeHTTP (i.e. the bearer was missing or didn't verify). Dev mode
// (Auth=nil) synthesises a "dev-user" identity in identify() so this
// guard is transparent locally.
func (s *Server) requireAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := auth.IdentityFrom(r.Context()); !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h(w, r)
	}
}

func (s *Server) identify(r *http.Request) (auth.Identity, bool) {
	if s.opts.Auth == nil {
		// Dev mode : every caller is "dev-user".
		return auth.Identity{Subject: "dev-user", Groups: []string{"dev"}}, true
	}
	bearer := bearerFromRequest(r)
	if bearer == "" {
		return auth.Identity{}, false
	}
	ident, err := s.opts.Auth.Verify(r.Context(), bearer)
	if err != nil {
		s.opts.Logger.Debug("auth verify failed", "err", err)
		return auth.Identity{}, false
	}
	return ident, true
}

func bearerFromRequest(r *http.Request) string {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) > len(prefix) && h[:len(prefix)] == prefix {
		return h[len(prefix):]
	}
	// Cookie fallback for the SPA — the OIDC callback drops the
	// id_token in a cookie named "weft-loom".
	if c, err := r.Cookie("weft-loom"); err == nil {
		return c.Value
	}
	return ""
}
