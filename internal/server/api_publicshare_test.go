package server

// api_publicshare_test.go — owner-issued read-only public link tests.
//
// The handlers in api_publicshare.go are not yet wired into the main
// ServeMux (that's the integration follow-up the user owns). To keep
// the tests independent of that wiring, every test here mounts the
// 5 routes onto a throwaway ServeMux that fronts the test Server.
// This is the same pattern the file uses when handlers.go finally
// adds the registrations — we just front-load it for unit coverage.

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/project"
)

// newPublicShareTestServer builds a server + mounts the 5 public-share
// routes through ServeHTTP middleware (so identity injection still
// runs the same way it does in production). Returns the live test
// server + the backing store for seeding.
func newPublicShareTestServer(t *testing.T) (*httptest.Server, *project.LocalStore, *Server) {
	t.Helper()
	root := t.TempDir()
	store := project.NewLocalStore(root)
	s, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Projects: store,
		Compiler: compile.New(store),
		// Auth nil → dev mode, "dev-user" identity on every request.
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Wrap the server so we can intercept the public-share routes
	// without touching routes() / handlers.go. The order matters :
	// /public/* routes don't pass through requireAuth, the admin
	// routes do (s.requireAuth handles the dev-mode identity).
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/projects/{name}/public-share", s.requireAuth(s.handlePublicShareCreate))
	mux.HandleFunc("GET /api/projects/{name}/public-share", s.requireAuth(s.handlePublicShareGet))
	mux.HandleFunc("DELETE /api/projects/{name}/public-share", s.requireAuth(s.handlePublicShareDelete))
	mux.HandleFunc("GET /public/{token}/files", s.handlePublicListFiles)
	mux.HandleFunc("GET /public/{token}/files/{path...}", s.handlePublicReadFile)
	// Everything else delegates to the real Server (so the seeded
	// project shows up via /api/projects/.../files if a test wants
	// to cross-check authenticated vs public listings).
	mux.Handle("/", s)

	// ServeHTTP on Server injects the dev-mode identity ; for /public/
	// we DON'T want that, but it's harmless because the public
	// handlers don't read auth.IdentityFrom — they resolve a synthetic
	// identity from the URL token. Net result : a /public/ request
	// works whether or not identity injection ran.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/public/") {
			// Skip identity injection on the public path so we mirror
			// what a real "no bearer" request would experience.
			mux.ServeHTTP(w, r)
			return
		}
		s.injectIdentityForTest(w, r, mux)
	}))
	return srv, store, s
}

// injectIdentityForTest mirrors Server.ServeHTTP's identity setup
// without going through the inner mux — used by the test harness so
// admin routes get the dev-mode identity but the public routes
// don't.
func (s *Server) injectIdentityForTest(w http.ResponseWriter, r *http.Request, next http.Handler) {
	ident, ok := s.identify(r)
	if ok {
		r = r.WithContext(auth.WithIdentity(r.Context(), ident))
	}
	next.ServeHTTP(w, r)
}

// seedPublicProject lays down one file under "dev-user"'s namespace.
func seedPublicProject(t *testing.T, store *project.LocalStore, name, path, content string) {
	t.Helper()
	ident := auth.Identity{Subject: "dev-user"}
	if err := store.WriteFile(t.Context(), ident, name, path, strings.NewReader(content)); err != nil {
		t.Fatalf("seed %s/%s: %v", name, path, err)
	}
}

