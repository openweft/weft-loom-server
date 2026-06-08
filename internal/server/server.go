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

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/project"
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
	opts Options
	hub  *ywebsocket.Hub
	mux  *http.ServeMux
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
		opts: opts,
		hub:  ywebsocket.NewHub(),
		mux:  http.NewServeMux(),
	}
	s.routes()
	return s, nil
}

// ServeHTTP implements http.Handler. Delegates to the inner mux ;
// the auth middleware lives inside the route registrations so we
// can keep healthz unauthenticated.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	// Public.
	s.mux.HandleFunc("GET /api/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// SPA — fall-through on every other GET that isn't an API call.
	// The static FS is rooted at the dist/ directory the build
	// emits.
	if s.opts.Static != nil {
		s.mux.Handle("GET /", http.FileServer(http.FS(s.opts.Static)))
	}

	// Authed.
	s.mux.HandleFunc("GET /api/projects", s.guard(s.handleListProjects))
	s.mux.HandleFunc("GET /api/projects/{name}/files", s.guard(s.handleListFiles))
	s.mux.HandleFunc("GET /api/projects/{name}/files/{path...}", s.guard(s.handleReadFile))
	s.mux.HandleFunc("PUT /api/projects/{name}/files/{path...}", s.guard(s.handleWriteFile))
	s.mux.HandleFunc("POST /api/projects/{name}/compile", s.guard(s.handleCompileStart))
	s.mux.HandleFunc("GET /api/projects/{name}/compile/{id}", s.guard(s.handleCompileStream))
	// WS upgrade — auth handled inside the handler so we can return
	// 401 BEFORE upgrading.
	s.mux.HandleFunc("GET /api/projects/{name}/sync", s.handleSync)
}

// guard wraps a handler with auth + identity injection. Dev mode
// (Auth=nil) synthesises a fixed identity so the panel works without
// dex configured.
func (s *Server) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ident, ok := s.identify(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		r = r.WithContext(auth.WithIdentity(r.Context(), ident))
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