func TestPublicShare_CreateThenGet(t *testing.T) {
	srv, store, _ := newPublicShareTestServer(t)
	defer srv.Close()
	seedPublicProject(t, store, "thesis", "main.tex", "hello")

	// POST creates a fresh token + returns the share URL.
	resp, err := http.Post(srv.URL+"/api/projects/thesis/public-share", "application/json", nil)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST status = %d ; want 200 ; body = %s", resp.StatusCode, body)
	}
	var created struct {
		Token   string `json:"token"`
		URL     string `json:"url"`
		Created string `json:"created"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(created.Token) != 32 {
		t.Errorf("token len = %d ; want 32", len(created.Token))
	}
	if created.URL != "/public/"+created.Token {
		t.Errorf("url = %q ; want /public/<token>", created.URL)
	}

	// GET returns the same token.
	resp2, err := http.Get(srv.URL + "/api/projects/thesis/public-share")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d ; want 200", resp2.StatusCode)
	}
	var got struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Token != created.Token {
		t.Errorf("GET token = %q ; POST token = %q", got.Token, created.Token)
	}
}

func TestPublicShare_GetWhenNoneIs404(t *testing.T) {
	srv, store, _ := newPublicShareTestServer(t)
	defer srv.Close()
	seedPublicProject(t, store, "thesis", "main.tex", "hello")

	resp, err := http.Get(srv.URL + "/api/projects/thesis/public-share")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d ; want 404", resp.StatusCode)
	}
}

func TestPublicShare_DeleteRemoves(t *testing.T) {
	srv, store, _ := newPublicShareTestServer(t)
	defer srv.Close()
	seedPublicProject(t, store, "thesis", "main.tex", "hello")

	// Create then delete.
	resp, err := http.Post(srv.URL+"/api/projects/thesis/public-share", "application/json", nil)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	resp.Body.Close()

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/projects/thesis/public-share", nil)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE status = %d ; want 204", resp2.StatusCode)
	}

	// GET now 404.
	resp3, err := http.Get(srv.URL + "/api/projects/thesis/public-share")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusNotFound {
		t.Errorf("post-delete GET = %d ; want 404", resp3.StatusCode)
	}
}

func TestPublicShare_PublicListFilesNoAuth(t *testing.T) {
	srv, store, _ := newPublicShareTestServer(t)
	defer srv.Close()
	seedPublicProject(t, store, "thesis", "main.tex", "hello")
	seedPublicProject(t, store, "thesis", "refs/biblio.bib", "x")

	// Owner creates a share token.
	resp, err := http.Post(srv.URL+"/api/projects/thesis/public-share", "application/json", nil)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	var created struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Unauthenticated GET on /public/<token>/files returns the
	// project's file tree (minus the sidecar).
	pubResp, err := http.Get(srv.URL + "/public/" + created.Token + "/files")
	if err != nil {
		t.Fatalf("public GET: %v", err)
	}
	defer pubResp.Body.Close()
	if pubResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(pubResp.Body)
		t.Fatalf("public GET status = %d ; body = %s", pubResp.StatusCode, body)
	}
	var listing struct {
		Items []struct {
			Path string `json:"path"`
			Size int64  `json:"size"`
			Dir  bool   `json:"dir"`
		} `json:"items"`
	}
	if err := json.NewDecoder(pubResp.Body).Decode(&listing); err != nil {
		t.Fatalf("decode: %v", err)
	}
	paths := map[string]bool{}
	for _, it := range listing.Items {
		paths[it.Path] = true
	}
	for _, want := range []string{"main.tex", "refs", "refs/biblio.bib"} {
		if !paths[want] {
			t.Errorf("public listing missing %q ; got %v", want, paths)
		}
	}
	// The sidecar dir must NOT be in the listing — defence in depth
	// against surfacing the share token via a directory walk.
	if paths[".weft-loom"] || paths[".weft-loom/public-share.json"] {
		t.Errorf("sidecar leaked into public listing : %v", paths)
	}

	// Reading a file through /public/ streams the bytes.
	fileResp, err := http.Get(srv.URL + "/public/" + created.Token + "/files/main.tex")
	if err != nil {
		t.Fatalf("public file GET: %v", err)
	}
	defer fileResp.Body.Close()
	if fileResp.StatusCode != http.StatusOK {
		t.Fatalf("public file GET status = %d", fileResp.StatusCode)
	}
	body, _ := io.ReadAll(fileResp.Body)
	if string(body) != "hello" {
		t.Errorf("public file body = %q ; want %q", body, "hello")
	}
}

func TestPublicShare_UnknownTokenIs404(t *testing.T) {
	srv, _, _ := newPublicShareTestServer(t)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/public/deadbeefcafebabe0000000000000000/files")
	if err != nil {
		t.Fatalf("public GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d ; want 404", resp.StatusCode)
	}
}

func TestPublicShare_PublicPathSkipsAuth(t *testing.T) {
	// Build a Server with a strict StaticVerifier so any leaking auth
	// dependency would surface as a 401 on the public path. Bare
	// /public/ requests must still resolve via the token.
	root := t.TempDir()
	store := project.NewLocalStore(root)
	s, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Projects: store,
		Compiler: compile.New(store),
		Auth: auth.StaticVerifier{
			Token:    "secret",
			Identity: auth.Identity{Subject: "alice"},
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Seed under "alice" through the store directly.
	ident := auth.Identity{Subject: "alice"}
	if err := store.WriteFile(t.Context(), ident, "thesis", "main.tex", strings.NewReader("hello")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Drop a sidecar directly so the index picks it up on first hit.
	dir, err := s.projectWorkingDir(ident, "thesis")
	if err != nil {
		t.Fatalf("projectWorkingDir: %v", err)
	}
	if err := writePublicShare(dir, publicShareRecord{Token: "tok123456789012345678901234567890", Created: "2026-06-14T00:00:00Z"}); err != nil {
		t.Fatalf("writePublicShare: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /public/{token}/files", s.handlePublicListFiles)
	mux.HandleFunc("GET /public/{token}/files/{path...}", s.handlePublicReadFile)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// No bearer ; the public surface must still resolve.
	resp, err := http.Get(srv.URL + "/public/tok123456789012345678901234567890/files")
	if err != nil {
		t.Fatalf("public GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d ; want 200 ; body = %s", resp.StatusCode, body)
	}
}
